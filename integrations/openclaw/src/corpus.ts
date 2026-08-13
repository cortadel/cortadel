import type { MemoryDetail, SearchHit } from "@cortadel/sdk";
import type { CortadelGateway } from "./gateway.js";
import { CORTADEL_CORPUS, CORTADEL_PATH_PREFIX } from "./types.js";

/**
 * Cortadel as an **additive** OpenClaw memory corpus.
 *
 * This is the most idiomatic seam OpenClaw offers for an external long-term
 * store. `api.registerMemoryCorpusSupplement(...)` plugs a `search`/`get` pair
 * in behind OpenClaw's *own* `memory_search` and `memory_get` tools, so the
 * agent reaches Cortadel through the memory interface it already knows, with no
 * new tool to learn.
 *
 * The deliberate choice here is *supplement*, not *capability*.
 * `api.registerMemoryCapability(...)` is an exclusive slot: taking it replaces
 * OpenClaw's built-in memory backend outright and can only be selected via
 * `plugins.slots.memory`. Cortadel is a remote graph of distilled facts, not a
 * replacement for OpenClaw's local workspace-file memory — the two are
 * complementary, so Cortadel registers as a non-exclusive supplement and
 * composes with `memory-core` (and with any other memory plugin) instead of
 * displacing it.
 */

/** Structural mirror of `MemoryCorpusSearchResult` from `openclaw/plugin-sdk/memory-core`. */
export interface CorpusSearchResult {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
}

/** Structural mirror of `MemoryCorpusGetResult` from `openclaw/plugin-sdk/memory-core`. */
export interface CorpusGetResult {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
}

/** Structural mirror of `MemoryCorpusSupplement`. */
export interface CorpusSupplement {
  search(params: { query: string; maxResults?: number; agentSessionKey?: string }): Promise<CorpusSearchResult[]>;
  get(params: { lookup: string; fromLine?: number; lineCount?: number; agentSessionKey?: string }): Promise<CorpusGetResult | null>;
}

const MAX_SNIPPET_CHARS = 600;
const MAX_TITLE_CHARS = 80;

/** Stable, round-trippable address for a Cortadel memory inside OpenClaw's corpus list. */
export function memoryPath(memoryId: string): string {
  return `${CORTADEL_PATH_PREFIX}${memoryId}`;
}

/**
 * Recover a memory id from whatever the agent passed to `memory_get`.
 *
 * Accepts the `cortadel://<id>` path we emit from `search`, and a bare id for
 * when the model shortcuts to the `id` field instead of the `path`.
 */
export function parseLookup(lookup: string): string | undefined {
  const trimmed = lookup.trim();
  if (trimmed.length === 0) return undefined;
  const id = trimmed.startsWith(CORTADEL_PATH_PREFIX) ? trimmed.slice(CORTADEL_PATH_PREFIX.length).trim() : trimmed;
  return id.length > 0 ? id : undefined;
}

function firstLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Map one Cortadel search hit onto an OpenClaw corpus row. */
export function toCorpusSearchResult(hit: SearchHit): CorpusSearchResult {
  const result: CorpusSearchResult = {
    corpus: CORTADEL_CORPUS,
    path: memoryPath(hit.id),
    id: hit.id,
    // A hit that somehow arrived without a fused score still ranks, just last.
    score: hit.rrfScore ?? 0,
    snippet: firstLine(hit.content, MAX_SNIPPET_CHARS),
    title: hit.gist?.trim() || firstLine(hit.content, MAX_TITLE_CHARS),
    provenanceLabel: hit.isGlobal ? "Cortadel (shared)" : "Cortadel",
    sourceType: CORTADEL_CORPUS,
  };
  if (hit.memoryType) result.kind = hit.memoryType;
  if (hit.appName) result.sourcePath = hit.appName;
  // `SearchHit.createdAt` is already an ISO 8601 string on this schema.
  if (hit.createdAt) result.updatedAt = hit.createdAt;
  return result;
}

/**
 * Map a Cortadel memory onto an OpenClaw corpus read, honouring line paging.
 *
 * Two field traps from the Cortadel contract are handled here: the detail
 * schema's text lives on `text` (not `content`, which is what the list and
 * search schemas use), and its `createdAt` is **Unix seconds**, where
 * `SearchHit.createdAt` is an ISO string.
 */
export function toCorpusGetResult(detail: MemoryDetail, fromLine?: number, lineCount?: number): CorpusGetResult {
  const lines = detail.text.split("\n");
  const start = Math.max(1, Math.trunc(fromLine ?? 1));
  const startIndex = Math.min(start - 1, lines.length);
  const count = lineCount === undefined ? lines.length - startIndex : Math.max(0, Math.trunc(lineCount));
  const slice = lines.slice(startIndex, startIndex + count);

  const result: CorpusGetResult = {
    corpus: CORTADEL_CORPUS,
    path: memoryPath(detail.id),
    id: detail.id,
    content: slice.join("\n"),
    fromLine: start,
    lineCount: slice.length,
    title: firstLine(detail.text, MAX_TITLE_CHARS),
    provenanceLabel: detail.isGlobal ? "Cortadel (shared)" : "Cortadel",
    sourceType: CORTADEL_CORPUS,
  };
  if (detail.appName) result.sourcePath = detail.appName;
  if (Number.isFinite(detail.createdAt)) {
    // Unix seconds on this schema — multiply before constructing the Date.
    result.updatedAt = new Date(detail.createdAt * 1000).toISOString();
  }
  return result;
}

/**
 * Build the supplement OpenClaw registers.
 *
 * Both methods swallow failures: they are called from inside OpenClaw's own
 * memory tools, and a Cortadel outage should degrade `memory_search` to its
 * local results rather than fail the tool call.
 */
export function createCorpusSupplement(gateway: CortadelGateway): CorpusSupplement {
  return {
    async search({ query, maxResults, agentSessionKey }) {
      const trimmed = query?.trim();
      if (!trimmed) return [];

      const userId = gateway.userIdFor({ sessionKey: agentSessionKey });
      const topK = Math.min(50, Math.max(1, Math.trunc(maxResults ?? gateway.config.topK)));
      const outcome = await gateway.call(userId, "corpus search", (client, signal) =>
        // No `sessionId`: a corpus lookup should reach every past conversation.
        client.search(trimmed, { topK, mode: "hybrid", ...(gateway.config.rerank ? { rerank: "cross_encoder" } : {}) }, signal),
      );
      if (!outcome.ok) return [];
      return outcome.value.results.map(toCorpusSearchResult);
    },

    async get({ lookup, fromLine, lineCount, agentSessionKey }) {
      const memoryId = parseLookup(lookup ?? "");
      if (!memoryId) return null;

      const userId = gateway.userIdFor({ sessionKey: agentSessionKey });
      const outcome = await gateway.call(userId, "corpus get", (client, signal) => client.get(memoryId, signal));
      // `get` resolves to null for an unknown id rather than throwing.
      if (!outcome.ok || outcome.value === null) return null;
      return toCorpusGetResult(outcome.value, fromLine, lineCount);
    },
  };
}
