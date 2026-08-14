import type { ChatMessage, SearchHit, SearchOptions } from "@cortadel/sdk";
import type { CoreMessageV4, MastraDBMessage } from "@mastra/core/agent/message-list";
import type {
  ProcessInputArgs,
  ProcessInputResult,
  ProcessOutputResultArgs,
  Processor,
} from "@mastra/core/processors";

import { DEFAULT_MEMORY_HEADER, formatMemoryBlock, latestTextByRole } from "./format.js";
import { CortadelClientPool } from "./pool.js";
import { mergeScopes, resolveUserId, scopeFromMessages, scopeFromRequestContext } from "./scope.js";
import type { CortadelConnectionOptions, CortadelErrorContext, CortadelScope } from "./types.js";

/** Options for {@link CortadelMemoryProcessor}. */
export interface CortadelMemoryProcessorOptions extends CortadelConnectionOptions {
  /** Processor id. Must be unique within an agent. Default `"cortadel-memory"`. */
  id?: string;
  /** Recall memories and inject them before the model call. Default `true`. */
  recall?: boolean;
  /** Persist the finished turn with `addConversation`. Default `true`. */
  persist?: boolean;
  /** How many memories to recall per turn (Cortadel allows 1–50). Default `5`. */
  topK?: number;
  /** Cortadel search mode. Default `"hybrid"`. */
  searchMode?: "hybrid" | "text" | "vector";
  /** Rerank recalled memories with the server's cross-encoder. Default `false`. */
  rerank?: boolean;
  /** Restrict recall to one cognitive type: `episodic` | `semantic` | `procedural`. */
  memoryType?: string;
  /**
   * Recall only memories written in the current thread — Mastra's `threadId`,
   * which this package stores as Cortadel's `sessionId`. Default `false`:
   * long-term memory is supposed to cross conversations.
   */
  scopeRecallToSession?: boolean;
  /** Skip recall when the user's message is shorter than this. Default `3`. */
  minQueryLength?: number;
  /** Never inject the same memory twice in one thread. Default `true`. */
  dedupeAcrossTurns?: boolean;
  /** Memory ids remembered per thread for deduplication. Default `200`. */
  maxTrackedPerThread?: number;
  /** Threads tracked for deduplication before the oldest is dropped. Default `256`. */
  maxTrackedThreads?: number;
  /** Heading placed above the injected bullets. */
  header?: string;
  /** Abort recall after this many ms so a slow memory server can't stall a turn. Default `5000`; `0` disables. */
  recallTimeoutMs?: number;
  /** Abort the persist call after this many ms. Default `10000`; `0` disables. */
  persistTimeoutMs?: number;
  /**
   * Block the turn's completion on the persist call. Default `true` — unlike
   * the other Cortadel integrations, which fire-and-forget.
   *
   * `processOutputResult` is the last thing Mastra runs for a turn, and a Mastra
   * agent is routinely deployed to a serverless host (Cloudflare Workers,
   * Vercel, Netlify — Mastra ships deployers for all three) where the runtime is
   * free to freeze or kill the isolate as soon as the response is returned. A
   * promise nobody awaited is exactly what dies there, silently losing the
   * memory. Set `false` on a long-lived server if you would rather not pay the
   * write latency on the turn.
   *
   * Either way a turn is written at most once: the duplicate-turn latch is
   * claimed when the write starts and only made permanent when it succeeds, so
   * a failed write leaves an identical retried turn free to be written again.
   */
  awaitPersist?: boolean;
  /** Cortadel project scope stamped on stored facts (e.g. a repo name). */
  project?: string;
  /** Tags applied to every stored fact. */
  tags?: string[];
  /** Extract facts about the assistant instead of the user. Default `false`. */
  isAgentMemory?: boolean;
  /** Share one client pool with the tools. Ignored when absent. */
  pool?: CortadelClientPool;
}

const DEFAULTS = {
  id: "cortadel-memory",
  topK: 5,
  searchMode: "hybrid" as const,
  minQueryLength: 3,
  maxTrackedPerThread: 200,
  maxTrackedThreads: 256,
  recallTimeoutMs: 5_000,
  persistTimeoutMs: 10_000,
};

