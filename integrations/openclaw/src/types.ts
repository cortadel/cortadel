/**
 * Public, self-contained types for `@cortadel/openclaw`.
 *
 * Nothing here imports from `openclaw` or `@cortadel/sdk`, so the emitted
 * declaration file stays free of peer-dependency type references and the whole
 * module graph below `index.ts` is unit-testable without either package.
 */

import type {
  AddOptions,
  ChatMessage,
  ConversationOptions,
  ConversationResult,
  MemoryCreated,
  MemoryDetail,
  SearchOptions,
  SearchResults,
} from "@cortadel/sdk";

/**
 * The slice of `CortadelClient` this integration actually uses.
 *
 * `CortadelClient` satisfies this structurally, so the real client can be passed
 * anywhere this is accepted; tests pass a fake. Only methods that exist on the
 * published SDK surface (`add`, `add_conversation`, `search`, `list`, `get`,
 * `delete`, `health`) appear here.
 */
export interface CortadelMemoryClient {
  add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated>;
  addConversation(messages: ChatMessage[], options?: ConversationOptions, signal?: AbortSignal): Promise<ConversationResult>;
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults>;
  get(memoryId: string, signal?: AbortSignal): Promise<MemoryDetail | null>;
}

/**
 * How wide a memory namespace one OpenClaw turn recalls from — and writes to.
 *
 * Four scopes, not a boolean, because a Cortadel client is bound to one user id
 * at construction: choosing a scope *is* choosing the user id for the turn.
 *
 * - `fixed` — every turn shares the configured `userId`. The only scope where
 *   memory carries across agents and conversations.
 * - `agent` — `userId:<agentId>`; each agent recalls only its own memories.
 * - `session` — `userId:<sessionKey>`; each conversation fully isolated.
 * - `sender` — `userId:<senderId>`; each human in a shared chat isolated.
 */
export type CortadelRecallScope = "fixed" | "agent" | "session" | "sender";

/** Circuit-breaker tuning. */
export interface CortadelCircuitBreakerConfig {
  /** Consecutive failures before memory calls are skipped. */
  maxFailures?: number;
  /** How long to keep skipping once the breaker opens, in milliseconds. */
  cooldownMs?: number;
}

/** Raw plugin config, exactly as it appears under `plugins.entries.cortadel.config`. */
export interface CortadelOpenClawConfig {
  baseUrl?: string;
  apiKey?: string;
  userId?: string;
  appName?: string;
  recallScope?: CortadelRecallScope;
  autoRecall?: boolean;
  autoCapture?: boolean;
  corpusSupplement?: boolean;
  promptSupplement?: boolean;
  topK?: number;
  minScore?: number;
  rerank?: boolean;
  timeoutMs?: number;
  dedupeWindow?: number;
  minPromptChars?: number;
  circuitBreaker?: CortadelCircuitBreakerConfig;
  tags?: string[];
  project?: string;
}

/** Plugin config after defaults, env fallbacks, and clamping have been applied. */
export interface ResolvedCortadelConfig {
  baseUrl: string;
  apiKey?: string;
  userId: string;
  appName: string;
  recallScope: CortadelRecallScope;
  autoRecall: boolean;
  autoCapture: boolean;
  corpusSupplement: boolean;
  promptSupplement: boolean;
  topK: number;
  minScore: number;
  rerank: boolean;
  timeoutMs: number;
  dedupeWindow: number;
  minPromptChars: number;
  circuitBreaker: { maxFailures: number; cooldownMs: number };
  tags?: string[];
  project?: string;
}

/**
 * The identity fields this integration reads off an OpenClaw hook context.
 *
 * Mirrors the subset of `PluginHookAgentContext` we depend on, so scope
 * resolution can be tested without constructing a real OpenClaw context.
 */
export interface TurnIdentity {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  senderId?: string;
}

/** Minimal logger shape, structurally satisfied by OpenClaw's `PluginLogger`. */
export interface CortadelLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** The name Cortadel registers itself under inside OpenClaw's memory corpus list. */
export const CORTADEL_CORPUS = "cortadel";

/** URI scheme used for the `path` of a Cortadel corpus hit, and parsed back by `get`. */
export const CORTADEL_PATH_PREFIX = "cortadel://";
