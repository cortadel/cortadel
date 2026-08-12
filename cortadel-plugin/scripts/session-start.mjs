// SessionStart hook: memory bootstrap. Announces that Cortadel memory is
// active and injects the most recent memories as session context.
// Fails open: every failure path exits 0 with empty stdout so the plugin can
// never break a Claude Code session. Hook timeout is 10 s; HTTP budget 7 s.

import { cfg, readStdin, api, emitContext, truncate } from './lib.mjs';

/** ISO date (YYYY-MM-DD) from created_at: Unix SECONDS on this endpoint. */
function isoDate(v) {
  try {
    const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
    if (Number.isNaN(d.getTime())) return 'unknown';
    return d.toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

const HEADER =
  '## Cortadel memory active\n' +
  'Relevant memories are injected automatically on each prompt. Store durable facts explicitly with the cortadel MCP tools when available.';

async function main() {
  const c = cfg();
  if (!c) return;

  const input = await readStdin();
  if (!input) return;

  const res = await api(c, 'GET', '/api/v1/memories', {
    query: { user_id: c.userId, size: 8, page: 1 },
    timeoutMs: 7000,
  });
  // Request failed → stay silent; a reachable server with zero memories still
  // gets the capability notice (it is itself useful context).
  if (!res || !Array.isArray(res.items)) return;

  const lines = [];
  for (const item of res.items) {
    if (!item || typeof item !== 'object') continue;
    const content = truncate(String(item.content ?? '').replace(/\s+/g, ' ').trim(), 300);
    if (!content) continue;
    lines.push(`- (${isoDate(item.created_at)}) ${content}`);
  }

  const block = lines.length === 0 ? HEADER : `${HEADER}\nRecent memories:\n${lines.join('\n')}`;
  emitContext('SessionStart', block);
}

try {
  await main();
} catch {
  // fail open — never block session start
}
process.exitCode = 0;
