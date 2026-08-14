#!/usr/bin/env node
// Checks that every docs/**/*.md file has a matching website/src/content/docs/**/*.md file (and
// vice versa), and that their bodies don't diverge in substance. This repo shipped a live docs site
// teaching a removed API because only one copy of a page was updated — twice — so this exists to
// catch that class of drift on every PR, not just ones that happen to touch website/**.
//
// The two trees are NOT byte-identical by design (see CONTRIBUTING.md's "Docs — update both
// copies"): the website copy adds Starlight frontmatter (folds the leading `# H1` into a
// `title:` field), converts `> ` blockquotes into `:::note` / `:::tip[...]` asides, and rewrites
// same-repo links from relative `foo.md` to root-relative `/foo/`. This script normalizes away
// exactly those three known, intentional transforms and then requires the remaining text to be
// identical — so it still catches real content drift (a changed sentence, a removed section, a
// stale API reference) without crying wolf over the mechanical differences every page has.
//
// Both trees are walked RECURSIVELY and paired on the path relative to each root, so
// docs/integrations/langgraph.md pairs with website/src/content/docs/integrations/langgraph.md.
// A flat readdir would have silently skipped every subdirectory page, which is worse than having
// no gate at all: the drift this script exists to catch would sail through unreported.
//
// Usage: node .github/scripts/check-docs-mirror.mjs
// Exit 0: every pair present and in sync. Exit 1: something is missing or diverged (message names
// the specific file(s) and tells the contributor to update both).

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const docsDir = join(repoRoot, 'docs');
const websiteDir = join(repoRoot, 'website', 'src', 'content', 'docs');

// The one file that legitimately exists on the website side with no docs/ counterpart: Starlight's
// splash landing page. It is exempt because of what it IS (a site-only hero page), not because of
// its extension — see listMarkdownFiles() for why that distinction now matters.
const WEBSITE_ONLY_EXEMPT = new Set(['index.mdx']);

// Walks `dir` recursively and returns POSIX-style paths relative to it ('integrations/langgraph.md'),
// so the same key identifies a page in either tree regardless of host OS path separators.
//
// `.mdx` is reported separately rather than silently dropped. The old flat filter kept only `.md`,
// which read as "mdx is excluded" but really meant "the website's index.mdx is excluded" — the only
// .mdx that existed. Once directories are in play that shortcut stops being safe: a
// website/src/content/docs/integrations/index.mdx would be a real, published page (Starlight routes
// it to /integrations/) that the filter would drop without a word. So the exemption is now by name
// (WEBSITE_ONLY_EXEMPT), and any other .mdx is surfaced as an error asking for an explicit decision.
function listMarkdownFiles(dir) {
  const md = [];
  const mdx = [];
  const walk = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, abs).split(sep).join('/');
      if (rel.endsWith('.mdx')) mdx.push(rel);
      else if (rel.endsWith('.md')) md.push(rel);
    }
  };
  walk(dir);
  md.sort();
  mdx.sort();
  return { md, mdx };
}

// --- Normalization -----------------------------------------------------------------------------

// Same-repo page links are written differently in each tree, and for a nested page the difference
// is more than cosmetic — it's a change of base:
//
//   docs/ is read on GitHub, where a link is resolved relative to the FILE it appears in.
//     docs/integrations.md              -> [x](integrations/langgraph.md)
//     docs/integrations/langgraph.md    -> [x](../mcp.md)        (up one level)
//     docs/integrations/langgraph.md    -> [x](crewai.md)        (sibling in the same directory)
//
//   website/ is read on the built Starlight site, where every link is root-relative. Verified by
//   building the site: src/content/docs/integrations/langgraph.md is emitted at
//   /integrations/langgraph/index.html, i.e. the route is exactly the content path minus the
//   extension. The same build also showed Astro does NOT rewrite relative markdown links — a
//   `[x](crewai.md)` in a website page renders verbatim as href="crewai.md" and 404s — which is
//   why the website side below only ever canonicalizes the /root/relative/ form. A leftover .md
//   link in the website tree is a broken link, so it SHOULD fail this check rather than be quietly
//   normalized into agreement with its docs counterpart.
//
// So the canonical token both sides fold into is the target's path relative to the docs root,
// extension stripped:
//     docs side:    resolve the relative link against the linking file's own directory
//     website side: strip the leading '/' and the trailing '/'
//   -> [x](LINK:integrations/langgraph) / [x](LINK:mcp), optionally + '#anchor'
//
// For a top-level page the linking directory is '', so `mcp.md` resolves to `mcp` and matches
// `/mcp/` exactly as it did before this file learned about directories.

