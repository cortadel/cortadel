import type { LanguageModelMiddleware } from "ai";
import type { ChatMessage, SearchHit } from "@cortadel/sdk";

import { ClientResolver } from "./connection.js";
import { formatMemories as defaultFormatMemories } from "./format.js";
import { assistantText, injectSystemMemories, lastUserText } from "./prompt.js";
import type {
  CortadelConnectionOptions,
  CortadelErrorContext,
  CortadelMemoryClient,
  FormatMemoriesContext,
  LanguageModelGenerateResult,
  LanguageModelStreamPart,
} from "./types.js";

/** Namespace this integration reads from (and ignores on the way out of) `providerOptions`. */
export const CORTADEL_PROVIDER_OPTIONS_KEY = "cortadel";

const DEFAULT_TOP_K = 5;
const DEFAULT_RECALL_CACHE_TTL_MS = 60_000;
const DEFAULT_RECALL_CACHE_SIZE = 32;
const PERSIST_DEDUPE_SIZE = 256;

/** Options for {@link cortadelMemory}. */
export interface CortadelMemoryOptions extends CortadelConnectionOptions {
  /** Search Cortadel before each model call and inject what it finds. Defaults to `true`. */
  recall?: boolean;

  /** Maximum memories to inject (Cortadel accepts 1–50). Defaults to `5`. */
  topK?: number;

  /** Search mode. Defaults to `"hybrid"` (BM25 + vector, fused with RRF). */
  mode?: "hybrid" | "text" | "vector";

  /**
   * Set to `"cross_encoder"` to rerank hits with the server's local cross-encoder. Omitted by
   * default: it costs a model pass per search. Any other value is silently ignored by the server.
   */
  rerank?: "cross_encoder";

  /** Restrict recall to a cognitive type. */
  memoryType?: "episodic" | "semantic" | "procedural";

  /**
   * Session id, used to group recalled and stored facts. A per-request
   * `providerOptions.cortadel.sessionId` overrides it.
   */
  sessionId?: string;

  /** Drop hits whose `rrfScore` is below this. Unscored hits are kept. */
  minScore?: number;

  /** Render the injected system block. Defaults to {@link defaultFormatMemories}. */
  formatMemories?: (hits: SearchHit[], context: FormatMemoriesContext) => string;

  /**
   * How long an identical (user, query) recall is reused, in milliseconds. Defaults to `60_000`;
   * `0` disables caching.
   *
   * This is what keeps an agentic loop to one search per *turn* rather than one per *step*: every
   * step of a tool-calling loop re-enters the middleware with the same trailing user message, so
   * the query is unchanged and the cached hits are reused.
   */
  recallCacheTtlMs?: number;

  /** Maximum cached recalls. Defaults to `32`. */
  recallCacheSize?: number;

  /** Persist each completed turn with `addConversation`. Defaults to `true`. */
  persist?: boolean;

  /**
   * Await the write before the call resolves (or the stream closes). Defaults to `false`, which
   * keeps memory off the latency path.
   *
   * Turn it on in serverless/edge runtimes, where a fire-and-forget promise is killed the moment
   * the handler returns and the write silently never happens.
   */
  awaitPersist?: boolean;

  /** Extract facts about the assistant rather than the user. Defaults to `false`. */
  isAgentMemory?: boolean;

  /** Tags applied to every stored fact. */
  tags?: string[];

  /** Project scope applied to every stored fact. */
  project?: string;

  /**
   * Observe a Cortadel failure. Called for every recall and persistence error, whether or not
   * {@link CortadelMemoryOptions.throwOnError} is set — it reports, it does not decide control flow.
   *
   * With no callback and no `throwOnError`, a swallowed failure is logged through `console.warn`
   * rather than vanishing silently.
   */
  onError?: (error: unknown, context: CortadelErrorContext) => void;

  /**
   * Propagate memory failures to the caller instead of degrading. Defaults to `false` — a memory
   * outage must never take the agent down, so recall falls back to an unmodified prompt and a
   * failed write is dropped.
   *
   * With `true`, a recall failure rejects the model call, and a persistence failure does too *if*
   * {@link CortadelMemoryOptions.awaitPersist} is also set. A fire-and-forget write has already
   * returned to the caller by the time it fails, so it can only ever be reported.
   */
  throwOnError?: boolean;
}

/** Per-request overrides read from `providerOptions.cortadel`. */
interface RequestOptions {
  userId?: string;
  sessionId?: string;
  recall?: boolean;
  persist?: boolean;
}

function readRequestOptions(providerOptions: unknown): RequestOptions {
  if (providerOptions == null || typeof providerOptions !== "object") {
    return {};
  }
  const namespace = (providerOptions as Record<string, unknown>)[CORTADEL_PROVIDER_OPTIONS_KEY];
  if (namespace == null || typeof namespace !== "object") {
    return {};
  }
  const raw = namespace as Record<string, unknown>;
  return {
    userId: typeof raw.userId === "string" ? raw.userId : undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    recall: typeof raw.recall === "boolean" ? raw.recall : undefined,
    persist: typeof raw.persist === "boolean" ? raw.persist : undefined,
  };
}

