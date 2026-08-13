import type { SearchHit } from "@cortadel/sdk";

/**
 * Rendering helpers shared by the recall hook and the `search_memory` tool.
 *
 * Deliberately pure — given hits and a budget, produce text — so the wording of
 * an injected memory block is testable without a client, a hook input, or an
 * MCP server.
 */

/** Per-memory truncation inside a rendered block. Matches the cortadel-memory plugin. */
export const MAX_HIT_CHARS = 300;

/**
 * Date label for a hit.
 *
 * `SearchHit.createdAt` is an ISO 8601 string on this schema (list/detail use
 * Unix seconds), but numbers are accepted too so the formatter survives a
 * schema that returns them.
 */
export function isoDate(value: unknown): string {
  if (typeof value === "number") {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return "unknown";
}

/** Char-bounded truncation with a one-char ellipsis; the result is never longer than `limit`. */
export function truncate(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** Collapse every run of whitespace, so one memory occupies exactly one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A rendered memory block paired with exactly the hits it contains.
 *
 * The pairing is the point: the character budget can drop hits the caller
 * passed in, and the recall hook records what it injected in its dedupe ledger
 * — so returning the text alone would let it mark budget-dropped memories as
 * "already seen" and suppress them for the rest of the session without ever
 * having shown them.
 */
export interface FormattedHits {
  text: string;
  injected: SearchHit[];
}

/** One markdown bullet per hit, in relevance order, stopping at `budget` characters. */
export function formatHits(hits: readonly SearchHit[], budget: number): FormattedHits {
  const lines: string[] = [];
  const injected: SearchHit[] = [];
  let used = 0;

  for (const hit of hits) {
    const content = truncate(oneLine(hit.content ?? ""), MAX_HIT_CHARS);
    if (!content) continue;
    const score = typeof hit.rrfScore === "number" ? `, score ${hit.rrfScore.toFixed(2)}` : "";
    const line = `- (${isoDate(hit.createdAt)}${score}) [id ${hit.id}] ${content}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    injected.push(hit);
    used += line.length + 1;
  }

  return { text: lines.join("\n"), injected };
}
