#!/usr/bin/env node
// Checks that every docs/*.md file has a matching website/src/content/docs/*.md file (and vice
// versa), and that their bodies don't diverge in substance. This repo shipped a live docs site
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
// Usage: node .github/scripts/check-docs-mirror.mjs
// Exit 0: every pair present and in sync. Exit 1: something is missing or diverged (message names
// the specific file(s) and tells the contributor to update both).

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const docsDir = join(repoRoot, 'docs');
const websiteDir = join(repoRoot, 'website', 'src', 'content', 'docs');

function listMarkdownFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md')) // .mdx (e.g. website's index.mdx) is intentionally excluded
    .sort();
}

// --- Normalization -----------------------------------------------------------------------------

function normalizeLinks(text) {
  // docs: [label](slug.md) or [label](slug.md#anchor)  ->  [label](LINK:slug) / [label](LINK:slug#anchor)
  text = text.replace(/\]\(([a-zA-Z0-9_-]+)\.md(#[a-zA-Z0-9_-]+)?\)/g, (_m, slug, anchor) => `](LINK:${slug}${anchor ?? ''})`);
  // website: [label](/slug/) or [label](/slug/#anchor)  ->  same canonical form
  text = text.replace(/\]\(\/([a-zA-Z0-9_-]+)\/(#[a-zA-Z0-9_-]+)?\)/g, (_m, slug, anchor) => `](LINK:${slug}${anchor ?? ''})`);
  return text;
}

// Blockquotes/asides get word-wrapped differently by hand in the two copies (and the aside's
// `[Label]` sometimes carries prose that's inline text in the blockquote version — see
// getting-started.md's "Prefer Python or TypeScript?" tip). Collapsing an entire blockquote/aside
// run into one space-joined line makes line-wrap position a non-issue; every other line (headers,
// list items, tables, code fences) keeps its own line so a real one-line change still reports a
// precise, readable first-divergence pointer.

function normalizeDocs(raw) {
  let lines = raw.split(/\r?\n/);
  // Strip the leading `# Title` H1 — the website mirror folds it into frontmatter `title:` instead.
  if (lines[0]?.startsWith('# ')) lines = lines.slice(1);
  const body = normalizeLinks(lines.join('\n')).split(/\r?\n/);

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
  const body = normalizeLinks(lines.join('\n')).split(/\r?\n/);

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
  const docsFiles = new Set(listMarkdownFiles(docsDir));
  const websiteFiles = new Set(listMarkdownFiles(websiteDir));

  const errors = [];

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
    const docsPath = join(docsDir, f);
    const websitePath = join(websiteDir, f);
    const docsNorm = normalizeDocs(readFileSync(docsPath, 'utf8'));
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