/**
 * Reads the unified finish reason.
 *
 * `ai@7`'s V4 spec made `finishReason` an object (`{ unified, raw }`); V3 and earlier used a bare
 * string, and `wrapLanguageModel` still accepts those models. Handle both.
 */
function unifiedFinishReason(result: { finishReason: unknown }): string | undefined {
  const reason = result.finishReason;
  if (typeof reason === "string") {
    return reason;
  }
  if (reason != null && typeof reason === "object" && "unified" in reason) {
    const unified = (reason as { unified?: unknown }).unified;
    return typeof unified === "string" ? unified : undefined;
  }
  return undefined;
}

/** FNV-1a, salted with the input length. Keeps the persistence dedupe set small and bounded. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${value.length.toString(36)}:${hash.toString(36)}`;
}

interface CachedRecall {
  at: number;
  hits: SearchHit[];
}

/**
 * Cortadel long-term memory as an AI SDK language-model middleware.
 *
 * Wrap any model with it and every call gains two things, with no change to your `generateText` /
 * `streamText` code:
 *
 * 1. **Recall** — `transformParams` searches Cortadel with the latest user message and injects the
 *    hits as a system message ahead of the conversation.
 * 2. **Persistence** — `wrapGenerate` / `wrapStream` hand the finished turn to `addConversation`,
 *    which distills it into atomic facts.
 *
 * Cortadel being down is never fatal by default: both halves are wrapped, report through `onError`
 * (or `console.warn` when you set none), and leave the model call untouched. Set `throwOnError` if
 * you would rather the run fail than answer without memory.
 *
 * @example
 * ```ts
 * const model = wrapLanguageModel({
 *   model: openai("gpt-5"),
 *   middleware: cortadelMemory({ baseUrl: "http://localhost:3001", userId: "alice" }),
 * });
 * ```
 */
