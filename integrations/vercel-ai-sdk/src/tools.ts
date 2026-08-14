import { tool } from "ai";
import type { Tool, ToolSet } from "ai";
import { z } from "zod";

import { ClientResolver } from "./connection.js";
import type {
  CortadelConnectionOptions,
  CortadelErrorContext,
  CortadelMemoryClient,
} from "./types.js";

/** Matches the Cortadel SDK's own `SearchOptions.topK` default. */
const DEFAULT_TOOL_TOP_K = 10;

/** Search knobs for the `search_memory` tool. */
export interface CortadelSearchToolOptions {
  /**
   * Default result count when the model does not ask for one (1–50). Defaults to `10`, the
   * Cortadel SDK's own `SearchOptions` default — a tool the model called on purpose can afford a
   * wider net than the middleware's automatic injection, which pays for every hit in every prompt.
   */
  topK?: number;
  /** Search mode. Defaults to `"hybrid"`. */
  mode?: "hybrid" | "text" | "vector";
  /** Set to `"cross_encoder"` to rerank with the server's local cross-encoder. */
  rerank?: "cross_encoder";
  /** Restrict results to one cognitive type. */
  memoryType?: "episodic" | "semantic" | "procedural";
  /** Restrict results to one session. */
  sessionId?: string;
  /** Drop hits whose `rrfScore` is below this. Unscored hits are kept. */
  minScore?: number;
}

/** Write knobs for the `add_memories` tool. */
export interface CortadelAddToolOptions {
  /**
   * App name recorded as the creator of each memory (the SDK's `AddOptions.app`). Unset by
   * default, which leaves the attribution to the server.
   *
   * Distinct from the connection-level `appName`, which the SDK records for access logging on
   * *searches* only and never applies to a write.
   */
  app?: string;
  /**
   * When `false`, store text verbatim and skip background entity/category extraction. Server-side
   * dedup still applies. Defaults to the server default (`true`).
   */
  infer?: boolean;
  /** Pin every stored memory to a cognitive type. */
  memoryType?: "episodic" | "semantic" | "procedural";
  /** Metadata attached to every stored memory. */
  metadata?: Record<string, unknown>;
}

/** Options for {@link cortadelTools}. */
export interface CortadelToolsOptions extends CortadelConnectionOptions {
  search?: CortadelSearchToolOptions;
  add?: CortadelAddToolOptions;

  /**
   * Observe a failed tool call. Called whether or not
   * {@link CortadelToolsOptions.throwOnError} is set — it reports, it does not decide control flow.
   *
   * With no callback and no `throwOnError`, a swallowed failure is logged through `console.warn`
   * rather than vanishing silently.
   */
  onError?: (error: unknown, context: CortadelErrorContext) => void;

  /**
   * Throw out of the tool instead of returning a result carrying `error`. Defaults to `false`: a
   * memory outage should leave the model able to answer without memory, not abort the run.
   *
   * With `true` the AI SDK sees the rejection and surfaces it as a tool error, which is what you
   * want when an answer built without memory would be worse than no answer.
   */
  throwOnError?: boolean;
}

/** One hit returned to the model by `search_memory`. */
export interface RecalledMemory {
  id: string;
  content: string;
  /** Fused relevance score (RRF), when the server returned one. */
  score?: number;
  /** ISO 8601 creation timestamp, when the server returned one. */
  createdAt?: string;
}

/** Result of `search_memory`. Failures arrive as `error` rather than a throw, unless `throwOnError`. */
export interface SearchMemoryResult {
  memories: RecalledMemory[];
  count: number;
  error?: string;
}

/** Result of `add_memories`. Failures arrive as `error` rather than a throw, unless `throwOnError`. */
export interface AddMemoriesResult {
  /** Memories the server actually wrote. */
  stored: number;
  /** Memories the server folded into an existing one (`SKIP_DUPLICATE`). */
  duplicates: number;
  /** Ids of everything the server acknowledged. */
  ids: string[];
  error?: string;
}

const searchMemoryInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What to recall, in natural language. Write it as the question you want answered, not as " +
        "keywords — search is hybrid (BM25 + vector), so full phrasing retrieves better.",
    ),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many memories to return. Leave unset for the configured default."),
});

const addMemoriesInput = z.object({
  memories: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Durable facts worth remembering for later conversations, one self-contained sentence " +
        "each. Write them so they still make sense with no surrounding context. Do not store " +
        "transient details of the current task.",
    ),
});

