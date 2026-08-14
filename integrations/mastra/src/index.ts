import { CortadelClientPool } from "./pool.js";
import { CortadelMemoryProcessor } from "./processor.js";
import type { CortadelMemoryProcessorOptions } from "./processor.js";
import { createCortadelTools } from "./tools.js";
import type { CortadelToolsOptions } from "./tools.js";

export { CortadelClientPool, DEFAULT_APP_NAME, DEFAULT_BASE_URL, MAX_CACHED_CLIENTS } from "./pool.js";
export { CortadelMemoryProcessor } from "./processor.js";
export type { CortadelMemoryProcessorOptions } from "./processor.js";
export { createCortadelTools } from "./tools.js";
export type { CortadelToolsOptions } from "./tools.js";
export { DEFAULT_MEMORY_HEADER, extractMessageText, formatMemoryBlock, latestTextByRole } from "./format.js";
export { mergeScopes, resolveUserId, scopeFromMessages, scopeFromRequestContext } from "./scope.js";
export type {
  CortadelClientLike,
  CortadelConnectionOptions,
  CortadelErrorContext,
  CortadelScope,
  RequestContextLike,
} from "./types.js";

/** Options for {@link cortadelMemory}. */
export type CortadelMemoryOptions = CortadelMemoryProcessorOptions & CortadelToolsOptions;

/** What {@link cortadelMemory} hands back. */
export interface CortadelMemory {
  /** Register in **both** `inputProcessors` and `outputProcessors`. */
  processor: CortadelMemoryProcessor;
  /** Spread into an agent's `tools`. */
  tools: ReturnType<typeof createCortadelTools>;
  /** The shared per-user client pool behind both. */
  pool: CortadelClientPool;
}

/**
 * Everything Cortadel offers a Mastra agent, wired to one shared client pool.
 *
 * ```ts
 * const memory = cortadelMemory({ baseUrl: "http://localhost:3001" });
 *
 * const agent = new Agent({
 *   name: "assistant",
 *   instructions: "You are a helpful assistant.",
 *   model: "openai/gpt-5",
 *   tools: { ...memory.tools },
 *   inputProcessors: [memory.processor],
 *   outputProcessors: [memory.processor],
 * });
 *
 * await agent.generate("What did I say about deployment windows?", {
 *   memory: { resource: "e2e-mastra-user", thread: "thread-1" },
 * });
 * ```
 */
export function cortadelMemory(options: CortadelMemoryOptions = {}): CortadelMemory {
  const pool = options.pool ?? new CortadelClientPool(options);
  return {
    processor: new CortadelMemoryProcessor({ ...options, pool }),
    tools: createCortadelTools({ ...options, pool }),
    pool,
  };
}
