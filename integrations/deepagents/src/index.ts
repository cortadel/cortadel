/**
 * Cortadel long-term memory for DeepAgents (TypeScript).
 *
 * Cortadel is self-hosted long-term temporal graph memory for AI agents — a bi-temporal graph store
 * with hybrid BM25 + vector search. This package plugs it into
 * [`deepagents`](https://github.com/langchain-ai/deepagentsjs) two ways:
 *
 * - {@link createCortadelMemoryMiddleware} — the automatic half. An `AgentMiddleware` for
 *   `createDeepAgent({ middleware: [...] })` that recalls relevant memories before the turn and
 *   persists the turn afterwards.
 * - {@link createCortadelTools} — the explicit half. `search_memory` and `add_memories` as
 *   LangChain-native tools the agent can call itself.
 *
 * ```ts
 * import { createDeepAgent } from "deepagents";
 * import { createCortadelMemoryMiddleware } from "@cortadel/deepagents";
 *
 * const agent = createDeepAgent({
 *   model: "anthropic:claude-sonnet-4-5",
 *   middleware: [
 *     createCortadelMemoryMiddleware({
 *       baseUrl: "http://localhost:3001",
 *       userId: "e2e-demo-user",
 *     }),
 *   ],
 * });
 * ```
 */

export {
  ClientProvider,
  DEFAULT_APP_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_USER_ID_KEY,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_USER_ID,
  resolveThreadId,
  resolveUserId,
  toRunScope,
  type CortadelConnectionOptions,
  type CortadelMemoryClient,
  type RunScope,
} from "./client.js";

export { describeError, notifyError, type OnErrorCallback } from "./errors.js";

export {
  CORTADEL_SYSTEM_PROMPT,
  EMPTY_MEMORY_PLACEHOLDER,
  MEMORY_SLOT,
  formatSearchResults,
  hitToRecalled,
  recalledMemorySchema,
  renderMemories,
  type RecalledMemory,
} from "./format.js";

export { latestUserText, messageText, messageType, toChatMessages } from "./messages.js";

export {
  ADD_MEMORIES_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
  addMemoriesSchema,
  createCortadelTools,
  searchMemorySchema,
  type CortadelErrorOptions,
  type CortadelSearchOptions,
  type CortadelToolsOptions,
} from "./tools.js";

export {
  cortadelMemoryStateSchema,
  createCortadelMemoryMiddleware,
  type CortadelMemoryMiddlewareOptions,
  type CortadelMemoryState,
} from "./middleware.js";