/** The tools this package registers, keyed by the names the model sees. */
export interface CortadelToolSet extends ToolSet {
  search_memory: Tool<z.infer<typeof searchMemoryInput>, SearchMemoryResult>;
  add_memories: Tool<z.infer<typeof addMemoriesInput>, AddMemoriesResult>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Cortadel memory as AI SDK tools the model can call for itself.
 *
 * Returns a `ToolSet` with `search_memory` and `add_memories`, named to match Cortadel's MCP tools
 * so an agent behaves the same whichever surface it reaches memory through. Spread it into
 * `generateText` / `streamText` / `Agent`:
 *
 * ```ts
 * const result = await generateText({
 *   model: openai("gpt-5"),
 *   tools: { ...cortadelTools({ baseUrl: "http://localhost:3001", userId: "e2e-alice" }) },
 *   prompt: "What do you remember about my deployment setup?",
 * });
 * ```
 *
 * The tool set is bound to one user id, because a Cortadel client is: there is no per-call user
 * parameter, and deliberately so — the model can never be talked into reading another user's
 * memories, since the user id is not part of any tool's input schema. For a multi-tenant server,
 * build a tool set per request; it is a plain object literal and costs nothing.
 */
export function cortadelTools(options: CortadelToolsOptions): CortadelToolSet {
  const resolver = new ClientResolver(options);
  // No per-request override exists here — a tool set is bound to one user id — so the resolver is
  // asked for the configured one. Its constructor has already rejected a config that has neither a
  // `userId` nor a client to take one from, which is what the cast records.
  const userId = resolver.resolveUserId() as string;
  const client: CortadelMemoryClient = resolver.resolve(userId);

  const searchOptions = options.search ?? {};
  const addOptions = options.add ?? {};
  const onError = options.onError;
  const throwOnError = options.throwOnError ?? false;

  /**
   * Reports a failed tool call, then decides its fate: rethrow when the caller asked for that,
   * otherwise `console.warn` if nothing else is watching, so a silent memory outage is impossible.
   */
  function report(error: unknown, context: CortadelErrorContext): void {
    if (onError != null) {
      try {
        onError(error, context);
      } catch {
        // A broken error handler must not be more fatal than the error it was handed.
      }
    }
    if (throwOnError) {
      throw error;
    }
    if (onError == null) {
      console.warn(
        `Cortadel: ${context.phase} failed for user "${context.userId}" — the tool returned an error to the model.`,
        error,
      );
    }
  }

  return {
    search_memory: tool({
      description:
        "Search this user's long-term memory for facts recorded in earlier conversations. Call " +
        "it before answering anything that depends on what you were told previously — " +
        "preferences, decisions, ongoing work, prior context. Returns an empty list when nothing " +
        "relevant is stored, which means you have no memory of it, not that it is false.",
      inputSchema: searchMemoryInput,
      async execute({ query, topK }, { abortSignal }): Promise<SearchMemoryResult> {
        try {
          const found = await client.search(
            query,
            {
              topK: topK ?? searchOptions.topK ?? DEFAULT_TOOL_TOP_K,
              mode: searchOptions.mode ?? "hybrid",
              rerank: searchOptions.rerank,
              memoryType: searchOptions.memoryType,
              sessionId: searchOptions.sessionId,
            },
            abortSignal,
          );

          const memories: RecalledMemory[] = (found.results ?? [])
            .filter(
              (hit) =>
                searchOptions.minScore == null ||
                hit.rrfScore == null ||
                hit.rrfScore >= searchOptions.minScore,
            )
            .map((hit) => ({
              id: hit.id,
              content: hit.content,
              ...(hit.rrfScore == null ? {} : { score: hit.rrfScore }),
              ...(hit.createdAt == null ? {} : { createdAt: hit.createdAt }),
            }));

          return { memories, count: memories.length };
        } catch (error) {
          report(error, { phase: "recall", userId });
          return { memories: [], count: 0, error: messageOf(error) };
        }
      },
    }),

    add_memories: tool({
      description:
        "Store durable facts in this user's long-term memory so they survive into future " +
        "conversations. Use it when the user states a preference, a decision, or a fact about " +
        "themselves or their work that will still matter later. The server deduplicates against " +
        "what is already stored, so a repeat is harmless.",
      inputSchema: addMemoriesInput,
      async execute({ memories }, { abortSignal }): Promise<AddMemoriesResult> {
        const ids: string[] = [];
        let stored = 0;
        let duplicates = 0;

        try {
          // Sequential on purpose: the server dedups each write against what is already stored,
          // and firing near-identical facts in parallel races that check.
          for (const text of memories) {
            const created = await client.add(
              text,
              {
                app: addOptions.app,
                infer: addOptions.infer,
                memoryType: addOptions.memoryType,
                metadata: addOptions.metadata,
              },
              abortSignal,
            );

            if (created.id) {
              ids.push(created.id);
            }
            if (created.event === "SKIP_DUPLICATE") {
              duplicates += 1;
            } else {
              stored += 1;
            }
          }

          return { stored, duplicates, ids };
        } catch (error) {
          report(error, { phase: "persist", userId });
          return { stored, duplicates, ids, error: messageOf(error) };
        }
      },
    }),
  };
}
