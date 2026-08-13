/**
 * Cortadel long-term memory for the OpenAI Agents SDK (TypeScript).
 *
 * Cortadel is self-hosted long-term temporal graph memory for AI agents: a bi-temporal graph
 * store with hybrid BM25 + vector search. This package makes it native to `@openai/agents`.
 *
 * Two ways in, and they compose:
 *
 * * {@link CortadelSession} — a `Session` that keeps verbatim history locally, distils each
 *   finished turn into Cortadel, and (via its `callModelInputFilter`) recalls relevant memories
 *   into every model call automatically.
 * * {@link cortadelMemoryTools} — `search_memory` and `add_memories` as real `FunctionTool`s, for
 *   agents that decide when to remember.
 *
 * ```ts
 * import { Agent, run } from '@openai/agents';
 * import { CortadelSession } from '@cortadel/openai-agents';
 *
 * const agent = new Agent({ name: 'Assistant', instructions: 'You are helpful.' });
 * const session = new CortadelSession({ sessionId: 'chat-1', userId: 'e2e-alice' });
 *
 * const result = await run(agent, 'What editor do I use?', session.runOptions());
 * ```
 */

export { CortadelSession } from './session.js';
export type {
  CortadelRunOptions,
  CortadelSessionOptions,
  InjectionSite,
} from './session.js';

export { cortadelMemoryTools } from './tools.js';
export type { CortadelMemoryToolsOptions } from './tools.js';

export {
  DEFAULT_APP_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_MEMORY_HEADER,
  buildClient,
  formatMemoryBlock,
} from './memory.js';
export type {
  CortadelConnectionOptions,
  ErrorOptions,
  OnError,
  RecallOptions,
} from './memory.js';
