import type { AddOptions, SearchOptions } from "@cortadel/sdk";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { CortadelClientPool } from "./pool.js";
import { mergeScopes, resolveUserId, scopeFromRequestContext } from "./scope.js";
import type { CortadelConnectionOptions, CortadelErrorContext, CortadelScope } from "./types.js";

/** Options for {@link createCortadelTools}. */
export interface CortadelToolsOptions extends CortadelConnectionOptions {
  /**
   * Prefix for both tool **ids** (`"memory"` → `memory_search_memory`), which is
   * what Mastra's registry and traces key on. Unset by default.
   *
   * It deliberately does not touch the name the model calls: Mastra takes that
   * from the key you register the tool under, so renaming is
   * `tools: { my_recall: cortadel.tools.search_memory }`.
   */
  idPrefix?: string;
  /** Default `topK` when the model does not ask for one. Default `10`. */
  topK?: number;
  /** Cortadel search mode. Default `"hybrid"`. */
  searchMode?: "hybrid" | "text" | "vector";
  /** Rerank hits with the server's cross-encoder. Default `false`. */
  rerank?: boolean;
  /**
   * Restrict the search tool to memories from the current thread (Mastra's
   * `threadId`, stored as Cortadel's `sessionId`). Default `false`.
   */
  scopeRecallToSession?: boolean;
  /** Abort a tool call after this many ms. Default `10000`; `0` disables. */
  timeoutMs?: number;
  /** Share one client pool with the processor. */
  pool?: CortadelClientPool;
}

/** Matches the Cortadel SDK's own `SearchOptions.topK` default. */
const DEFAULT_TOP_K = 10;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

const searchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("What to recall, phrased as a natural-language question or topic."),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of memories to return (1-50)."),
});

const searchOutputSchema = z.object({
  memories: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      score: z.number().optional().describe("Fused relevance score (RRF)."),
      createdAt: z.string().optional(),
      categories: z.array(z.string()).optional(),
    }),
  ),
  count: z.number(),
  error: z.string().optional().describe("Set when memory was unavailable; the answer should proceed without it."),
});

const addInputSchema = z.object({
  statements: z
    .array(z.string().min(1))
    .min(1)
    .describe("Standalone facts worth remembering long term. One self-contained sentence each."),
});

const addOutputSchema = z.object({
  stored: z.array(
    z.object({
      text: z.string(),
      id: z.string().optional(),
      event: z
        .string()
        .optional()
        .describe("What the store pipeline did: ADD, SKIP_DUPLICATE, SUPERSEDE, TOUCH, ..."),
      error: z.string().optional(),
    }),
  ),
  count: z.number(),
  error: z.string().optional(),
});

function defaultOnError(error: unknown, context: CortadelErrorContext): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[cortadel/mastra] ${context.operation} failed: ${message}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal | undefined {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timeout && parent) return AbortSignal.any([timeout, parent]);
  return timeout ?? parent;
}

/** Everything a tool's `execute` gives us that bears on identity. */
interface ToolContextLike {
  agent?: { threadId?: string; resourceId?: string };
  requestContext?: { get(key: string): unknown };
  abortSignal?: AbortSignal;
}

function scopeFromToolContext(context: ToolContextLike | undefined): CortadelScope {
  // `AgentToolExecutionContext` carries `threadId` / `resourceId`
  // (@mastra/core/dist/tools/types.d.ts).
  const fromAgent: CortadelScope = {
    resourceId: context?.agent?.resourceId,
    threadId: context?.agent?.threadId,
  };
  return mergeScopes(fromAgent, scopeFromRequestContext(context?.requestContext), {
    requestContext: context?.requestContext,
  });
}

const NO_USER_ID =
  "No Cortadel user id for this run. Configure `userId`/`resolveUserId` on the Cortadel tools, " +
  "or call the agent with a `resourceId`.";

