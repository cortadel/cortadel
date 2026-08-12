// Stop hook: async auto-capture. Sends the session's last user/assistant
// exchange to Cortadel via POST /api/v1/memories/from-conversation so the
// extractor can distill durable facts. Fails open: every path exits 0 and
// NEVER writes to stdout. Hook timeout is 120 s (async); HTTP budget 110 s.

import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { cfg, readStdin, api, truncate } from './lib.mjs';

/**
 * Extract the plain text of a transcript entry. `.message.content` is either
 * a plain string (user turns) or an array of blocks — only `text` blocks
 * count; `tool_use`/`tool_result` are ignored.
 */
function textOf(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * A user entry is a real human prompt unless it is system-injected context
 * (`isMeta`) or carries a non-human origin (e.g. `origin.kind` of
 * "task-notification"). Entries without an `origin` field count as human —
 * synthetic/older transcripts don't carry it.
 */
function isHumanUser(entry) {
  if (entry?.isMeta) return false;
  const kind = entry?.origin?.kind;
  if (kind !== undefined && kind !== 'human') return false;
  return true;
}

/** The entry's turn uuid, or undefined when absent/non-string (fail soft). */
function uuidOf(entry) {
  return typeof entry?.uuid === 'string' && entry.uuid ? entry.uuid : undefined;
}

async function main() {
  const c = cfg();
  if (!c) return;

  const input = await readStdin();
  if (!input) return;

  // Recursion guard: we are being invoked because a Stop hook already ran.
  if (input.stop_hook_active) return;

  const transcriptPath = input.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') return;

  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return;
  }

  // Parse JSONL line-by-line, tolerating malformed lines.
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && (e.type === 'user' || e.type === 'assistant')) entries.push(e);
    } catch {
      // malformed line — skip
    }
  }

  // Last assistant entry with non-empty text …
  let assistantIdx = -1;
  let assistantText = '';
  let assistantUuid;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const t = textOf(entries[i]);
    if (t) {
      assistantIdx = i;
      assistantText = t;
      assistantUuid = uuidOf(entries[i]);
      break;
    }
  }
  if (assistantIdx < 0) return;

  // … and the last user entry with non-empty text BEFORE it. Prefer the last
  // HUMAN turn; only if no human text-bearing turn exists fall back to the
  // last non-human one (isMeta / task-notification etc.).
  let userText = '';
  let userUuid;
  let fallbackText = '';
  let fallbackUuid;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (entries[i].type !== 'user') continue;
    const t = textOf(entries[i]);
    if (!t) continue;
    if (isHumanUser(entries[i])) {
      userText = t;
      userUuid = uuidOf(entries[i]);
      break;
    }
    if (!fallbackText) {
      fallbackText = t;
      fallbackUuid = uuidOf(entries[i]);
    }
  }
  if (!userText) {
    userText = fallbackText;
    userUuid = fallbackUuid;
  }
  if (!userText) return;

  const user = truncate(userText, 4000);
  const assistant = truncate(assistantText, Math.max(0, c.captureMaxChars - 4000));

  // Skip trivial/tool-only exchanges.
  if (!user || !assistant || user.length + assistant.length < 80) return;

  const body = {
    user_id: c.userId,
    messages: [
      { role: 'user', content: user, ...(userUuid ? { uuid: userUuid } : {}) },
      { role: 'assistant', content: assistant, ...(assistantUuid ? { uuid: assistantUuid } : {}) },
    ],
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.cwd ? { project: basename(String(input.cwd)) } : {}),
    transcript_path: transcriptPath,
    tags: ['claude-code'],
  };

  // Ignore the response entirely — {"no_facts_extracted":true} is normal.
  await api(c, 'POST', '/api/v1/memories/from-conversation', {
    body,
    timeoutMs: 110000,
  });
}

try {
  await main();
} catch {
  // fail open — never block or break the session
}
process.exitCode = 0;
