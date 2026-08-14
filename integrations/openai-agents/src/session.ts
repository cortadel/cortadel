/**
 * `CortadelSession` — Cortadel long-term memory behind the Agents SDK's `Session` interface.
 *
 * Why this shape
 * --------------
 *
 * The SDK's conversation-history seam is the `Session` interface
 * (`@openai/agents-core/dist/memory/session.d.ts`), whose five required members are
 * `getSessionId`, `getItems`, `addItems`, `popItem` and `clearSession`. Note that this is *not*
 * the same surface as the Python SDK's `Session` protocol: TypeScript adds `getSessionId()`, and
 * `popItem()` resolves to `undefined` rather than `None`.
 *
 * But a `Session` is a **verbatim transcript store**, and Cortadel is not one. The runner
 * round-trips items through it and reconciles them against what the model actually saw
 * (`@openai/agents-core/dist/runner/sessionPersistence.d.ts`: `createSessionPersistenceTracker`,
 * `prepareInputItemsWithSession`, `saveToSession`). Cortadel deliberately does not store
 * transcripts: it distils conversations into deduplicated facts, so two identical turns collapse
 * into one and item order is not preserved. Backing `getItems`/`popItem` with Cortadel would
 * corrupt the run loop.
 *
 * So `CortadelSession` is a **wrapper session**. It holds a *transcript* session (the SDK's own
 * `MemorySession` by default, or any `Session` you pass) for exact short-term fidelity, and
 * layers long-term memory on top:
 *
 * * `addItems` → also distils the turn into Cortadel via `addConversation` (**store**)
 * * {@link CortadelSession.callModelInputFilter} → searches Cortadel and injects the hits into the
 *   model call (**recall**)
 *
 * Why recall is a `callModelInputFilter` and not `getItems`
 * --------------------------------------------------------
 *
 * `getItems()` takes no query, and the runner calls it *before* the new turn's input exists. On
 * the very first turn there is nothing at all to search on. `callModelInputFilter` runs
 * immediately before each model call with the full input in hand — "Invoked immediately before
 * calling the model, allowing callers to edit the system instructions or input items that will be
 * sent to the model" (`run.d.ts`) — and the runner tracks the filter's output separately from what
 * it persists, so the injected block is **ephemeral**: context never accumulates memories turn
 * after turn.
 *
 * Hooks (`agent.on('agent_start', …)`, `runner.on(…)`) were the other candidate and are the wrong
 * one: `AgentHookEvents`/`RunHookEvents` in `lifecycle.d.ts` are observation-only — listeners
 * return `void` and the emitter ignores them, so nothing a hook does can reach the model input.
 */

import { MemorySession } from '@openai/agents';
import type {
  AgentInputItem,
  CallModelInputFilter,
  CallModelInputFilterArgs,
  ModelInputData,
  Session,
  Tool,
} from '@openai/agents';
import type { ChatMessage, CortadelClient, ConversationOptions, SearchOptions } from '@cortadel/sdk';

import { lastUserIndex, lastUserText, messagePairs } from './items.js';
import {
  DEFAULT_APP_NAME,
  DEFAULT_MEMORY_HEADER,
  buildClient,
  callSafely,
  filterHits,
  formatMemoryBlock,
  headerAlreadyPresent,
  type CortadelConnectionOptions,
  type ErrorOptions,
  type RecallOptions,
} from './memory.js';
import { cortadelMemoryTools } from './tools.js';

/**
 * Where the recalled-memory block is placed in the model call.
 *
 * * `"instructions"` appends it to the system prompt — the plainest reading of the SDK's own
 *   description of this filter, and unambiguous for the model.
 * * `"input"` inserts it as a system message immediately *before* the latest user message. That
 *   leaves the instructions and the earlier history byte-identical between turns, so a provider's
 *   prompt-prefix cache still hits, and it puts the facts next to the question.
 */
export type InjectionSite = 'instructions' | 'input';

/** The two run options this session needs installed. See {@link CortadelSession.runOptions}. */
export interface CortadelRunOptions {
  session: Session;
  callModelInputFilter: CallModelInputFilter;
}

