#!/usr/bin/env node
// Entity reconciliation driver for the `reconcile` skill.
//
// Why this is a script rather than MCP tool calls in the skill's prose: reconciliation used to be
// exposed as three MCP tools (reconcile_memories, reconcile_status, list_merge_suggestions). They
// were folded on 2026-08-21 — the server's MCP surface is now exactly two tools (add_memories,
// search_memory), enforced by McpSurfaceTests. Reconciliation survives only as REST, on
// EntitiesController. The skill therefore cannot call it as a tool, and a skill's own shell cannot
// see the CLAUDE_PLUGIN_OPTION_* env vars, so it needs a script that resolves the installed config
// the way doctor.mjs does.
//
// Usage:
//   node scripts/reconcile.mjs run [--scope <all|entities>] [--dry-run]
//   node scripts/reconcile.mjs status
//   node scripts/reconcile.mjs suggestions [--status pending|approved|rejected]
//   node scripts/reconcile.mjs approve <suggestionId>
//   node scripts/reconcile.mjs reject  <suggestionId>
//   node scripts/reconcile.mjs cancel
//
// Prints JSON on success so the model can read the result directly. Exits non-zero on failure with
// a human-readable reason on stderr. Never prints the API key.

import { apiDetailed } from './lib.mjs';
import { resolveApiConfig } from './plugin-config.mjs';

const USAGE = `usage: reconcile.mjs <run|status|suggestions|approve|reject|cancel> [options]

  run [--dry-run]                 start reconciliation      POST   /api/v1/entities/reconcile
  status                          poll the current run      GET    /api/v1/entities/reconcile/status
  cancel                          stop the current run      DELETE /api/v1/entities/reconcile
  suggestions [--status <s>]      list merge suggestions    GET    /api/v1/entities/suggestions
  approve <suggestionId>          apply one merge           POST   /api/v1/entities/suggestions/<id>/approve
  reject  <suggestionId>          dismiss one               POST   /api/v1/entities/suggestions/<id>/reject`;

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const [, , command, ...rest] = process.argv;
if (!command || command === '--help' || command === '-h') fail(USAGE, command ? 0 : 1);

// Tiny arg split: --name [value] pairs into `flags`, everything else into `positional`.
const flags = new Map();
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) {
    positional.push(a);
    continue;
  }
  const next = rest[i + 1];
  if (next !== undefined && !next.startsWith('--')) {
    flags.set(a.slice(2), next);
    i++;
  } else {
    flags.set(a.slice(2), true);
  }
}
const flag = (name) => flags.get(name);

const { config, missing } = resolveApiConfig();
if (!config) {
  fail(
    `Cortadel plugin is not configured — missing: ${missing.join(', ')}.\n` +
      'Run /plugin, configure cortadel-memory, or set CORTADEL_URL / CORTADEL_USER_ID / CORTADEL_API_KEY.'
  );
}

// Reconciliation is a long server-side sweep; give it far more room than the 10s default.
const LONG = { timeoutMs: 120000 };

async function main() {
  switch (command) {
    case 'run': {
      const body = { user_id: config.userId };
      if (flag('dry-run') !== undefined) body.dry_run = true;
      return apiDetailed(config, 'POST', '/api/v1/entities/reconcile', { body, ...LONG });
    }
    case 'status':
      return apiDetailed(config, 'GET', '/api/v1/entities/reconcile/status', {
        query: { user_id: config.userId },
      });
    case 'cancel':
      return apiDetailed(config, 'DELETE', '/api/v1/entities/reconcile', {
        query: { user_id: config.userId },
      });
    case 'suggestions':
      return apiDetailed(config, 'GET', '/api/v1/entities/suggestions', {
        query: { user_id: config.userId, status: flag('status') ?? 'pending' },
      });
    case 'approve':
    case 'reject': {
      const id = positional[0];
      if (!id) fail(`${command} needs a suggestion id.\n\n${USAGE}`);
      return apiDetailed(config, 'POST', `/api/v1/entities/suggestions/${encodeURIComponent(id)}/${command}`, {
        body: { user_id: config.userId },
      });
    }
    default:
      return fail(`unknown command "${command}".\n\n${USAGE}`);
  }
}

const res = await main();
if (!res.ok) {
  fail(`${command} failed — HTTP ${res.status ?? '?'}${res.error ? `: ${res.error}` : ''}`);
}
console.log(JSON.stringify(res.data ?? {}, null, 2));
