// The facade's own types. Mirrors sdk/dotnet/Cortadel.Sdk/Models.cs property-for-property, in
// TypeScript naming (camelCase members) — the mapping layer (src/mapping.ts) does the
// snake_case/camelCase and per-schema wire-name conversion. Every field here is derived from
// spec/openapi.json; Models.cs was consulted only to confirm which fields the facade exposes.
//
// Deliberately generated-free: nothing in this file imports from ./generated. That is what makes
// this module safe to re-export wholesale from src/index.ts — its declaration output can never
// reference a generated type. Mapping functions that DO need the generated model shapes live in
// src/mapping.ts instead (see that file for why it's a separate module).

// ── Client configuration ────────────────────────────────────────────────

/**
 * Configuration for a {@link CortadelClient}.
 */
export interface CortadelOptions {
  /** Base URL of the Cortadel server, e.g. "http://localhost:3001". */
  baseUrl: string;

  /**
   * User identifier sent on every request. Required by the REST API — omitting it is a 400.
   *
   * It is the namespace anchor ONLY on an auth-disabled server. When an `apiKey` is present the
   * server is authoritative: a `user_id` in a request body is silently overwritten with the key's
   * user, and one in a query string is rejected with 403. So pass the id the key was minted for.
   */
  userId: string;

  /** Optional API key. Sent as `Authorization: Bearer <key>`. Omit when the server runs with auth disabled. */
  apiKey?: string;

  /** App name recorded for access logging on searches. Defaults to "cortadel-typescript". */
  appName?: string;

  /**
   * `fetch` implementation to use for every request. Defaults to the global `fetch`.
   *
   * Never mutated: the client wraps this reference in its own request handling instead of
   * attaching headers or other state to it, so the same `fetch` (or one already bound to your
   * own defaults) can safely be shared across multiple `CortadelClient`s or other callers.
   */
  fetch?: typeof fetch;

  /**
   * Per-request timeout in milliseconds. Defaults to 100_000 (100 seconds). Composed with any
   * `signal` you pass to an individual call — whichever fires first wins. Set to 0 to disable.
   */
  timeoutMs?: number;
}

/** Deliberate divergence from the contract's own `size` default of 10 (spec/openapi.json), kept in
 * sync with the .NET facade's `ListOptions.Size = 20` default so every SDK agrees. */
export const DEFAULT_LIST_SIZE = 20;

// ── Requests & options ──────────────────────────────────────────────────

/** A single conversation turn passed to {@link CortadelClient.addConversation}. */
export interface ChatMessage {
  /** "user", "assistant", or "system". */
  role: string;
  /** Message text. */
  content: string;
  /** Optional producer-side turn id (kept as a pointer anchor on extracted facts). */
  uuid?: string;
}

/** Options for {@link CortadelClient.add}. */
export interface AddOptions {
  /** App name that created the memory. */
  app?: string;
  /** Arbitrary metadata stored alongside the memory. */
  metadata?: Record<string, unknown>;
  /** When `false`, store the text verbatim and skip background entity/category extraction (dedup still applies). Default `true`. */
  infer?: boolean;
  /** Optional cognitive-type pin: `episodic` | `semantic` | `procedural`. Invalid values are ignored (auto-classified). */
  memoryType?: string;
}

/** Options for {@link CortadelClient.addConversation}. */
export interface ConversationOptions {
  /** When `true`, extract facts about the assistant instead of the user. */
  isAgentMemory?: boolean;
  /** Tags applied to every extracted fact (for scoped retrieval). */
  tags?: string[];
  /** Optional project scope (e.g. a repo name). */
  project?: string;
  /** Optional session id grouping the extracted facts. */
  sessionId?: string;
  /** Optional producer-local transcript path (stored as a pointer anchor). */
  transcriptPath?: string;
}

/** Options for {@link CortadelClient.search}. */
export interface SearchOptions {
  /** Maximum number of results (1-50). Default 10. */
  topK?: number;
  /** Search mode: `hybrid` (default), `text`, or `vector`. */
  mode?: string;
  /** Restrict results to a session. */
  sessionId?: string;
  /** Set to `cross_encoder` to rerank with the local cross-encoder; omit to skip. */
  rerank?: string;
  /** Filter by cognitive type: `episodic` | `semantic` | `procedural`. */
  memoryType?: string;
}

/** Options for {@link CortadelClient.list}. */
export interface ListOptions {
  /** Page number (1-based). Default 1. */
  page?: number;
  /** Page size (max 100). Default {@link DEFAULT_LIST_SIZE} (20) — see that constant's doc comment. */
  size?: number;
  /** Filter by app id. */
  appId?: string;
  /** Comma-separated category names to filter by. */
  categories?: string;
  /** When set, runs a hybrid search instead of a plain list. */
  searchQuery?: string;
  /** Include superseded (older) versions of memories. */
  includeSuperseded?: boolean;
  /** Filter by cognitive type. */
  memoryType?: string;
}

// ── Responses ────────────────────────────────────────────────────────────

/** Result of storing a memory. */
export interface MemoryCreated {
  id: string;
  content?: string | null;
  state?: string | null;
  /** ISO 8601 creation timestamp (this endpoint returns a string; list/detail return Unix seconds). */
  createdAt?: string | null;
  /** What happened, e.g. `ADD` or `SKIP_DUPLICATE`. */
  event?: string | null;
  appName?: string | null;
  /** Metadata as a JSON string (not a nested object, unlike {@link MemoryDetail.metadata}). */
  metadata?: string | null;
}