/** Options for {@link CortadelSession}. */
export interface CortadelSessionOptions
  extends CortadelConnectionOptions,
    RecallOptions,
    ErrorOptions {
  /**
   * Conversation identifier. Used as the transcript's key, returned from `getSessionId()`, and
   * sent to Cortadel as `ConversationOptions.sessionId` so recalled facts stay groupable by
   * conversation.
   */
  sessionId: string;
  /**
   * The memory namespace owner. A Cortadel client is bound to one user id at construction, so one
   * `CortadelSession` serves exactly one user — never share an instance across users.
   */
  userId: string;
  /**
   * A pre-built `CortadelClient` to use instead of constructing one. It must already be scoped to
   * `userId`.
   */
  client?: CortadelClient;
  /**
   * The `Session` that holds verbatim history. Defaults to the SDK's own in-memory
   * `MemorySession`; pass a durable `Session` to survive restarts.
   */
  transcript?: Session;
  /** Number of memories to recall per turn. Defaults to `5`. */
  topK?: number;
  /**
   * Restrict recall to facts extracted from *this* conversation (`SearchOptions.sessionId`). Off
   * by default — the point of long-term memory is that it crosses conversations.
   */
  scopeRecallToSession?: boolean;
  /** See {@link InjectionSite}. Defaults to `"instructions"`. */
  injectAs?: InjectionSite;
  /** Heading of the injected block; also the marker used to avoid double-injection. */
  memoryHeader?: string;
  /** Set `false` to disable recall while keeping storage. */
  retrieve?: boolean;
  /** Set `false` to disable storage while keeping recall (a read-only agent). */
  store?: boolean;
  /**
   * Await the write before the turn returns. Defaults to `false` (fire-and-forget) so Cortadel's
   * extraction latency stays off the turn. See the README for when to turn it on.
   */
  awaitPersist?: boolean;
  /** Tags applied to every fact extracted from this conversation. */
  tags?: string[];
  /** Project scope applied to every fact extracted from this conversation. */
  project?: string;
}

/**
 * A `Session` that keeps short-term history locally and long-term memory in Cortadel.
 *
 * Wire both halves into a run:
 *
 * ```ts
 * const session = new CortadelSession({ sessionId: 'chat-1', userId: 'e2e-alice' });
 * const result = await run(agent, 'What editor do I use?', session.runOptions());
 * ```
 *
 * Passing only `{ session }` still stores memories and keeps history; recall additionally needs
 * `callModelInputFilter`, which {@link CortadelSession.runOptions} installs for you.
 */
export class CortadelSession implements Session {
  readonly sessionId: string;
  readonly userId: string;
  readonly client: CortadelClient;

  topK: number;
  searchMode: string;
  rerank: string | undefined;
  minScore: number | undefined;
  scopeRecallToSession: boolean;
  injectAs: InjectionSite;
  memoryHeader: string;
  retrieve: boolean;
  store: boolean;
  awaitPersist: boolean;
  tags: string[] | undefined;
  project: string | undefined;
  throwOnError: boolean;
  onError: ((error: unknown) => unknown) | undefined;

  /**
   * A `CallModelInputFilter` bound to this session, with a stable identity across property reads.
   *
   * Assign it to `run(..., { callModelInputFilter })` or to `RunConfig.callModelInputFilter`, or
   * use {@link CortadelSession.runOptions}.
   */
  readonly callModelInputFilter: CallModelInputFilter;

  private readonly transcript: Session;
  private readonly ownsTranscript: boolean;

  /**
   * Messages seen since the last flush. Held until the assistant speaks so a turn reaches
   * Cortadel as a coherent user→assistant exchange rather than two half-exchanges.
   */
  private pending: ChatMessage[] = [];

  /**
   * One-entry search cache, invalidated whenever the conversation advances. The filter runs once
   * per model call, so without it a tool-using turn would search Cortadel repeatedly for the same
   * unchanged question.
   */
  private cachedQuery: string | undefined = undefined;
  private cachedBlock = '';

