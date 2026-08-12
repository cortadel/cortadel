// UserPromptSubmit hook: push-recall. Searches Cortadel for memories relevant
// to the just-submitted prompt and injects them as additional context.
// Fails open: every failure path exits 0 with empty stdout so the plugin can
// never break a Claude Code session. Hook timeout is 15 s; HTTP budget 12 s.

import { cfg, readStdin, api, emitContext, truncate } from './lib.mjs';

/** ISO date (YYYY-MM-DD) from created_at: Unix seconds (number) or ISO string. */
function isoDate(v) {
  try {
    const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
    if (Number.isNaN(d.getTime())) return 'unknown';
    return d.toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

async function main() {
  const c = cfg();
  if (!c) return;

  const input = await readStdin();
  if (!input || typeof input.prompt !== 'string') return;

  const prompt = input.prompt;
  const trimmed = prompt.trim();
  if (trimmed.length < c.minPromptChars) return;
  // Slash commands and shell passthrough are not memory-worthy queries.
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return;

  const body = {
    query: prompt.slice(0, 4000),
    user_id: c.userId,
    app_name: 'claude-code-hooks',
    top_k: c.topK,
    mode: 'hybrid',
    // Omit rerank entirely for raw RRF; only send when explicitly configured
    // (GPU-reranked deployments) — CPU rerank is far too slow for this path.
    ...(c.rerank ? { rerank: c.rerank } : {}),
  };

  const res = await api(c, 'POST', '/api/v1/memories/search', { body, timeoutMs: 12000 });
  const results = res && Array.isArray(res.results) ? res.results : null;
  if (!results || results.length === 0) return;

  const lines = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const content = truncate(String(r.content ?? '').replace(/\s+/g, ' ').trim(), 300);
    if (!content) continue;
    const score = typeof r.rrf_score === 'number' ? r.rrf_score : typeof r.score === 'number' ? r.score : null;
    const scorePart = score === null ? '' : `, score ${score.toFixed(2)}`;
    const idPart = r.id ? ` [id ${r.id}]` : '';
    lines.push(`- (${isoDate(r.created_at)}${scorePart})${idPart} ${content}`);
  }
  if (lines.length === 0) return;

  emitContext('UserPromptSubmit', `## Relevant Cortadel memories\n${lines.join('\n')}`);
}

try {
  await main();
} catch {
  // fail open — never block the prompt
}
process.exitCode = 0;
