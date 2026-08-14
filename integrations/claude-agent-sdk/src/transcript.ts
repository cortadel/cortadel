/**
 * Pulls the last user→assistant exchange out of a Claude Agent SDK session transcript.
 *
 * The `Stop` hook input carries `session_id`, `cwd`, `transcript_path` and
 * `last_assistant_message`, but no user message — `StopHookInput` in
 * `@anthropic-ai/claude-agent-sdk/sdk.d.ts` is `BaseHookInput & { hook_event_name,
 * stop_hook_active, last_assistant_message?, background_tasks?, session_crons? }`
 * — so the turn we want to persist has to be read back off the transcript.
 *
 * Two readers, in order:
 *
 * 1. `getSessionMessages(sessionId, { dir })` — the SDK's own public reader. Its
 *    doc comment: "Parses the transcript, builds the conversation chain via
 *    parentUuid links, and returns user/assistant messages in chronological
 *    order", which is exactly the work we would otherwise reimplement. It is
 *    imported *dynamically* and read defensively, so an older `0.3.x` without it
 *    degrades to the fallback instead of failing at module load.
 * 2. The raw JSONL at `transcript_path` — the file the hook itself named, so
 *    there is no session lookup to get wrong. Used when the SDK reader is
 *    unavailable or comes back empty (non-UUID session id, a transcript outside
 *    `~/.claude/projects/`, a session held in a remote `SessionStore`, …).
 *
 * Everything here is deliberately total: an unreadable, truncated or malformed
 * transcript yields `undefined` rather than throwing, because the only caller is
 * a hook that must never break a session.
 */

import { readFile } from "node:fs/promises";

/**
 * One side of an exchange: the text plus the transcript uuid that produced it.
 *
 * `uuid` feeds `ChatMessage.uuid`, which Cortadel keeps as a pointer anchor on
 * every fact it extracts — that is what lets a stored memory be traced back to
 * the exact turn.
 */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  uuid?: string;
}

/** The last complete user→assistant pair of a session. */
export interface Exchange {
  user: Turn;
  assistant: Turn;
}

/** A transcript entry normalised across both readers. */
export interface TranscriptEntry {
  type: string;
  message: unknown;
  uuid?: string;
  /** False for a machine-authored user turn (a task notification, say). */
  isHuman: boolean;
}

/** The two readers, injectable so each can be driven independently in tests. */
export interface TranscriptReaders {
  sdk: (sessionId: string, cwd?: string) => Promise<TranscriptEntry[]>;
  jsonl: (transcriptPath?: string) => Promise<TranscriptEntry[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Plain text of a transcript message.
 *
 * `message` is the raw Anthropic API message; its `content` is either a plain
 * string (user turns) or a list of blocks. Only `text` blocks count —
 * `tool_use`/`tool_result`/`thinking` blocks are noise for a memory extractor.
 */
export function textOf(message: unknown): string {
  if (typeof message === "string") return message.trim();
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function uuidOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Entries from the SDK's own session reader.
 *
 * Its filtering already guarantees every entry is a visible user/assistant
 * message, so all of them count as human-authored. Imported through a dynamic
 * `import()` so this module — and therefore the whole package — still loads if
 * the installed SDK predates `getSessionMessages`.
 */
export async function readViaSdk(sessionId: string, cwd?: string): Promise<TranscriptEntry[]> {
  if (!sessionId) return [];
  const sdk: Record<string, unknown> = await import("@anthropic-ai/claude-agent-sdk");
  const getSessionMessages = sdk.getSessionMessages;
  if (typeof getSessionMessages !== "function") return [];
  const messages = (await getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined)) as unknown;
  if (!Array.isArray(messages)) return [];
  return messages.filter(isRecord).map((message) => ({
    // `message` is only known to be a record, so `type` is `unknown`: coerce with a
    // type guard rather than `String()`, which would turn a non-string into a
    // stringified object that no downstream comparison could ever match.
    type: typeof message.type === "string" ? message.type : "",
    message: message.message,
    uuid: uuidOf(message.uuid),
    isHuman: true,
  }));
}

/**
 * Entries parsed straight out of the transcript JSONL, tolerating malformed lines.
 *
 * Applies the same visibility filter the SDK reader applies (`isMeta`/
 * `isSidechain`) and additionally records whether the entry is human-authored:
 * a user entry carrying an `origin.kind` other than `"human"` is a machine turn.
 * Entries with no `origin` at all count as human — older transcripts do not
 * carry the field.
 */
export async function readJsonl(transcriptPath?: string): Promise<TranscriptEntry[]> {
  if (!transcriptPath) return [];
  const raw = await readFile(transcriptPath, "utf8");

  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip it, keep the rest of the transcript
    }
    if (!isRecord(parsed)) continue;
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    if (parsed.isMeta === true || parsed.isSidechain === true) continue;
    const originKind = isRecord(parsed.origin) ? parsed.origin.kind : undefined;
    entries.push({
      type: parsed.type,
      message: parsed.message,
      uuid: uuidOf(parsed.uuid),
      isHuman: originKind === undefined || originKind === "human",
    });
  }
  return entries;
}

/**
 * The last assistant turn with text, plus the last user turn with text before it.
 *
 * Prefers a human user turn; falls back to the most recent machine-authored one
 * only when the exchange has no human turn at all (which is what an
 * agent-to-agent session looks like).
 */
export function pair(entries: readonly TranscriptEntry[]): Exchange | undefined {
  let assistantIndex = -1;
  let assistant: Turn | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "assistant") continue;
    const text = textOf(entry.message);
    if (text) {
      assistantIndex = index;
      assistant = { role: "assistant", text, uuid: entry.uuid };
      break;
    }
  }
  if (!assistant) return undefined;

  let user: Turn | undefined;
  let fallback: Turn | undefined;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "user") continue;
    const text = textOf(entry.message);
    if (!text) continue;
    const turn: Turn = { role: "user", text, uuid: entry.uuid };
    if (entry.isHuman) {
      user = turn;
      break;
    }
    fallback ??= turn;
  }

  const resolved = user ?? fallback;
  return resolved ? { user: resolved, assistant } : undefined;
}

/** Where a transcript lives, as the `Stop` hook input describes it. */
export interface TranscriptLocation {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
}

const DEFAULT_READERS: TranscriptReaders = { sdk: readViaSdk, jsonl: readJsonl };

/**
 * The last user→assistant exchange of a session, or `undefined` if there isn't one.
 *
 * Never throws: an unreadable transcript, a missing session file or a malformed
 * JSONL all come back as `undefined`.
 */
export async function lastExchange(
  location: TranscriptLocation,
  readers: TranscriptReaders = DEFAULT_READERS,
): Promise<Exchange | undefined> {
  // Thunks, not results: the fallback must not touch the filesystem when the
  // SDK reader already produced a usable exchange.
  const attempts = [
    () => readers.sdk(location.sessionId, location.cwd),
    () => readers.jsonl(location.transcriptPath),
  ];

  for (const attempt of attempts) {
    let entries: TranscriptEntry[] = [];
    try {
      entries = await attempt();
    } catch {
      continue; // a transcript reader must never break the session
    }
    if (entries.length === 0) continue;
    const exchange = pair(entries);
    if (exchange) return exchange;
  }
  return undefined;
}