const DOCS_MD_LINK = /\]\(([^)\s]+?)\.md(#[^)\s]*)?\)/g;
const WEBSITE_ROOT_LINK = /\]\(\/([^)\s#]+)\/(#[^)\s]*)?\)/g;

function normalizeDocsLinks(text, relPath) {
  const fromDir = posix.dirname(relPath); // '.' for a top-level page
  return text.replace(DOCS_MD_LINK, (match, target, anchor) => {
    // Leave anything that isn't a repo-relative path alone: absolute URLs (https://…/spec.md),
    // mailto:, and root-absolute paths are not this transform's business.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('/')) return match;
    const resolved = posix.normalize(posix.join(fromDir === '.' ? '' : fromDir, target));
    // A link that escapes the docs root (../../CONTRIBUTING.md) has no website route to fold into,
    // so leave it literal — both trees then compare it byte-for-byte, which is the pre-existing
    // behaviour for such links and still catches drift in them.
    if (resolved === '..' || resolved.startsWith('../')) return match;
    return `](LINK:${resolved}${anchor ?? ''})`;
  });
}

function normalizeWebsiteLinks(text) {
  return text.replace(WEBSITE_ROOT_LINK, (_m, path, anchor) => `](LINK:${path}${anchor ?? ''})`);
}

// Blockquotes/asides get word-wrapped differently by hand in the two copies (and the aside's
// `[Label]` sometimes carries prose that's inline text in the blockquote version — see
// getting-started.md's "Prefer Python or TypeScript?" tip). Collapsing an entire blockquote/aside
// run into one space-joined line makes line-wrap position a non-issue; every other line (headers,
// list items, tables, code fences) keeps its own line so a real one-line change still reports a
// precise, readable first-divergence pointer.

function normalizeDocs(raw, relPath) {
  let lines = raw.split(/\r?\n/);
  // Strip the leading `# Title` H1 — the website mirror folds it into frontmatter `title:` instead.
  if (lines[0]?.startsWith('# ')) lines = lines.slice(1);
  const body = normalizeDocsLinks(lines.join('\n'), relPath).split(/\r?\n/);

  const out = [];
  let quoteRun = [];
  const flushQuote = () => {
    if (quoteRun.length) out.push(quoteRun.join(' ').replace(/\s+/g, ' ').trim());
    quoteRun = [];
  };
  for (const raw of body) {
    const line = raw.trim();
    if (line.startsWith('> ') || line === '>') {
      quoteRun.push(line === '>' ? '' : line.slice(2).trim());
      continue;
    }
    flushQuote();
    if (line !== '') out.push(line);
  }
  flushQuote();
  return out.join('\n');
}

function normalizeWebsite(raw) {
  let lines = raw.split(/\r?\n/);
  // Strip the leading frontmatter block (--- ... ---).
  if (lines[0]?.trim() === '---') {
    const closeIdx = lines.indexOf('---', 1);
    if (closeIdx !== -1) lines = lines.slice(closeIdx + 1);
  }
  const body = normalizeWebsiteLinks(lines.join('\n')).split(/\r?\n/);

  const out = [];
  let inAside = false;
  let asideRun = [];
  const flushAside = () => {
    if (asideRun.length) out.push(asideRun.join(' ').replace(/\s+/g, ' ').trim());
    asideRun = [];
  };
  for (const raw of body) {
    const line = raw.trim();
    const openMatch = /^:::[a-zA-Z]*(?:\[([^\]]*)\])?\s*$/.exec(line);
    if (!inAside && openMatch) {
      inAside = true;
      if (openMatch[1]) asideRun.push(openMatch[1]); // the aside's [Label] can carry real prose
      continue;
    }
    if (inAside && line === ':::') {
      inAside = false;
      flushAside();
      continue;
    }
    if (inAside) {
      asideRun.push(line);
      continue;
    }
    if (line !== '') out.push(line);
  }
  flushAside();
  return out.join('\n');
}

// --- Diff summary (first divergent line, for a readable failure message) -----------------------

function firstDivergence(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, docs: la[i] ?? '(missing)', website: lb[i] ?? '(missing)' };
    }
  }
  return null;
}

