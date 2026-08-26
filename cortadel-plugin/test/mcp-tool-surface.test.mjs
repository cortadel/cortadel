// The shipped skills are INSTRUCTIONS the model follows. A skill naming a tool the server does not
// expose does not fail loudly — the model simply tries to call it and improvises when it is not
// there. That is what happened to the `reconcile` skill: the server folded six MCP tools into two
// on 2026-08-21 (see McpSurfaceTests in the server repo, which pins the surface), the public plugin
// never got the memo, and the skill went on telling the model to call three tools that no longer
// existed. Nothing in this repo noticed, because nothing in this repo asserted the tool surface.
//
// This does. It is deliberately a whitelist, not a blacklist of the six removed names: a whitelist
// also catches the NEXT tool someone invents in prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');

/** The server's entire MCP surface. Mirrors McpSurfaceTests: exactly these two, nothing else. */
const MCP_TOOLS = new Set(['add_memories', 'search_memory']);

/** Tools that USED to exist and must never reappear as MCP calls. Kept for a precise message. */
const FOLDED = {
  add_conversation: 'pass "role: content" turns inside add_memories',
  add_media: 'pass an image URL / data-URI / base64 inside add_memories',
  get_skill: 'use search_memory — primary_skill, or ids: ["skill:<id>"] to expand',
  reconcile_memories: 'REST only: POST /api/v1/entities/reconcile (scripts/reconcile.mjs)',
  reconcile_status: 'REST only: GET /api/v1/entities/reconcile/status (scripts/reconcile.mjs)',
  list_merge_suggestions: 'REST only: GET /api/v1/entities/suggestions (scripts/reconcile.mjs)',
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (entry.endsWith('.md')) out.push(abs);
  }
  return out;
}

test('no shipped skill invokes an MCP tool the server does not expose', () => {
  const offenders = [];

  for (const file of walk(SKILLS_DIR)) {
    const rel = file.slice(PLUGIN_ROOT.length + 1).replace(/\\/g, '/');
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const [, tool] of line.matchAll(/mcp__cortadel__([a-z_]+)/g)) {
          if (MCP_TOOLS.has(tool)) continue;
          const hint = FOLDED[tool] ? ` — ${FOLDED[tool]}` : ' — not an MCP tool';
          offenders.push(`${rel}:${i + 1} calls mcp__cortadel__${tool}${hint}`);
        }
      });
  }

  assert.deepEqual(
    offenders,
    [],
    `shipped skills reference non-existent MCP tools:\n  ${offenders.join('\n  ')}\n\n` +
      `The MCP surface is exactly: ${[...MCP_TOOLS].join(', ')}.`
  );
});

test('the folded tool names are not presented as MCP tools anywhere in the plugin', () => {
  const offenders = [];
  const files = [...walk(SKILLS_DIR), join(PLUGIN_ROOT, 'README.md')];

  for (const file of files) {
    const rel = file.slice(PLUGIN_ROOT.length + 1).replace(/\\/g, '/');
    // Two kinds of legitimate mention must NOT trip this:
    //   1. Naming a folded tool to say it is gone (reconcile/SKILL.md does exactly that).
    //   2. `cortadel.add_conversation(...)` — an SDK METHOD backed by a real REST endpoint
    //      (POST /api/v1/memories/from-conversation). The name is shared; the surface is not.
    // So only a BARE `tool_name(` counts, never one preceded by a dot or word character.
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const tool of Object.keys(FOLDED)) {
          if (new RegExp(`(?<![.\\w])${tool}\\s*\\(`).test(line) || line.includes(`mcp__cortadel__${tool}`)) {
            offenders.push(`${rel}:${i + 1} presents ${tool} as callable — ${FOLDED[tool]}`);
          }
        }
      });
  }

  assert.deepEqual(offenders, [], `folded tools presented as callable:\n  ${offenders.join('\n  ')}`);
});
