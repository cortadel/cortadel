/**
 * Cortadel long-term memory for the Claude Agent SDK.
 *
 * Cortadel is self-hosted long-term temporal graph memory for AI agents — a
 * bi-temporal graph store with hybrid BM25 + vector search. This package plugs
 * it into the two extension points the Claude Agent SDK actually offers:
 *
 * * an **in-process MCP server** (`createSdkMcpServer`) carrying `search_memory`
 *   and `add_memories`, so the agent can recall and remember on purpose, and
 * * **`UserPromptSubmit` / `Stop` hooks**, so it also recalls and remembers
 *   without being asked.
 *
 * Both come off one object:
 *
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { CortadelMemory } from "@cortadel/claude-agent-sdk";
 *
 * const memory = new CortadelMemory({ baseUrl: "http://localhost:3001", userId: "e2e-alice" });
 * const options = memory.apply({ model: "claude-sonnet-4-5" });
 *
 * for await (const message of query({ prompt: "What did we decide about the schema?", options })) {
 *   // …
 * }
 * ```
 *
 * @packageDocumentation
 */

export { CortadelMemory } from "./memory.js";
export type { ApplyOptions } from "./memory.js";
export {
  DEFAULT_APP_NAME,
  DEFAULT_SERVER_NAME,
  type CortadelMemoryClient,
  type CortadelMemoryClientOptions,
  type CortadelMemoryInit,
  type CortadelMemoryOptions,
  type CortadelMemoryTuning,
} from "./types.js";
export {
  lastExchange,
  type Exchange,
  type TranscriptEntry,
  type TranscriptLocation,
  type TranscriptReaders,
  type Turn,
} from "./transcript.js";