// --- Main ----------------------------------------------------------------------------------------

function main() {
  const docsListing = listMarkdownFiles(docsDir);
  const websiteListing = listMarkdownFiles(websiteDir);
  const docsFiles = new Set(docsListing.md);
  const websiteFiles = new Set(websiteListing.md);

  const errors = [];

  for (const f of docsListing.mdx) {
    errors.push(
      `docs/${f} is .mdx. The root docs/ tree is plain GitHub-rendered Markdown — rename it to ` +
        `docs/${f.replace(/\.mdx$/, '.md')} (and mirror it) so this check can compare it.`,
    );
  }
  for (const f of websiteListing.mdx) {
    if (WEBSITE_ONLY_EXEMPT.has(f)) continue;
    errors.push(
      `website/src/content/docs/${f} is an unmirrored .mdx page. Starlight publishes it, but this ` +
        `check can't pair it with a docs/ page. Either make it .md with a docs/ counterpart, or add ` +
        `it to WEBSITE_ONLY_EXEMPT in this script with a comment saying why it is site-only.`,
    );
  }

  for (const f of docsFiles) {
    if (!websiteFiles.has(f)) {
      errors.push(
        `docs/${f} has no counterpart at website/src/content/docs/${f}. ` +
          `Add the Starlight mirror (frontmatter + same content) or remove docs/${f}.`,
      );
    }
  }
  for (const f of websiteFiles) {
    if (!docsFiles.has(f)) {
      errors.push(
        `website/src/content/docs/${f} has no counterpart at docs/${f}. ` +
          `Every website doc page must mirror a root docs/ page — add docs/${f} or remove the website copy.`,
      );
    }
  }

  for (const f of docsFiles) {
    if (!websiteFiles.has(f)) continue; // already reported above
    const docsPath = join(docsDir, ...f.split('/'));
    const websitePath = join(websiteDir, ...f.split('/'));
    const docsNorm = normalizeDocs(readFileSync(docsPath, 'utf8'), f);
    const websiteNorm = normalizeWebsite(readFileSync(websitePath, 'utf8'));
    if (docsNorm !== websiteNorm) {
      const div = firstDivergence(docsNorm, websiteNorm);
      errors.push(
        `docs/${f} and website/src/content/docs/${f} have diverged beyond frontmatter/aside/link-format ` +
          `differences. Update BOTH copies in the same commit (see CONTRIBUTING.md#docs).\n` +
          (div
            ? `    first difference (normalized line ${div.line}):\n` +
              `      docs:    ${JSON.stringify(div.docs)}\n` +
              `      website: ${JSON.stringify(div.website)}`
            : ''),
      );
    }
  }

  if (errors.length > 0) {
    console.error('docs/website mirror parity check failed:\n');
    for (const e of errors) console.error(`- ${e}\n`);
    process.exit(1);
  }

  console.log(`docs/website mirror parity OK (${docsFiles.size} page(s) checked).`);
}

main();