  /**
   * In-flight background writes when `awaitPersist` is false. Held so {@link flush} and
   * {@link close} can drain them.
   */
  private readonly persistTasks = new Set<Promise<void>>();

  constructor(options: CortadelSessionOptions) {
    if (!options?.sessionId) {
      throw new Error('CortadelSessionOptions.sessionId is required.');
    }
    if (!options.userId) {
      throw new Error('CortadelSessionOptions.userId is required.');
    }
    const injectAs = options.injectAs ?? 'instructions';
    if (injectAs !== 'instructions' && injectAs !== 'input') {
      throw new Error(
        `CortadelSessionOptions.injectAs must be "instructions" or "input", got: ${String(injectAs)}`,
      );
    }

    this.sessionId = options.sessionId;
    this.userId = options.userId;

    this.client =
      options.client ??
      buildClient(options.userId, {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        appName: options.appName ?? DEFAULT_APP_NAME,
      });

    this.ownsTranscript = options.transcript === undefined;
    this.transcript = options.transcript ?? new MemorySession({ sessionId: options.sessionId });

    this.topK = options.topK ?? 5;
    this.searchMode = options.searchMode ?? 'hybrid';
    this.rerank = options.rerank;
    this.minScore = options.minScore;
    this.scopeRecallToSession = options.scopeRecallToSession ?? false;
    this.injectAs = injectAs;
    this.memoryHeader = options.memoryHeader ?? DEFAULT_MEMORY_HEADER;
    this.retrieve = options.retrieve ?? true;
    this.store = options.store ?? true;
    this.awaitPersist = options.awaitPersist ?? false;
    this.tags = options.tags;
    this.project = options.project;
    this.throwOnError = options.throwOnError ?? false;
    this.onError = options.onError;

    // Bound once so the property has a stable identity — a method reference read twice would
    // otherwise be two different function objects, which defeats identity comparisons and any
    // de-duplication a caller might do across run options.
    this.callModelInputFilter = (args) => this.filterModelInput(args);
  }

  // ------------------------------------------------------------------
  // Session interface — verbatim history, delegated to the transcript
  // ------------------------------------------------------------------

