/**
 * Public, self-contained types for `@cortadel/claude-agent-sdk`.
 *
 * Nothing here imports `@anthropic-ai/claude-agent-sdk`, so every module below
 * `memory.ts` stays unit-testable without the agent SDK installed, and the
 * option surface is documented in one place.
 */

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
 * The slice of `CortadelClient` this integration actually calls.
 *
 * `CortadelClient` satisfies this structurally, so the real client can be passed
 * anywhere this is accepted; tests pass a fake. Only methods that exist on the
 * published SDK surface (`add`, `addConversation`, `search`, `list`, `get`,
 * `delete`, `health`) appear here.
 */
export interface CortadelMemoryClient {
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults>;
  add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated>;
  addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
    signal?: AbortSignal,
  ): Promise<ConversationResult>;
}

/** Recorded for access logging on searches, and stamped on tool-written memories. */
export const DEFAULT_APP_NAME = "@cortadel/claude-agent-sdk";

/** MCP server key — it becomes the `mcp__cortadel__*` prefix on every tool name. */
export const DEFAULT_SERVER_NAME = "cortadel";

/**
 * Everything that tunes behaviour, shared by every constructor.
 *
 * Absent from this list, deliberately: a per-call user id. A Cortadel client is
 * bound to one user id at construction and no method takes one, so per-user
 * scoping means *one `CortadelMemory` per user*. That also matches the agent
 * SDK, whose hook inputs carry `session_id`/`cwd` but no user identity at all.
 */
export interface CortadelMemoryTuning {
  /**
   * App name recorded for access logging on searches, and set as the creating
   * app on memories written by the `add_memories` tool.
   * @defaultValue `"@cortadel/claude-agent-sdk"`
   */
  appName?: string;
  /**
   * MCP server key; sets the `mcp__<serverName>__*` tool-name prefix.
   * @defaultValue `"cortadel"`
   */
  serverName?: string;
  /**
   * Project scope for captured conversations. Defaults to the basename of the
   * session's `cwd`, which is what you usually want for a coding agent.
   */
  project?: string;
  /**
   * Tags applied to every fact extracted from a captured conversation.
   * @defaultValue `["claude-agent-sdk"]`
   */
  tags?: readonly string[];
  /**
   * Memories fetched per automatic recall, and the `search_memory` tool's
   * default when the model does not pass its own `top_k`.
   * @defaultValue `5`
   */
  topK?: number;
  /**
   * Pass `"cross_encoder"` to rerank recall hits. Left off by default — CPU
   * reranking is far too slow to sit in front of a prompt.
   */
  rerank?: string;
  /**
   * When `true`, automatic recall only returns memories from the current SDK
   * session (the hook's `session_id`). Off by default: recalling across
   * sessions is the entire point of long-term memory. No effect on the
   * `search_memory` tool, whose handler is given tool arguments and no session id.
   * @defaultValue `false`
   */
  scopeRecallToSession?: boolean;
  /**
   * Prompts shorter than this skip recall entirely.
   * @defaultValue `10`
   */
  minPromptChars?: number;
  /**
   * Ceiling on the injected memory block, in characters.
   * @defaultValue `4000`
   */
  maxContextChars?: number;
  /**
   * Ceiling on the conversation text sent to `addConversation`, in characters.
   * @defaultValue `16000`
   */
  captureMaxChars?: number;
  /**
   * Milliseconds the `UserPromptSubmit` hook may spend before giving up.
   * @defaultValue `10000`
   */
  recallTimeoutMs?: number;
  /**
   * Milliseconds the `Stop` hook may spend before giving up.
   * @defaultValue `60000`
   */
  captureTimeoutMs?: number;
  /**
   * Whether the `Stop` hook waits for `addConversation` to land before
   * returning. **Defaults to `true`**, against the usual fire-and-forget
   * default, because `Stop` fires at the end of a turn: hand the write to a
   * floating promise and `query()` can close — taking its transports and the
   * process with it — before the write completes, silently losing the turn.
   * Set it to `false` only when you keep the process alive yourself, and call
   * {@link CortadelMemory.flush} to drain what is still in flight.
   * @defaultValue `true`
   */
  awaitPersist?: boolean;
  /**
   * When true, a memory already injected in this session is not injected again,
   * so a long session does not keep re-spending context on the same facts.
   * @defaultValue `true`
   */
  dedupeInjections?: boolean;
  /**
   * Pass `true` to extract facts about the *assistant* rather than the user.
   * @defaultValue `false`
   */
  isAgentMemory?: boolean;
  /**
   * When `false` (the default) a memory failure inside a hook is swallowed and
   * the turn proceeds — a Cortadel outage must never take the agent down. Set
   * it to `true` to have the hook rethrow instead, which is what you want in
   * tests and CI. It does not change tool behaviour: a tool failure is always
   * reported to the model as an `isError` result, which surfaces it rather than
   * swallowing it. It also cannot apply to a background write
   * (`awaitPersist: false`) — there is no caller left to throw into, so those
   * failures only reach {@link CortadelMemoryTuning.onError} or the log.
   * @defaultValue `false`
   */
  throwOnError?: boolean;
  /**
   * Called with the error on every memory failure, whichever path it came from.
   * Use it for metrics or your own logging. When it is undefined and the
   * failure is swallowed, a warning goes to `console.warn` instead. A callback
   * that itself throws is caught and logged — it can never break a turn.
   */
  onError?: (error: unknown) => void;
}

/** Options for `new CortadelMemory(...)` when it should build its own Cortadel client. */
export interface CortadelMemoryOptions extends CortadelMemoryTuning {
  /** Cortadel server, e.g. `"http://localhost:3001"` or `"https://app.cortadel.ai"`. */
  baseUrl: string;
  /** The namespace anchor. Every memory read or written by this object belongs to it. */
  userId: string;
  /** Bearer token. Omit when the server runs with auth disabled. */
  apiKey?: string;
}

/**
 * Options for `new CortadelMemory(...)` when you supply the client yourself.
 *
 * `baseUrl`/`userId`/`apiKey` belong to the client you are passing, so they are
 * absent here — the client already carries them.
 */
export interface CortadelMemoryClientOptions extends CortadelMemoryTuning {
  client: CortadelMemoryClient;
}

/** Either way of constructing a `CortadelMemory`. */
export type CortadelMemoryInit = CortadelMemoryOptions | CortadelMemoryClientOptions;
