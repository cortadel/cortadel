/**
 * Cortadel long-term memory for LangGraph.
 *
 * Cortadel is self-hosted long-term temporal graph memory for AI agents — a bi-temporal graph
 * store with hybrid BM25 + vector search. This package plugs it into LangGraph three ways:
 *
 * - {@link CortadelStore} implements LangGraph's `BaseStore`, the framework's own long-term memory
 *   interface, so `compile({ store })` / `createReactAgent({ store })` / `getStore()` and a tool's
 *   `config.store` all just work.
 * - {@link createMemoryTools} exposes `search_memory` and `add_memories` as LangChain tools the
 *   agent can call itself.
 * - {@link CortadelMemory} gives automatic memory — recall before the model call, persist after the
 *   turn — with no tool call required.
 *
 * @example
 * ```ts
 * import { CortadelStore, namespaceUserId } from "@cortadel/langgraph";
 *
 * const store = new CortadelStore({
 *   baseUrl: "http://localhost:3001",
 *   userId: namespaceUserId(-1),
 * });
 * ```
 *
 * See the README for the full quickstart.
 */
export {
  DEFAULT_NAMESPACE,
  asNamespace,
  namespaceUserId,
  resolveNamespace,
  type NamespaceLike,
  type UserIdResolver,
} from "./namespace.js";
export { ambientConfig, ambientStore } from "./runtime.js";
export {
  CortadelStore,
  DEFAULT_APP_NAME,
  DEFAULT_TEXT_KEYS,
  type AddConversationOptions,
  type CortadelMemoryClient,
  type CortadelStoreOptions,
  type ErrorCallback,
  type StoreLogger,
} from "./store.js";
export {
  DEFAULT_TOOL_TOP_K,
  createAddMemoriesTool,
  createMemoryTools,
  createSearchMemoryTool,
  type AddMemoriesInput,
  type MemoryToolOptions,
  type SearchMemoryInput,
  type SearchMemoryToolOptions,
} from "./tools.js";
export {
  CortadelMemory,
  DEFAULT_RECALL_HEADER,
  type CortadelMemoryOptions,
} from "./memory.js";