  /** Part of the `Session` interface. Returns the id this session was constructed with. */
  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  /**
   * Return conversation history. Pure passthrough — no memories are mixed in here.
   *
   * Recall deliberately happens in {@link callModelInputFilter} instead. Injecting into
   * `getItems` would put synthetic items into the list the runner reconciles and persists.
   */
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.transcript.getItems(limit);
  }

  /** Append items to history, and distil the exchange into Cortadel once complete. */
  async addItems(items: AgentInputItem[]): Promise<void> {
    // Strip our own recall block before anything is written down. This matters: unlike the
    // Python SDK — where `call_model_input_filter` receives a copy that is thrown away — the
    // TypeScript runner *persists* what the filter produced. `applyCallModelInputFilter` returns
    // `persistedItems` ("the normalized clones we should commit to session memory so the stored
    // history reflects … any redactions or truncation from the filter",
    // `runner/conversation.d.ts`) and tags filter-added items `'injected'` in `sourceMatchKinds`.
    // Left alone, an `injectAs: "input"` block would land in the transcript, be replayed as
    // history next turn, and trip the double-injection guard so fresh recall never happened.
    const persistable = items.filter((item) => !this.isInjectedMemoryItem(item));

    await this.transcript.addItems(persistable);

    // New turn content invalidates the recall cache: the next question deserves a fresh search,
    // and it may now match the fact we are about to store.
    this.invalidateRecallCache();

    if (!this.store) {
      return;
    }

    const pairs = messagePairs(persistable);
    if (pairs.length === 0) {
      return;
    }

    this.pending.push(...pairs.map((pair) => ({ role: pair.role, content: pair.text })));

    if (pairs.some((pair) => pair.role === 'assistant')) {
      if (this.awaitPersist) {
        await this.flush();
      } else {
        this.persistInBackground();
      }
    }
  }

  /**
   * Remove and return the most recent history item.
   *
   * If the popped item is still sitting unflushed in the pending buffer it is dropped too, so a
   * rewound turn is never stored. Facts already written to Cortadel are **not** deleted — the
   * store is bi-temporal and supersedes rather than erases.
   */
  async popItem(): Promise<AgentInputItem | undefined> {
    const item = await this.transcript.popItem();
    if (item === undefined) {
      return undefined;
    }

    const pairs = messagePairs([item]);
    const last = this.pending.at(-1);
    const popped = pairs.at(-1);
    if (last && popped && last.role === popped.role && last.content === popped.text) {
      this.pending.pop();
    }
    return item;
  }

  /**
   * Clear the conversation transcript and any unflushed buffer.
   *
   * Long-term memories in Cortadel survive: clearing a chat window is not a request to forget the
   * user. Delete memories explicitly with `client.delete([...])` if that is what you want.
   */
  async clearSession(): Promise<void> {
    await this.transcript.clearSession();
    this.pending = [];
    this.invalidateRecallCache();
  }

  // ------------------------------------------------------------------
  // Storage
  // ------------------------------------------------------------------

  /**
   * Send everything this session still owes Cortadel, and wait for it to land.
   *
   * That is any background write started under `awaitPersist: false` plus the current buffer: an
   * awaited `flush()` is a hard synchronisation point, whatever `awaitPersist` says. Called
   * automatically once the assistant replies when `awaitPersist` is on. Call it yourself before a
   * process exits, or before a serverless handler returns, so a fire-and-forget write cannot be
   * frozen mid-flight.
   */
  async flush(): Promise<void> {
    await this.drainBackgroundPersists();
    await this.writePending(this.throwOnError);
  }

  /**
   * Flush pending memories, then release anything this session created itself.
   *
   * The Cortadel TypeScript client holds no long-lived resource and has no `close()`, so this is
   * a flush plus an optional transcript teardown: a transcript *you* passed in is yours to close;
   * only a default this session built is closed here (and the SDK's `MemorySession` has nothing
   * to close either).
   */
  async close(): Promise<void> {
    await this.flush();
    if (!this.ownsTranscript) {
      return;
    }
    const closer = (this.transcript as { close?: () => unknown }).close;
    if (typeof closer === 'function') {
      await closer.call(this.transcript);
    }
  }

  private async writePending(throwOnError: boolean): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }

    // Clear before awaiting: a failure drops the batch rather than retrying it forever and
    // growing without bound while the server is down.
    const batch = this.pending;
    this.pending = [];

    const conversationOptions: ConversationOptions = {
      sessionId: this.sessionId,
      ...(this.tags ? { tags: this.tags } : {}),
      ...(this.project ? { project: this.project } : {}),
    };

    await callSafely(() => this.client.addConversation(batch, conversationOptions), {
      description: 'addConversation',
      throwOnError,
      fallback: undefined,
      ...(this.onError ? { onError: this.onError } : {}),
    });
  }

  /**
   * Start the write without waiting for it (`awaitPersist: false`).
   *
   * `throwOnError` is deliberately forced off here: nothing awaits this promise, so a rejection
   * would surface as an unhandled rejection — which in Node crashes the process. Failures reach
   * `onError` (or the log) exactly as they do in the fail-open case.
   */
  private persistInBackground(): void {
    const task = this.writePending(false).finally(() => {
      this.persistTasks.delete(task);
    });
    this.persistTasks.add(task);
  }

  private async drainBackgroundPersists(): Promise<void> {
    const tasks = [...this.persistTasks];
    this.persistTasks.clear();
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  // ------------------------------------------------------------------
  // Recall
  // ------------------------------------------------------------------

  /**
   * Run options with both halves installed: this session as `session`, and its recall filter as
   * `callModelInputFilter`.
   *
   * `base` is copied rather than mutated, so your other run settings survive:
   *
   * ```ts
   * await run(agent, 'hi', session.runOptions({ maxTurns: 5 }));
   * ```
   */
  runOptions<T extends object>(base?: T): T & CortadelRunOptions {
    if (base && (base as Partial<CortadelRunOptions>).callModelInputFilter) {
      // A run takes exactly one filter, so this one wins. Say so rather than letting the
      // caller's filter vanish silently.
      console.warn(
        '[cortadel-openai-agents] Replacing the callModelInputFilter on the supplied run options ' +
          "with Cortadel's. Compose them yourself if you need both.",
      );
    }
    return {
      ...((base ?? {}) as T),
      session: this,
      callModelInputFilter: this.callModelInputFilter,
    };
  }

  /**
   * Memory tools bound to this session's client, for agents that call memory explicitly.
   *
   * The session's own retrieval settings are inherited, so a tool call and an automatic recall
   * see the same memories. That includes `topK`: these tools therefore default to **5**, this
   * session's default, not the 10 a standalone `cortadelMemoryTools()` uses.
   */
  tools(): Tool[] {
    return cortadelMemoryTools({
      client: this.client,
      topK: this.topK,
      searchMode: this.searchMode,
      ...(this.rerank ? { rerank: this.rerank } : {}),
      ...(this.minScore !== undefined ? { minScore: this.minScore } : {}),
      ...(this.scopeRecallToSession ? { sessionId: this.sessionId } : {}),
      throwOnError: this.throwOnError,
      ...(this.onError ? { onError: this.onError } : {}),
    });
  }

  private invalidateRecallCache(): void {
    this.cachedQuery = undefined;
    this.cachedBlock = '';
  }

  /** Whether `item` is a recall block this session injected (`injectAs: "input"`). */
  private isInjectedMemoryItem(item: AgentInputItem): boolean {
    const record = item as { role?: unknown; content?: unknown };
    return (
      record.role === 'system' &&
      typeof record.content === 'string' &&
      record.content.startsWith(this.memoryHeader)
    );
  }

  private async filterModelInput(args: CallModelInputFilterArgs): Promise<ModelInputData> {
    const { modelData } = args;
    if (!this.retrieve) {
      return modelData;
    }

    const items = [...modelData.input];
    const query = lastUserText(items);
    if (!query) {
      // Nothing to search on (an image-only or tool-only turn). Leave the call untouched.
      return modelData;
    }

    const haystacks: unknown[] = [
      modelData.instructions,
      ...items.map((item) => (item as { content?: unknown }).content),
    ];
    if (headerAlreadyPresent(this.memoryHeader, haystacks)) {
      return modelData;
    }

    const block = await this.recall(query);
    if (!block) {
      return modelData;
    }

    if (this.injectAs === 'instructions') {
      return {
        input: items,
        instructions: modelData.instructions ? `${modelData.instructions}\n\n${block}` : block,
      };
    }

    // `??`, not `||`: index 0 is a legitimate insertion point (the user message is first), and
    // `||` would mistake it for "no user message" and append at the end instead.
    const position = lastUserIndex(items) ?? items.length;
    const memoryItem: AgentInputItem = { role: 'system', content: block };
    return {
      input: [...items.slice(0, position), memoryItem, ...items.slice(position)],
      ...(modelData.instructions !== undefined ? { instructions: modelData.instructions } : {}),
    };
  }

  private async recall(query: string): Promise<string> {
    if (this.cachedQuery === query) {
      return this.cachedBlock;
    }

    const searchOptions: SearchOptions = {
      topK: this.topK,
      mode: this.searchMode,
      ...(this.rerank ? { rerank: this.rerank } : {}),
      ...(this.scopeRecallToSession ? { sessionId: this.sessionId } : {}),
    };

    const results = await callSafely(() => this.client.search(query, searchOptions), {
      description: 'search',
      throwOnError: this.throwOnError,
      fallback: undefined,
      ...(this.onError ? { onError: this.onError } : {}),
    });

    const hits = results ? filterHits(results.results, this.minScore) : [];
    const block = formatMemoryBlock(hits, this.memoryHeader);

    this.cachedQuery = query;
    this.cachedBlock = block;
    return block;
  }
}
