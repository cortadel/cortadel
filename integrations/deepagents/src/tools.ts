/**
 * Cortadel memory as DeepAgents-native tools.
 *
 * These are built with LangChain v1's `tool()` helper — the same primitive DeepAgents builds its
 * own built-ins with — using the two-argument form whose second parameter is a `ToolRuntime`
 * (`@langchain/core/dist/tools/types.d.ts`, `type ToolRuntime`). That runtime is what makes
 * per-user scoping work: it carries `context`, `config` and `store`, which is where a DeepAgents
 * run keeps its user id.
 *
 * The result is a plain `ClientTool`, so it can be handed straight to
 * `createDeepAgent({ tools: [...] })`, attached to a middleware's `tools` array, or given to a
 * subagent.
 */

import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ClientTool } from "@langchain/core/tools";
import { type AddOptions, type SearchOptions } from "@cortadel/sdk";

import {
  ClientProvider,
  toRunScope,
  type CortadelConnectionOptions,
  type CortadelMemoryClient,
} from "./client.js";
import { reportFailure, type OnErrorCallback } from "./errors.js";
import { formatSearchResults } from "./format.js";

export const SEARCH_MEMORY_DESCRIPTION = `Search the user's long-term memory for facts recorded in earlier conversations.

Use this when the current conversation does not contain something you need and it plausibly came up before: a stated preference, a past decision and its reason, a person or project the user has mentioned, a correction they made. Search is hybrid (keyword + semantic), so phrase the query the way the fact would have been stated rather than as keywords.

Relevant memories are already recalled for you at the start of each turn; call this only when you need something that recall did not surface.`;

export const ADD_MEMORIES_DESCRIPTION = `Record durable facts about the user in long-term memory.

The conversation itself is saved automatically when the turn ends, so use this only for something worth remembering that the transcript would not make obvious: an explicit "remember this", a preference the user stated in passing, a decision plus the reasoning behind it, or a correction of something you got wrong.

Write each fact as one self-contained sentence that will still make sense months from now, with no pronouns pointing back at this conversation. Do not record transient state, one-off task requests, or small talk. Never record credentials, API keys, or access tokens.`;

/** Arguments for `search_memory`. */
export const searchMemorySchema = z.object({
  query: z.string().describe("What to look for, phrased as the fact might have been stated."),
  // 10 matches the Cortadel SDK's own `SearchOptions.topK`, and is deliberately wider than the
  // middleware's automatic per-turn recall (5): the model only reaches for this tool when that
  // recall already came up short.
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of memories to return."),
});

/** Arguments for `add_memories`. */
export const addMemoriesSchema = z.object({
  memories: z
    .array(z.string())
    .describe("One or more self-contained facts to remember, each a single sentence."),
});

/** Search knobs shared by the tools and the middleware. */
export interface CortadelSearchOptions {
  /** `hybrid` (default), `text`, or `vector`. */
  searchMode?: string;
  /** Run Cortadel's cross-encoder reranker over the fused results. More accurate, slower. */
  rerank?: boolean;
  /** Restrict recall (and tag writes) to one cognitive type: `episodic`/`semantic`/`procedural`. */
  memoryType?: string;
}

/** Failure-handling knobs shared by the tools and the middleware. */
export interface CortadelErrorOptions {
  /**
   * Rethrow Cortadel failures instead of degrading. Off by default — memory must never take the
   * agent down.
   */
  throwOnError?: boolean;
  /**
   * Callback invoked with the error whenever a Cortadel call fails. Independent of
   * `throwOnError`: it observes, it does not decide. With no callback set, a swallowed failure is
   * reported through `console.warn`.
   */
  onError?: OnErrorCallback;
}

export interface CortadelToolsOptions
  extends CortadelConnectionOptions,
    CortadelSearchOptions,
    CortadelErrorOptions {
  /**
   * An existing {@link ClientProvider} to share (the middleware passes its own, so the middleware
   * and its tools reuse one client cache). When given, the connection options above are ignored.
   */
  provider?: ClientProvider;
}

interface ResolvedRun {
  client: CortadelMemoryClient;
  signal: AbortSignal | undefined;
}

function resolveRun(provider: ClientProvider, runtime: unknown): ResolvedRun | undefined {
  const scope = toRunScope(runtime);
  const client = provider.forRun(scope);
  return client ? { client, signal: scope.signal } : undefined;
}

/**
 * Build the `search_memory` and `add_memories` tools.
 *
 * Every option mirrors {@link createCortadelMemoryMiddleware}; see the README configuration table.
 *
 * @returns `[search_memory, add_memories]`, ready for `createDeepAgent({ tools })`.
 */
export function createCortadelTools(options: CortadelToolsOptions = {}): ClientTool[] {
  const provider = options.provider ?? new ClientProvider(options);
  const { searchMode = "hybrid", rerank = false, memoryType, throwOnError, onError } = options;

  /**
   * Uniform, non-throwing failure text.
   *
   * A tool that throws aborts the agent's turn, so by default the model is told plainly that
   * memory is degraded and carries on. `onError` still observes the failure, and
   * `throwOnError: true` opts into the abort.
   */
  const unavailable = (action: string, error: unknown): string => {
    const detail = reportFailure(action, error, { throwOnError, onError });
    return `Cortadel memory is unavailable right now (${detail}). Continue without it.`;
  };

  const searchOptions = (topK: number): SearchOptions => ({
    topK,
    mode: searchMode,
    ...(rerank ? { rerank: "cross_encoder" } : {}),
    ...(memoryType ? { memoryType } : {}),
  });

  const searchMemory = tool(
    async (
      { query, topK }: { query: string; topK: number },
      runtime: ToolRuntime<Record<string, unknown>, unknown>,
    ): Promise<string> => {
      const run = resolveRun(provider, runtime);
      if (!run) return "Cortadel memory is not configured for this run; continue without it.";
      try {
        const results = await run.client.search(query, searchOptions(topK), run.signal);
        return formatSearchResults(results.results, query);
      } catch (error) {
        return unavailable("search_memory", error);
      }
    },
    {
      name: "search_memory",
      description: SEARCH_MEMORY_DESCRIPTION,
      schema: searchMemorySchema,
    },
  );

  const addMemories = tool(
    async (
      { memories }: { memories: string[] },
      runtime: ToolRuntime<Record<string, unknown>, unknown>,
    ): Promise<string> => {
      const run = resolveRun(provider, runtime);
      if (!run) return "Cortadel memory is not configured for this run; nothing was recorded.";

      const texts = memories.map((text) => text?.trim()).filter((text): text is string => !!text);
      if (texts.length === 0) return "Nothing to remember: no non-empty memories were provided.";

      const addOptions: AddOptions = {
        app: provider.appName,
        ...(memoryType ? { memoryType } : {}),
      };
      try {
        const stored: string[] = [];
        for (const text of texts) {
          const created = await run.client.add(text, addOptions, run.signal);
          // `event` matters: a 200 does not mean a new memory was written. The write pipeline may
          // have deduplicated, superseded, or merged it.
          stored.push(`- ${created.event ?? "ADD"}: ${created.content ?? text}`);
        }
        return `Recorded in Cortadel:\n${stored.join("\n")}`;
      } catch (error) {
        return unavailable("add_memories", error);
      }
    },
    {
      name: "add_memories",
      description: ADD_MEMORIES_DESCRIPTION,
      schema: addMemoriesSchema,
    },
  );

  return [searchMemory, addMemories];
}
