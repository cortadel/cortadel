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
//   node scripts/reconcile.mjs run [--limit N] [--types PERSON,ORG]
//   node scripts/reconcile.mjs status
//   node scripts/reconcile.mjs suggestions [--status pending|approved|rejected]
//   node scripts/reconcile.mjs approve <suggestionId> --winner <entityId>
//   node scripts/reconcile.mjs reject  <suggestionId> --note "why they are not the same"
//   node scripts/reconcile.mjs cancel
//
// Prints JSON on success so the model can read the result directly. Exits non-zero on failure with
// a human-readable reason on stderr. Never prints the API key.

import { apiDetailed } from './lib.mjs';
import { resolveApiConfig } from './plugin-config.mjs';

const USAGE = `usage: reconcile.mjs <run|status|suggestions|approve|reject|cancel> [options]

  run [--limit N] [--types A,B]   start reconciliation      POST   /api/v1/entities/reconcile
  status                          poll the current run      GET    /api/v1/entities/reconcile/status
  cancel                          stop the current run      DELETE /api/v1/entities/reconcile
  suggestions [--status <s>]      list merge suggestions    GET    /api/v1/entities/suggestions
  approve <id> --winner <entity>  apply one merge           POST   /api/v1/entities/suggestions/<id>/approve
  reject  <id> --note "<reason>"  dismiss one               POST   /api/v1/entities/suggestions/<id>/reject

  --winner is REQUIRED on approve and must be one of the suggestion's two entities.
  --note   is REQUIRED on reject: the server rejects an empty reason with 400, because the
           note is the corpus the feature exists to collect.`;

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
      // ReconcileRequest(UserId, Types?, Limit?) — there is no dry-run field on this endpoint.
      const body = { user_id: config.userId };
      const limit = flag('limit');
      if (limit !== undefined && limit !== true) body.limit = Number(limit);
      const types = flag('types');
      if (types !== undefined && types !== true) {
        body.types = String(types)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }
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
    case 'approve': {
      // ApproveSuggestionRequest(UserId, WinnerId) — winner_id is required, and the server 400s
      // unless it names one of the suggestion's two entities.
      const id = positional[0];
      if (!id) fail(`approve needs a suggestion id.\n\n${USAGE}`);
      const winner = flag('winner');
      if (!winner || winner === true) {
        fail('approve needs --winner <entityId> — the entity to KEEP, which must be one of the pair.');
      }
      return apiDetailed(config, 'POST', `/api/v1/entities/suggestions/${encodeURIComponent(id)}/approve`, {
        body: { user_id: config.userId, winner_id: String(winner) },
      });
    }
    case 'reject': {
      // RejectSuggestionRequest(UserId, Note) — an empty note is a 400 by design: the note is the
      // corpus this feature exists to collect.
      const id = positional[0];
      if (!id) fail(`reject needs a suggestion id.\n\n${USAGE}`);
      const note = flag('note');
      if (!note || note === true) {
        fail('reject needs --note "<reason>" — the server requires a reason for every rejection.');
      }
      return apiDetailed(config, 'POST', `/api/v1/entities/suggestions/${encodeURIComponent(id)}/reject`, {
        body: { user_id: config.userId, note: String(note) },
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
