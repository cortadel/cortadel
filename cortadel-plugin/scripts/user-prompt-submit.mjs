// UserPromptSubmit hook: push-recall. Searches Cortadel for memories relevant
// to the just-submitted prompt and injects them as additional context.
// Fails open: every failure path exits 0 with empty stdout so the plugin can
// never break a Claude Code session. Hook timeout is 15 s; HTTP budget 12 s.

import { cfg, readStdin, apiDetailed, emitContext, truncate, logEvent } from './lib.mjs';

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

/** Record why this prompt got no memories injected, then bail. See lib.mjs's logEvent(). */
function skip(reason, detail = {}) {
  logEvent('UserPromptSubmit', 'skip', { reason, ...detail });
}

async function main() {
  const c = cfg();
  if (!c) {
    skip(process.env.CORTADEL_HOOKS_DISABLE === '1' ? 'hooks-disabled' : 'no-config');
    return;
  }

  const input = await readStdin();
  if (!input || typeof input.prompt !== 'string') {
    skip('no-prompt');
    return;
  }

  const prompt = input.prompt;
  const trimmed = prompt.trim();
  if (trimmed.length < c.minPromptChars) {
    skip('prompt-too-short', { chars: trimmed.length, min: c.minPromptChars });
    return;
  }
  // Slash commands and shell passthrough are not memory-worthy queries.
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) {
    skip('command-prompt');
    return;
  }

  const body = {
    query: prompt.slice(0, 4000),
    user_id: c.userId,
    app_name: c.clientName,
    top_k: c.topK,
    mode: 'hybrid',
    // Omit rerank entirely for raw RRF; only send when explicitly configured
    // (GPU-reranked deployments) — CPU rerank is far too slow for this path.
    ...(c.rerank ? { rerank: c.rerank } : {}),
  };

  const started = Date.now();
  const res = await apiDetailed(c, 'POST', '/api/v1/memories/search', { body, timeoutMs: 12000 });
  const ms = Date.now() - started;
  if (!res.ok) {
    logEvent('UserPromptSubmit', 'error', { error: res.error, status: res.status, ms });
    return;
  }
  const results = Array.isArray(res.data?.results) ? res.data.results : null;
  if (!results || results.length === 0) {
    logEvent('UserPromptSubmit', 'no-results', { ms });
    return;
  }

  const lines = [];
  let belowFloor = 0;
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const content = truncate(String(r.content ?? '').replace(/\s+/g, ' ').trim(), 300);
    if (!content) continue;
    const score = typeof r.rrf_score === 'number' ? r.rrf_score : typeof r.score === 'number' ? r.score : null;
    // Relevance floor (CORTADEL_RECALL_MIN_SCORE, default 0 = keep everything).
    // Search always returns its top k, however weak the match, so without this a
    // prompt with no relevant memories still gets the k least-irrelevant ones
    // injected into every turn. An unscored result is never dropped — there is
    // nothing to compare it against.
    if (c.minScore > 0 && score !== null && score < c.minScore) {
      belowFloor++;
      continue;
    }
    const scorePart = score === null ? '' : `, score ${score.toFixed(2)}`;
    const idPart = r.id ? ` [id ${r.id}]` : '';
    lines.push(`- (${isoDate(r.created_at)}${scorePart})${idPart} ${content}`);
  }
  if (lines.length === 0) {
    logEvent('UserPromptSubmit', 'no-results', { ms, returned: results.length, belowFloor });
    return;
  }

  logEvent('UserPromptSubmit', 'injected', { injected: lines.length, returned: results.length, belowFloor, ms });
  emitContext('UserPromptSubmit', `## Relevant Cortadel memories\n${lines.join('\n')}`);
}

try {
  await main();
} catch {
  // fail open — never block the prompt
}
process.exitCode = 0;