function defaultOnError(error: unknown, context: CortadelErrorContext): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[cortadel/mastra] ${context.operation} failed: ${message}`);
}

/**
 * Cheap non-cryptographic hash, used only to spot an identical repeat turn.
 *
 * It walks UTF-16 **code units** on purpose, and `charCodeAt` is the right call
 * here rather than `codePointAt`. FNV-1a is defined over a stream of small
 * words — one mixing round per word — so feeding it 16-bit units gives an
 * astral character (emoji, CJK ext.) two rounds of avalanche instead of one,
 * and never XORs bits above 16 that the 32-bit variant's prime was not chosen
 * to diffuse. Splitting a surrogate pair loses nothing, because every unit is
 * consumed: two different strings still produce two different unit streams.
 * Collision quality is the one property that matters — a collision here would
 * make an unrelated turn look like a duplicate and drop it — so the code-unit
 * walk is the better hash, not merely the incumbent one.
 */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function buildSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal | undefined {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timeout && parent) return AbortSignal.any([timeout, parent]);
  return timeout ?? parent;
}

/**
 * The "this turn has already been written" latch, held per thread.
 *
 * It exists to stop one turn being written twice, and it is claimed the moment
 * the write *starts* — not when it finishes — because a concurrent identical
 * call must not be allowed to issue a second write while the first is still in
 * the air. What it must never do is outlive a write that failed: the latch is
 * released again on failure so an identical retried turn is re-attempted rather
 * than silently swallowed.
 */
interface PersistLatch {
  /** Dedupe signature of the turn this latch covers. */
  readonly signature: string;
  /** The write while it is in flight; `undefined` once it has succeeded. */
  inFlight?: Promise<void>;
}

/**
 * Automatic Cortadel memory for a Mastra agent.
 *
 * Implements Mastra's `Processor` interface
 * (`@mastra/core/processors`, `Processor` — `processInput` /
 * `processOutputResult`). Register the **same instance** in both arrays:
 *
 * ```ts
 * const memory = new CortadelMemoryProcessor({ baseUrl, userId });
 * new Agent({ ..., inputProcessors: [memory], outputProcessors: [memory] });
 * ```
 *
 * - `processInput` searches Cortadel with the latest user message and appends
 *   one system message containing the hits.
 * - `processOutputResult` stores the finished turn with `addConversation`, so
 *   the server's extraction pipeline distills durable facts from it.
 *
 * Every Cortadel call is time-boxed and wrapped: a slow or unreachable memory
 * server degrades the agent to no-memory, it never fails the run — unless you
 * opt into `throwOnError`.
 */
export class CortadelMemoryProcessor implements Processor {
  readonly id: string;
  readonly name = "Cortadel memory";
  readonly description =
    "Recalls long-term memories from Cortadel before the model call and persists the finished turn after it.";

  readonly #options: CortadelMemoryProcessorOptions;
  readonly #pool: CortadelClientPool;
  readonly #injected = new Map<string, Set<string>>();
  readonly #lastPersisted = new Map<string, PersistLatch>();
  #warnedMissingUser = false;

  constructor(options: CortadelMemoryProcessorOptions = {}) {
    this.#options = options;
    this.#pool = options.pool ?? new CortadelClientPool(options);
    this.id = options.id ?? DEFAULTS.id;
  }

  /** Search Cortadel and append the hits as a system message. */
  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    if (this.#options.recall === false) return args.messages;

    const scope = this.#scope(args.messages, args.requestContext);
    const userId = this.#userId(scope);
    if (!userId) return args.messages;

    const query = this.#query(args);
    if (query.length < (this.#options.minQueryLength ?? DEFAULTS.minQueryLength)) return args.messages;

    let hits: SearchHit[];
    try {
      const searchOptions: SearchOptions = {
        topK: this.#options.topK ?? DEFAULTS.topK,
        mode: this.#options.searchMode ?? DEFAULTS.searchMode,
        ...(this.#options.rerank ? { rerank: "cross_encoder" } : {}),
        ...(this.#options.memoryType ? { memoryType: this.#options.memoryType } : {}),
        ...(this.#options.scopeRecallToSession && scope.threadId
          ? { sessionId: scope.threadId }
          : {}),
      };
      const results = await this.#pool
        .get(userId)
        .search(
          query,
          searchOptions,
          buildSignal(this.#options.recallTimeoutMs ?? DEFAULTS.recallTimeoutMs, args.abortSignal),
        );
      hits = results.results ?? [];
    } catch (error) {
      this.#report(error, { operation: "recall", userId, threadId: scope.threadId });
      return args.messages;
    }

    const fresh = this.#filterAlreadyInjected(userId, scope.threadId, hits);
    const block = formatMemoryBlock(fresh, this.#options.header ?? DEFAULT_MEMORY_HEADER);
    if (!block) return args.messages;

    const systemMessage: CoreMessageV4 = { role: "system", content: block };
    return { messages: args.messages, systemMessages: [...args.systemMessages, systemMessage] };
  }

  /** Persist the finished turn so Cortadel can extract durable facts from it. */
  async processOutputResult(args: ProcessOutputResultArgs): Promise<MastraDBMessage[]> {
    if (this.#options.persist === false) return args.messages;

    const scope = this.#scope(args.messages, args.requestContext);
    const userId = this.#userId(scope);
    if (!userId) return args.messages;

    const userText = this.#query(args);
    const assistantText = (args.result?.text ?? "").trim();
    if (!userText && !assistantText) return args.messages;

    const key = this.#threadKey(userId, scope.threadId);
    const signature = fnv1a(`${userText}\u0000${assistantText}`);
    const context: CortadelErrorContext = { operation: "persist", userId, threadId: scope.threadId };

    const held = this.#lastPersisted.get(key);
    if (held?.signature === signature) {
      // Already written — an identical repeat is a no-op…
      if (!held.inFlight) return args.messages;
      // …or a concurrent identical call arrived while the first write is still
      // in the air. Either way there must be no second write. When we await,
      // join the write already running, so this caller's turn really has landed
      // (or really has failed) by the time it returns; a fire-and-forget caller
      // has nothing to wait on, so it just drops the turn.
      if (this.#options.awaitPersist === false) return args.messages;
      await this.#observe(held.inFlight, context);
      return args.messages;
    }

    const messages: ChatMessage[] = [];
    if (userText) messages.push({ role: "user", content: userText });
    if (assistantText) messages.push({ role: "assistant", content: assistantText });

    // Claim the latch for the duration of the write, then settle it by outcome.
    // The identity check is what makes that safe: if a different turn — or a
    // later retry of this one — has replaced the entry meanwhile, this write's
    // outcome must not touch it.
    const latch: PersistLatch = { signature };
    this.#remember(this.#lastPersisted, key, latch);
    const write = this.#write(userId, scope, messages, args.abortSignal).then(
      () => {
        // Written. The latch becomes permanent: repeats are now skipped.
        if (this.#lastPersisted.get(key) === latch) latch.inFlight = undefined;
      },
      (error: unknown) => {
        // Not written. Release the latch so an identical retried turn is
        // re-attempted instead of being mistaken for a duplicate and lost.
        // (If the write did land server-side and only the response was lost,
        // the retry is a duplicate — which Cortadel's own dedup pipeline
        // collapses. Losing the memory outright has no such remedy.)
        if (this.#lastPersisted.get(key) === latch) this.#lastPersisted.delete(key);
        throw error;
      },
    );
    latch.inFlight = write;

    if (this.#options.awaitPersist === false) {
      // Fire-and-forget still gets a catch — an unhandled rejection would take
      // the host process down, which is exactly what memory must never do. The
      // latch is settled by the handlers above either way, so a failed write
      // stays retryable here too; it just cannot be reported to a caller that
      // has already returned.
      void this.#observe(write, context).catch(() => {});
    } else {
      await this.#observe(write, context);
    }
    return args.messages;
  }

  /** Perform the write. Rejects on failure — reporting is the caller's job. */
  async #write(
    userId: string,
    scope: CortadelScope,
    messages: ChatMessage[],
    parentSignal?: AbortSignal,
  ): Promise<void> {
    await this.#pool.get(userId).addConversation(
      messages,
      {
        ...(scope.threadId ? { sessionId: scope.threadId } : {}),
        ...(this.#options.project ? { project: this.#options.project } : {}),
        ...(this.#options.tags ? { tags: this.#options.tags } : {}),
        ...(this.#options.isAgentMemory ? { isAgentMemory: true } : {}),
      },
      buildSignal(this.#options.persistTimeoutMs ?? DEFAULTS.persistTimeoutMs, parentSignal),
    );
  }

  /**
   * Await a write and report its failure. Rethrows only under `throwOnError`,
   * which is what the shared reporter does. Two callers sharing one in-flight
   * write each report it — both their turns went unpersisted.
   */
  async #observe(write: Promise<void>, context: CortadelErrorContext): Promise<void> {
    try {
      await write;
    } catch (error) {
      this.#report(error, context);
    }
  }

  #scope(messages: readonly unknown[] | undefined, requestContext: unknown): CortadelScope {
    const fromContext = scopeFromRequestContext(
      requestContext as { get(key: string): unknown } | undefined,
    );
    return mergeScopes(fromContext, scopeFromMessages(messages), {
      requestContext: requestContext as { get(key: string): unknown } | undefined,
    });
  }

  #userId(scope: CortadelScope): string | undefined {
    const userId = resolveUserId(scope, this.#options);
    if (userId) return userId;

    const error = new Error(
      "no Cortadel user id for this run — pass `userId`, a `resolveUserId` function, " +
        "or call the agent with a `resourceId`. Memory is disabled until then.",
    );
    if (this.#warnedMissingUser) {
      // The warning fires once, but `throwOnError` must not go quiet after it:
      // every later run is just as broken as the first.
      if (this.#options.throwOnError) throw error;
      return undefined;
    }
    this.#warnedMissingUser = true;
    this.#report(error, { operation: "resolve-user-id" });
    return undefined;
  }

  #query(args: { messageList?: unknown; messages?: readonly unknown[] }): string {
    const list = args.messageList as { getLatestUserContent?: () => string | null } | undefined;
    try {
      const latest = list?.getLatestUserContent?.()?.trim();
      if (latest) return latest;
    } catch {
      // Fall through to reading the raw messages.
    }
    return latestTextByRole(args.messages, "user");
  }

  #threadKey(userId: string, threadId: string | undefined): string {
    return `${userId}\u0000${threadId ?? "-"}`;
  }

  #filterAlreadyInjected(userId: string, threadId: string | undefined, hits: SearchHit[]): SearchHit[] {
    if (this.#options.dedupeAcrossTurns === false) return hits;

    const key = this.#threadKey(userId, threadId);
    const seen = this.#injected.get(key) ?? new Set<string>();
    const fresh = hits.filter((hit) => hit.id && !seen.has(hit.id));
    if (fresh.length === 0) return fresh;

    for (const hit of fresh) seen.add(hit.id);

    const limit = this.#options.maxTrackedPerThread ?? DEFAULTS.maxTrackedPerThread;
    if (seen.size > limit) {
      const overflow = seen.size - limit;
      let dropped = 0;
      for (const id of seen) {
        if (dropped >= overflow) break;
        seen.delete(id);
        dropped += 1;
      }
    }
    this.#remember(this.#injected, key, seen);
    return fresh;
  }

  /** Insert into a bounded, LRU-ordered map. */
  #remember<V>(store: Map<string, V>, key: string, value: V): void {
    store.delete(key);
    store.set(key, value);
    const limit = this.#options.maxTrackedThreads ?? DEFAULTS.maxTrackedThreads;
    while (store.size > limit) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }

  #report(error: unknown, context: CortadelErrorContext): void {
    try {
      (this.#options.onError ?? defaultOnError)(error, context);
    } catch {
      // An error reporter must never break the run either.
    }
    // Fail-open by default; `throwOnError` opts into "memory is load-bearing".
    if (this.#options.throwOnError) throw error;
  }
}