/** A page of search hits. */
export interface SearchResults {
  query: string;
  results: SearchHit[];
  total: number;
}

/** A single ranked search hit. */
export interface SearchHit {
  id: string;
  content: string;
  /** Fused relevance score (RRF, sqrt-normalized). Wire: `rrf_score`. */
  rrfScore?: number | null;
  /** Wire: `created_at` (ISO 8601 string on this schema — list/detail return Unix seconds instead). */
  createdAt?: string | null;
  appName?: string | null;
  categories?: string[] | null;
  memoryType?: string | null;
  tags?: string[] | null;
  /** `personal` or `global` — where the hit came from. */
  source?: string | null;
  /**
   * `true` when this hit is a globally-shared memory owned by another user.
   *
   * Wire name is `global` on this schema — `MemoryListItem`/`MemoryDetail` use `is_global`
   * instead. That asymmetry caused a real bug in the .NET leg; see src/mapping.ts's `mapSearchHit`
   * for where it's handled here.
   */
  isGlobal: boolean;
  /** One-line distilled gist of the memory, when the server computed one. */
  gist?: string | null;
  projectId?: string | null;
  /** Member memory ids folded into this hit (session-arm rollups). Wire: `member_ids`. */
  memberIds?: string[] | null;
  /** Ids of similar/duplicate memories, when computed. Wire: `similar_ids`. */
  similarIds?: string[] | null;
  /** Rank within the text (BM25) arm before fusion, if this hit matched it. Wire: `text_rank`. */
  textRank?: number | null;
  /** Rank within the vector arm before fusion, if this hit matched it. Wire: `vector_rank`. */
  vectorRank?: number | null;
  /** Freeform attributes attached to this hit (e.g. confidence_band, anchors). */
  attributes?: Record<string, unknown> | null;
}

/** A paginated list of memories. */
export interface MemoryList {
  items: MemoryListItem[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

/** A memory in a list response. */
export interface MemoryListItem {
  id: string;
  content: string;
  /** Creation time as Unix seconds. */
  createdAt: number;
  state: string;
  appId?: string | null;
  appName?: string | null;
  categories: string[];
  memoryType?: string | null;
  /** Extraction pipeline status: `done`, `pending`, or `failed`. */
  extractionStatus?: string | null;
  /** ISO 8601 timestamp from which this memory version is valid. */
  validAt?: string | null;
  /** ISO 8601 timestamp at which this memory was invalidated/superseded. */
  invalidAt?: string | null;
  /** Whether this is the current (non-superseded) version of the memory. */
  isCurrent?: boolean | null;
  /** `true` when this is a globally-shared memory owned by another user. Wire: `is_global`. */
  isGlobal: boolean;
  metadata?: unknown;
}

/** A single memory (from {@link CortadelClient.get}). Note the content field is `text`. */
export interface MemoryDetail {
  id: string;
  text: string;
  /** Creation time as Unix seconds. */
  createdAt: number;
  state: string;
  appId?: string | null;
  appName?: string | null;
  categories: string[];
  metadata?: unknown;
  validAt?: string | null;
  invalidAt?: string | null;
  isCurrent?: boolean | null;
  supersededBy?: string | null;
  /** `true` when this is a globally-shared memory owned by another user. Wire: `is_global`. */
  isGlobal: boolean;
}

/** One fact distilled from a conversation and stored. */
export interface ConversationIngestItem {
  /** Id of the stored memory. Empty when the underlying pipeline event carries no id (e.g. `ERROR`, `INVALIDATE`). */
  id?: string | null;
  /** The distilled fact text. */
  memory?: string | null;
  /** What the store pipeline did, e.g. `ADD`, `SKIP_DUPLICATE`, or `ERROR`. */
  event?: string | null;
  /** Failure detail when `event` is `ERROR` (or another failed branch); absent otherwise. Wire: `error`. */
  error?: string | null;
}

/**
 * Result of ingesting a conversation. The two members are mutually exclusive on the wire: the
 * server sends `results` when it distilled facts, or `noFactsExtracted` when it didn't — never both.
 */
export interface ConversationResult {
  /** One entry per distilled fact. Absent when nothing was extracted. */
  results?: ConversationIngestItem[] | null;
  /** True when the conversation yielded no storable facts; absent otherwise. Wire: `no_facts_extracted`. */
  noFactsExtracted?: boolean | null;
}

/** Server health snapshot. */
export interface HealthResult {
  /** Overall status: `ok` when every check passed, `degraded` otherwise. */
  status: string;
  /** Wire: `checked_at`. */
  checkedAt?: string | null;
  /** Per-dependency check details, keyed by dependency name (`memgraph`, `embeddings`, `indexes` today). */
  checks?: Record<string, unknown> | null;
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * Thrown when the Cortadel server returns a non-success response.
 *
 * Never thrown for cancellation: an aborted request (via an `AbortSignal`) propagates its
 * `AbortError`/`TimeoutError` untouched instead of becoming a `CortadelError` — see
 * src/client.ts's `translateError`.
 */
export class CortadelError extends Error {
  /** HTTP status code returned by the server. 0 when the transport failed before a status was known. */
  readonly status: number;
  /** Machine-readable error code (e.g. `not_found`, `validation_error`). */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CortadelError";
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, CortadelError.prototype);
  }
}
