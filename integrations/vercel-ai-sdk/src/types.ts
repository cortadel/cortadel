import type { LanguageModelMiddleware } from "ai";
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
 * The AI SDK's language-model call shapes, derived structurally from the one public middleware
 * type `ai` exports rather than imported from `@ai-sdk/provider`.
 *
 * `ai@7` re-exports `LanguageModelMiddleware` (a `LanguageModelV4Middleware` with a relaxed
 * `specificationVersion`) but does *not* re-export `LanguageModelV4CallOptions` and friends. Naming
 * those directly would mean adding `@ai-sdk/provider` as a second dependency and pinning ourselves
 * to the `V4` spelling — which has already been renamed twice (V2 → V3 → V4). Deriving them keeps
 * this package correct across spec bumps as long as `wrapLanguageModel` keeps its shape.
 */
type TransformParamsOptions = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0];

/** The standardized parameters of a single language-model call. */
export type LanguageModelCallOptions = TransformParamsOptions["params"];

/** The standardized prompt: an ordered array of system/user/assistant/tool messages. */
export type LanguageModelPrompt = LanguageModelCallOptions["prompt"];

/** One message in the standardized prompt. */
export type LanguageModelMessage = LanguageModelPrompt[number];

/** The result of a non-streaming model call. */
export type LanguageModelGenerateResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>
>;

/** The result of a streaming model call. */
export type LanguageModelStreamResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
>;

/** One part of a model stream. */
export type LanguageModelStreamPart = LanguageModelStreamResult["stream"] extends ReadableStream<
  infer PART
>
  ? PART
  : never;

/**
 * The slice of `CortadelClient` this package actually calls.
 *
 * A real `CortadelClient` from `@cortadel/sdk` satisfies this structurally, so you can pass one
 * straight in. Declaring the narrow shape instead of the concrete class is what lets the tests run
 * fully offline against a fake, and lets you wrap the client with your own retry/telemetry layer.
 */
export interface CortadelMemoryClient {
  add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated>;
  addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
    signal?: AbortSignal,
  ): Promise<ConversationResult>;
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults>;
}

/**
 * How to reach Cortadel.
 *
 * Either hand over a client you built yourself, or give the connection details and let this package
 * build (and cache) one client per user id. A Cortadel client is bound to a single user id at
 * construction — there is no per-call user parameter — so per-user scoping always means one client
 * per user.
 */
export interface CortadelConnectionOptions {
  /**
   * A pre-built client, e.g. `new CortadelClient({ baseUrl, userId })`.
   *
   * Mutually exclusive with `baseUrl`. Because a client carries its own user id and does not expose
   * it, supplying one pins the integration to that single user: per-request `userId` overrides are
   * ignored. Use `baseUrl` instead if you need multi-tenant behaviour.
   */
  client?: CortadelMemoryClient;

  /** Base URL of the Cortadel server, e.g. `https://app.cortadel.ai` or `http://localhost:3001`. */
  baseUrl?: string;

  /**
   * Default user id that owns the memories. With `baseUrl`, a per-request
   * `providerOptions.cortadel.userId` overrides this.
   */
  userId?: string;

  /** Sent as `Authorization: Bearer <key>`. Omit when the server runs with auth disabled. */
  apiKey?: string;

  /**
   * App name recorded for access logging on searches. Defaults to `"cortadel-vercel-ai-provider"`,
   * this package's own npm name.
   */
  appName?: string;

  /** Per-request timeout in milliseconds, passed through to the SDK. `0` disables it. */
  timeoutMs?: number;

  /** Custom `fetch`, passed through to the SDK. Never mutated. */
  fetch?: typeof fetch;

  /**
   * Maximum number of per-user clients to keep alive when using `baseUrl`. Least-recently-created
   * entries are evicted. Defaults to `64`.
   */
  clientCacheSize?: number;
}

/** Context handed to {@link CortadelMemoryOptions.onError}. */
export interface CortadelErrorContext {
  /** Which half of the middleware failed. */
  phase: "recall" | "persist";
  /** The user id whose memories were being read or written. */
  userId: string;
}

/** Context handed to a custom {@link CortadelMemoryOptions.formatMemories}. */
export interface FormatMemoriesContext {
  /** The query the memories were retrieved with (the latest user message). */
  query: string;
  /** The user id the memories belong to. */
  userId: string;
}

/** The SDK's search hit, re-exported: it appears in this package's `formatMemories` signature. */
export type { SearchHit } from "@cortadel/sdk";