export function cortadelMemory(options: CortadelMemoryOptions): LanguageModelMiddleware {
  const resolver = new ClientResolver(options);

  const recallEnabled = options.recall ?? true;
  const persistEnabled = options.persist ?? true;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const cacheTtlMs = options.recallCacheTtlMs ?? DEFAULT_RECALL_CACHE_TTL_MS;
  const cacheSize = options.recallCacheSize ?? DEFAULT_RECALL_CACHE_SIZE;
  const format = options.formatMemories ?? defaultFormatMemories;
  const onError = options.onError;
  const throwOnError = options.throwOnError ?? false;

  const recallCache = new Map<string, CachedRecall>();
  const persistedTurns = new Set<string>();

  /**
   * Reports a failure exactly once, then decides its fate.
   *
   * Order matters: the observer always runs first, then the error is rethrown if the caller asked
   * for that, and only a genuinely swallowed failure falls through to `console.warn` — so an
   * unconfigured integration is never silent, and a configured one is never noisy.
   *
   * @param onCallPath whether the caller can still receive a throw. `false` for a fire-and-forget
   * write, which has already returned, so its failure is reported no matter what `throwOnError`
   * says.
   */
  function report(error: unknown, context: CortadelErrorContext, onCallPath = true): void {
    if (onError != null) {
      try {
        onError(error, context);
      } catch {
        // A broken error handler must not be more fatal than the error it was handed.
      }
    }
    if (onCallPath && throwOnError) {
      throw error;
    }
    if (onError == null) {
      console.warn(
        `Cortadel: ${context.phase} failed for user "${context.userId}" — continuing without memory.`,
        error,
      );
    }
  }

  function cacheGet(key: string): SearchHit[] | undefined {
    if (cacheTtlMs <= 0) {
      return undefined;
    }
    const entry = recallCache.get(key);
    if (entry == null) {
      return undefined;
    }
    if (Date.now() - entry.at > cacheTtlMs) {
      recallCache.delete(key);
      return undefined;
    }
    return entry.hits;
  }

  function cacheSet(key: string, hits: SearchHit[]): void {
    if (cacheTtlMs <= 0 || cacheSize <= 0) {
      return;
    }
    if (recallCache.size >= cacheSize) {
      const oldest = recallCache.keys().next();
      if (!oldest.done) {
        recallCache.delete(oldest.value);
      }
    }
    recallCache.set(key, { at: Date.now(), hits });
  }

  async function recall(
    client: CortadelMemoryClient,
    userId: string,
    query: string,
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SearchHit[]> {
    const key = `${userId}\u0000${sessionId ?? ""}\u0000${query}`;
    const cached = cacheGet(key);
    if (cached != null) {
      return cached;
    }

    const found = await client.search(
      query,
      {
        topK,
        mode: options.mode ?? "hybrid",
        rerank: options.rerank,
        memoryType: options.memoryType,
        sessionId,
      },
      signal,
    );

    const hits = (found.results ?? []).filter((hit) => {
      if (options.minScore == null) {
        return true;
      }
      return hit.rrfScore == null || hit.rrfScore >= options.minScore;
    });

    cacheSet(key, hits);
    return hits;
  }

  function persist(
    client: CortadelMemoryClient,
    userId: string,
    sessionId: string | undefined,
    userText: string,
    replyText: string,
  ): Promise<void> | undefined {
    if (!userText || !replyText) {
      // A conversation needs both halves for the server to distill anything useful from it.
      return undefined;
    }

    const key = fingerprint(`${userId}\u0000${userText}\u0000${replyText}`);
    if (persistedTurns.has(key)) {
      return undefined;
    }
    // Claim the turn before awaiting, so concurrent steps of one loop cannot both write it.
    if (persistedTurns.size >= PERSIST_DEDUPE_SIZE) {
      const oldest = persistedTurns.values().next();
      if (!oldest.done) {
        persistedTurns.delete(oldest.value);
      }
    }
    persistedTurns.add(key);

    const messages: ChatMessage[] = [
      { role: "user", content: userText },
      { role: "assistant", content: replyText },
    ];

    return client
      .addConversation(messages, {
        sessionId,
        isAgentMemory: options.isAgentMemory,
        tags: options.tags,
        project: options.project,
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        // Let a failed write be retried rather than permanently suppressed by the dedupe set.
        // Reporting happens in settlePersist, which knows whether the caller is still listening.
        persistedTurns.delete(key);
        throw error;
      });
  }

  /**
   * Resolves the pending write according to `awaitPersist`, reporting a failure either way.
   *
   * The fire-and-forget branch attaches its own `.catch` rather than leaving the rejection loose:
   * an unhandled promise rejection terminates a Node process by default, which would make a memory
   * outage exactly the fatal event this integration exists to prevent.
   */
  async function settlePersist(
    pending: Promise<void> | undefined,
    userId: string,
  ): Promise<void> {
    if (pending == null) {
      return;
    }
    if (options.awaitPersist === true) {
      try {
        await pending;
      } catch (error) {
        report(error, { phase: "persist", userId });
      }
      return;
    }
    void pending.catch((error: unknown) => {
      report(error, { phase: "persist", userId }, false);
    });
  }

  return {
    async transformParams({ params }) {
      const request = readRequestOptions(params.providerOptions);
      const userId = resolver.resolveUserId(request.userId);
      const enabled = request.recall ?? recallEnabled;

      if (!enabled || userId == null) {
        return params;
      }

      const query = lastUserText(params.prompt);
      if (!query) {
        return params;
      }

      try {
        const client = resolver.resolve(userId);
        const hits = await recall(
          client,
          userId,
          query,
          request.sessionId ?? options.sessionId,
          params.abortSignal,
        );
        if (hits.length === 0) {
          return params;
        }
        return {
          ...params,
          prompt: injectSystemMemories(params.prompt, format(hits, { query, userId })),
        };
      } catch (error) {
        report(error, { phase: "recall", userId });
        return params;
      }
    },

    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();

      const request = readRequestOptions(params.providerOptions);
      const userId = resolver.resolveUserId(request.userId);
      const enabled = request.persist ?? persistEnabled;

      if (!enabled || userId == null) {
        return result;
      }
      if (unifiedFinishReason(result) === "tool-calls") {
        // Mid-loop: the model asked for a tool, so this turn is not finished yet.
        return result;
      }

      let pending: Promise<void> | undefined;
      try {
        const client = resolver.resolve(userId);
        pending = persist(
          client,
          userId,
          request.sessionId ?? options.sessionId,
          lastUserText(params.prompt),
          assistantText(result.content as LanguageModelGenerateResult["content"]),
        );
      } catch (error) {
        // Synchronous failures only (client construction); the write itself settles below, so
        // keeping the two apart is what stops a single failure being reported twice.
        report(error, { phase: "persist", userId });
        return result;
      }
      await settlePersist(pending, userId);

      return result;
    },

    async wrapStream({ doStream, params }) {
      const { stream, ...rest } = await doStream();

      const request = readRequestOptions(params.providerOptions);
      const userId = resolver.resolveUserId(request.userId);
      const enabled = request.persist ?? persistEnabled;

      if (!enabled || userId == null) {
        return { stream, ...rest };
      }

      let text = "";
      let finishReason: string | undefined;

      const capture = new TransformStream<LanguageModelStreamPart, LanguageModelStreamPart>({
        transform(part, controller) {
          const typed = part as { type: string; delta?: unknown; finishReason?: unknown };
          if (typed.type === "text-delta" && typeof typed.delta === "string") {
            text += typed.delta;
          } else if (typed.type === "finish") {
            finishReason = unifiedFinishReason(typed as { finishReason: unknown });
          }
          controller.enqueue(part);
        },
        async flush() {
          if (finishReason === "tool-calls") {
            return;
          }
          let pending: Promise<void> | undefined;
          try {
            const client = resolver.resolve(userId);
            pending = persist(
              client,
              userId,
              request.sessionId ?? options.sessionId,
              lastUserText(params.prompt),
              text.trim(),
            );
          } catch (error) {
            report(error, { phase: "persist", userId });
            return;
          }
          await settlePersist(pending, userId);
        },
      });

      return { stream: stream.pipeThrough(capture), ...rest };
    },
  };
}
