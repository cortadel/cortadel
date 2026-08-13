import type {
  AddOptions,
  ChatMessage,
  ConversationOptions,
  ConversationResult,
  MemoryCreated,
  SearchOptions,
  SearchResults,
} from "@cortadel/sdk";

/**
 * The exact slice of `CortadelClient` (`@cortadel/sdk`) this package calls.
 *
 * Declared structurally so tests — and anyone wrapping the SDK with retries,
 * caching or metrics — can supply a stand-in without a live server. A real
 * `CortadelClient` satisfies this interface as-is.
 */
export interface CortadelClientLike {
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults>;
  add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated>;
  addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
    signal?: AbortSignal,
  ): Promise<ConversationResult>;
}

/**
 * The Mastra-side identity of the current call, as seen by a processor or a
 * tool's `execute`.
 *
 * Mastra's `resourceId` is the closest thing it has to "who this is" and
 * `threadId` is the conversation. Cortadel binds a client to one `userId` at
 * construction, so `resourceId` is what maps onto it.
 */
export interface CortadelScope {
  /** Mastra `resourceId` — the end user / entity the run belongs to. */
  resourceId?: string;
  /** Mastra `threadId` — the conversation. Mapped to Cortadel's `sessionId`. */
  threadId?: string;
  /** The live Mastra `RequestContext`, when one is available. */
  requestContext?: RequestContextLike;
}

/** Minimal structural view of Mastra's `RequestContext` (only `get` is used). */
export interface RequestContextLike {
  get(key: string): unknown;
}

/** Where a failure happened, for `onError`. */
export interface CortadelErrorContext {
  operation: "recall" | "persist" | "search-tool" | "add-tool" | "resolve-user-id";
  userId?: string;
  threadId?: string;
}

/** Connection + identity options shared by the processor and the tools. */
export interface CortadelConnectionOptions {
  /**
   * Cortadel server base URL. Defaults to `$CORTADEL_BASE_URL`, then
   * `http://localhost:3001`.
   */
  baseUrl?: string;
  /**
   * Bearer token. Defaults to `$CORTADEL_API_KEY`. Omit when the server runs
   * with auth disabled (the self-hosted default).
   */
  apiKey?: string;
  /** App name recorded on searches and stamped on stored memories. Default `"cortadel-mastra"`. */
  appName?: string;
  /** Per-request timeout handed to the Cortadel SDK. Default `100_000`; `0` disables. */
  timeoutMs?: number;
  /**
   * Pin every call to one Cortadel user id. Use for single-user apps and
   * scripts. Takes precedence over `resourceId`.
   */
  userId?: string;
  /**
   * Derive the Cortadel user id from the current Mastra scope. Highest
   * precedence — return `undefined` to fall through to `userId`/`resourceId`.
   */
  resolveUserId?: (scope: CortadelScope) => string | undefined | null;
  /**
   * Build the Cortadel client for a user id. Defaults to a real
   * `CortadelClient`. Override in tests or to wrap the SDK.
   */
  createClient?: (userId: string) => CortadelClientLike;
  /**
   * Called whenever a Cortadel call fails, with the error and where it
   * happened. Always a callback — never a mode string. Defaults to a
   * `console.warn`; a callback replaces that warning.
   */
  onError?: (error: unknown, context: CortadelErrorContext) => void;
  /**
   * Propagate memory failures to the caller instead of degrading to no-memory.
   * Default `false` — a memory outage must never take the agent down.
   *
   * When `true`, every failure this package reports through {@link onError} is
   * rethrown afterwards: a failed recall or an awaited persist throws out of the
   * processor, and the tools throw instead of returning their `error` field.
   * Fire-and-forget persists (`awaitPersist: false`) have no caller left to
   * throw to, so there it stays an `onError` call.
   *
   * Retrying the turn after a thrown persist is safe and is the point: a write
   * that failed does not leave the turn marked as already-persisted, so the
   * retry is written rather than skipped as a duplicate.
   */
  throwOnError?: boolean;
}