/**
 * Cortadel memory as Mastra tools, so the agent can search and write memory on
 * its own initiative.
 *
 * Built with `createTool` from `@mastra/core/tools`. Spread the result straight
 * into an agent:
 *
 * ```ts
 * const tools = createCortadelTools({ baseUrl, userId });
 * new Agent({ ..., tools: { ...tools } });
 * ```
 *
 * The keys — `search_memory` and `add_memories` — are the names the model sees:
 * Mastra names a tool after the key you register it under, not after its `id`.
 * They match Cortadel's own MCP tool names on purpose.
 *
 * Both tools resolve the Cortadel user id per call, so one agent can serve many
 * users: `resolveUserId` wins, then a pinned `userId`, then Mastra's
 * `resourceId`. Failures are returned as an `error` field rather than thrown —
 * a memory outage must not break the tool loop — unless `throwOnError` is set.
 */
export function createCortadelTools(options: CortadelToolsOptions = {}) {
  const pool = options.pool ?? new CortadelClientPool(options);
  const prefix = options.idPrefix ? `${options.idPrefix}_` : "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  /** Notify `onError`, then rethrow when the caller opted into hard failures. */
  const report = (error: unknown, context: CortadelErrorContext): void => {
    try {
      (options.onError ?? defaultOnError)(error, context);
    } catch {
      // An error reporter must never break the tool loop either.
    }
    if (options.throwOnError) throw error;
  };

  const searchMemory = createTool({
    id: `${prefix}search_memory`,
    description:
      "Search the user's long-term Cortadel memory for facts, preferences and past decisions. " +
      "Use this whenever the answer could depend on something the user told you before.",
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    execute: async (input, context) => {
      const scope = scopeFromToolContext(context as ToolContextLike);
      const userId = resolveUserId(scope, options);
      if (!userId) {
        if (options.throwOnError) throw new Error(NO_USER_ID);
        return { memories: [], count: 0, error: NO_USER_ID };
      }

      try {
        const searchOptions: SearchOptions = {
          topK: input.topK ?? options.topK ?? DEFAULT_TOP_K,
          mode: options.searchMode ?? "hybrid",
          ...(options.rerank ? { rerank: "cross_encoder" } : {}),
          ...(options.scopeRecallToSession && scope.threadId ? { sessionId: scope.threadId } : {}),
        };
        const results = await pool
          .get(userId)
          .search(input.query, searchOptions, buildSignal(timeoutMs, context?.abortSignal));

        const memories = (results.results ?? []).map((hit) => ({
          id: hit.id,
          content: hit.content,
          ...(typeof hit.rrfScore === "number" ? { score: hit.rrfScore } : {}),
          ...(typeof hit.createdAt === "string" ? { createdAt: hit.createdAt } : {}),
          ...(hit.categories ? { categories: hit.categories } : {}),
        }));
        return { memories, count: memories.length };
      } catch (error) {
        report(error, { operation: "search-tool", userId, threadId: scope.threadId });
        return { memories: [], count: 0, error: messageOf(error) };
      }
    },
  });

  const addMemories = createTool({
    id: `${prefix}add_memories`,
    description:
      "Save durable facts about the user to Cortadel long-term memory: stable preferences, " +
      "decisions, relationships and constraints. Do not save small talk or anything transient.",
    inputSchema: addInputSchema,
    outputSchema: addOutputSchema,
    execute: async (input, context) => {
      const scope = scopeFromToolContext(context as ToolContextLike);
      const userId = resolveUserId(scope, options);
      if (!userId) {
        if (options.throwOnError) throw new Error(NO_USER_ID);
        return { stored: [], count: 0, error: NO_USER_ID };
      }

      const client = pool.get(userId);
      const signal = buildSignal(timeoutMs, context?.abortSignal);
      const addOptions: AddOptions = { app: pool.appName };

      const settled = await Promise.allSettled(
        input.statements.map((text) => client.add(text, addOptions, signal)),
      );

      const stored = settled.map((outcome, index) => {
        const text = input.statements[index] ?? "";
        if (outcome.status === "fulfilled") {
          return {
            text,
            id: outcome.value.id,
            // A 2xx does not mean a new memory was written — `event` says what
            // the store pipeline actually did (ADD, SKIP_DUPLICATE, ...).
            ...(outcome.value.event ? { event: outcome.value.event } : {}),
          };
        }
        report(outcome.reason, { operation: "add-tool", userId, threadId: scope.threadId });
        return { text, error: messageOf(outcome.reason) };
      });

      const written = stored.filter((entry) => entry.error === undefined).length;
      return { stored, count: written };
    },
  });

  return { search_memory: searchMemory, add_memories: addMemories };
}
