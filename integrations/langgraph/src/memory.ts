/**
 * Automatic memory: recall before the model, persist after the turn.
 *
 * Two graph nodes, so the agent gets long-term memory without ever deciding to call a tool.
 *
 * `recallNode`
 *   Searches Cortadel with the user's latest message and prepends the hits as a `SystemMessage`.
 *   It writes them to **`llmInputMessages`** — the channel `createReactAgent` reads for exactly
 *   this purpose. In the JS implementation that channel is declared in `PreHookAnnotation`
 *   (`libs/langgraph-core/src/prebuilt/react_agent_executor.ts`) with the overwriting reducer
 *   `(_, update) => messagesStateReducer([], update)`, and `getModelInputState` in the same file
 *   does `const { messages, llmInputMessages, ...rest } = state;` and hands the model
 *   `llmInputMessages` **instead of** `messages`. So the recalled block is never appended to the
 *   durable transcript and never accumulates: each hook run replaces the whole channel.
 *
 * `rememberNode`
 *   After the model produces a final answer (not a tool call), hands the new turns to Cortadel's
 *   `addConversation` pipeline, which distils durable facts from them. A per-thread cursor means
 *   each message is submitted at most once, even though the node runs after *every* model call in
 *   a tool loop.
 *
 *   The write is **awaited by default** (`awaitPersist: true`). A graph node has no lifetime of its
 *   own — once the run finishes, LangGraph or its host may tear the process down, so a detached
 *   write would be silently lost. Cortadel's extraction already runs off the request path
 *   server-side, so awaiting costs only the round trip. Set `awaitPersist: false` if you would
 *   rather not pay even that; the floating promise still routes its failure through `onError` (or
 *   the logger), and never through `throwOnError` — by the time it fails the node has returned, so
 *   there is no caller left to throw to.
 *
 * Both nodes are plain `(state, config) => update` async callables, so they work three ways:
 *
 * - as nodes in a hand-built `StateGraph`,
 * - as `preModelHook` / `postModelHook` of `createReactAgent` (whose `CreateReactAgentParams`
 *   types both as `RunnableLike<…, LangGraphRunnableConfig>`, which a bare function satisfies),
 * - through the {@link CortadelMemory.preModelHook} / {@link CortadelMemory.postModelHook}
 *   properties, which are just those bound callables under their LangGraph names. Unlike the
 *   Python leg there is no `RunnableLambda` wrapper here, because JavaScript has no sync/async
 *   split to bridge.
 */
import type { ChatMessage } from "@cortadel/sdk";
import { SystemMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BaseStore, SearchItem } from "@langchain/langgraph-checkpoint";

import { DEFAULT_NAMESPACE, resolveNamespace, type NamespaceLike } from "./namespace.js";
import { ambientStore } from "./runtime.js";
import type { AddConversationOptions, ErrorCallback, StoreLogger } from "./store.js";

/** The sentence that introduces injected memories, unless you replace it. */
export const DEFAULT_RECALL_HEADER =
  "Long-term memory about this user, retrieved from Cortadel. Treat it as background you " +
  "already know; use it when relevant and do not mention that it came from a memory system.";

// Roles Cortadel's conversation-ingest endpoint accepts, keyed by LangChain's message type. Tool
// traffic is deliberately excluded: raw tool payloads are noise the extraction pipeline should not
// be mining for user facts.
const ROLES: Readonly<Record<string, string>> = {
  human: "user",
  user: "user",
  ai: "assistant",
  assistant: "assistant",
  system: "system",
};

const NO_THREAD = "__no_thread__";

/** The slice of {@link CortadelStore} that persistence needs. */
interface ConversationCapableStore extends BaseStore {
  addConversation(
    namespace: string[],
    messages: Iterable<ChatMessage>,
    options?: AddConversationOptions,
  ): Promise<unknown>;
}

/** Options for {@link CortadelMemory}. */
export interface CortadelMemoryOptions {
  /**
   * The store to use. Omit to read the store off the `LangGraphRunnableConfig` each node is called
   * with. Recall works against any `BaseStore`; persistence additionally needs a
   * {@link CortadelStore} (only it has `addConversation`) — which the ambient path finds even
   * though LangGraph hands nodes an `AsyncBatchedStore` wrapper around it.
   */
  store?: BaseStore;
  /**
   * Namespace to recall from and persist to, possibly templated (`["memories", "{userId}"]`);
   * placeholders come from `config.configurable`.
   */
  namespace?: NamespaceLike;
  /** Maximum memories injected per turn. */
  topK?: number;
  /** Sentence introducing the injected memories. */
  header?: string;
  /** State key holding the conversation. */
  messagesKey?: string;
  /**
   * State key the recalled-plus-original message list is written to. The default,
   * `"llmInputMessages"`, is the channel `createReactAgent` swaps in for `messages` when calling
   * the model, so the memory block never joins the durable transcript. Point it at `"messages"`
   * only if you understand that the block then becomes a permanent part of it.
   */
  outputKey?: string;
  /** Set `false` for a read-only agent. */
  persist?: boolean;
  /** Set `false` to persist only. */
  recall?: boolean;
  /**
   * Record the LangGraph `thread_id` as the Cortadel session id on persisted facts, which groups
   * the extracted facts.
   */
  sessionFromThread?: boolean;
  /**
   * Restrict recall to memories from the current thread's session. Off by default — long-term
   * memory that only sees the current thread is just the checkpointer with extra steps.
   */
  scopeRecallToSession?: boolean;
  /** Cortadel project scope recorded on persisted facts. */
  project?: string;
  /** Cortadel tags applied to every persisted fact. */
  tags?: string[];
  /**
   * Await the persistence write before the node returns. Defaults to `true` — see the module
   * docstring; a graph node's process can end the moment the run does.
   */
  awaitPersist?: boolean;
  /**
   * `true` propagates memory failures instead of degrading to "no memory this turn".
   *
   * It cannot apply to a detached write (`awaitPersist: false`): that failure surfaces after the
   * node has returned, so there is no caller to throw to and it is reported through
   * {@link onError} — or the logger — instead.
   */
  throwOnError?: boolean;
  /** Callback invoked with the error whenever a failure is swallowed. Replaces the warning log. */
  onError?: ErrorCallback;
  /** Cap on the per-thread recall cache and persistence cursors. */
  maxTrackedThreads?: number;
  /** Logger to use. Defaults to `console`. */
  logger?: StoreLogger;
}

/**
 * Automatic Cortadel recall and persistence for a LangGraph agent.
 *
 * @example
 * ```ts
 * const memory = new CortadelMemory({ store, namespace: ["memories", "e2e-alice"] });
 * const agent = createReactAgent({
 *   llm,
 *   tools: [],
 *   store,
 *   preModelHook: memory.preModelHook,
 *   postModelHook: memory.postModelHook,
 * });
 * ```
 */
export class CortadelMemory {
  private readonly store?: BaseStore;
  private readonly namespace: NamespaceLike;
  private readonly topK: number;
  private readonly header: string;
  private readonly messagesKey: string;
  private readonly outputKey: string;
  private readonly persist: boolean;
  private readonly recall: boolean;
  private readonly sessionFromThread: boolean;
  private readonly scopeRecallToSession: boolean;
  private readonly project?: string;
  private readonly tags?: string[];
  private readonly awaitPersist: boolean;
  private readonly throwOnError: boolean;
  private readonly onError?: ErrorCallback;
  private readonly maxTracked: number;
  private readonly logger: StoreLogger;

  // thread -> [anchor message id, rendered memory block]. One Cortadel search per user turn: the
  // model is called repeatedly inside a tool loop, but the anchor human message does not change,
  // so the block is reused instead of re-searched.
  private readonly recallCache = new Map<string, [string, string]>();
  // thread -> id of the last message already handed to addConversation.
  private readonly cursors = new Map<string, string>();
  private warnedNoConversation = false;
  private warnedNoStore = false;

  constructor(options: CortadelMemoryOptions = {}) {
    this.store = options.store;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.topK = options.topK ?? 5;
    this.header = options.header ?? DEFAULT_RECALL_HEADER;
    this.messagesKey = options.messagesKey ?? "messages";
    this.outputKey = options.outputKey ?? "llmInputMessages";
    this.persist = options.persist ?? true;
    this.recall = options.recall ?? true;
    this.sessionFromThread = options.sessionFromThread ?? true;
    this.scopeRecallToSession = options.scopeRecallToSession ?? false;
    this.project = options.project;
    this.tags = options.tags;
    this.awaitPersist = options.awaitPersist ?? true;
    this.throwOnError = options.throwOnError ?? false;
    this.onError = options.onError;
    this.maxTracked = options.maxTrackedThreads ?? 256;
    this.logger = options.logger ?? console;
  }

  // ── Recall ──────────────────────────────────────────────────────────────────────────────

  /**
   * Search Cortadel and prepend the results. Use as a node or as `preModelHook`.
   *
   * Declared as a bound arrow property so it can be handed to `addNode` or `preModelHook` without
   * losing `this`.
   */
  recallNode = async (
    state: unknown,
    config?: LangGraphRunnableConfig,
  ): Promise<Record<string, unknown>> => {
    const messages = messagesOf(state, this.messagesKey);
    if (!this.recall || messages.length === 0) return this.inject("", messages);
    const anchorIndex = lastUserIndex(messages);
    if (anchorIndex === undefined) return this.inject("", messages);
    const anchor = messages[anchorIndex];

    const thread = threadId(config);
    const cached = this.cachedBlock(thread, anchor);
    if (cached !== undefined) return this.inject(cached, messages);

    const query = textOf(anchor);
    if (query === "") return this.inject("", messages);
    const store = this.resolveStore(config);
    if (store === undefined) return this.inject("", messages);

    let items: SearchItem[];
    try {
      items = await store.search(resolveNamespace(this.namespace, config), {
        query,
        // `limit` is BaseStore's own option name, not ours — it stays spelled LangGraph's way.
        limit: this.topK,
        filter:
          this.scopeRecallToSession && thread !== NO_THREAD ? { sessionId: thread } : undefined,
      });
    } catch (error) {
      this.handleError("recall", error);
      return this.inject("", messages);
    }
    const block = this.render(items);
    this.cacheBlock(thread, anchor, block);
    return this.inject(block, messages);
  };

  // ── Persistence ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist the completed turn. Use as a node or as `postModelHook`.
   *
   * Returns an empty state update — persistence is a side effect, not graph state.
   */
  rememberNode = async (
    state: unknown,
    config?: LangGraphRunnableConfig,
  ): Promise<Record<string, unknown>> => {
    const plan = this.planPersist(state, config);
    if (plan === undefined) return {};
    const { store, namespace, turns, cursor, thread } = plan;
    const options: AddConversationOptions = {
      sessionId: this.sessionFromThread && thread !== NO_THREAD ? thread : undefined,
      project: this.project,
      tags: this.tags,
    };
    // The cursor advances on dispatch, not on completion: the alternative is that a slow or failed
    // write makes the next model call re-submit the same turns.
    this.advanceCursor(thread, cursor);
    const write = store.addConversation(namespace, turns, options);
    if (this.awaitPersist) {
      try {
        await write;
      } catch (error) {
        this.handleError("addConversation", error);
      }
    } else {
      // Fire-and-forget still has to catch: an unhandled rejection can take a Node process down.
      // `throwOnError` deliberately does not apply here (`onCallPath: false`) — this node has
      // already returned, so there is no caller left to propagate to. Rethrowing would reject the
      // promise `.catch()` returns, which nothing handles, and under Node >= 15's default
      // `--unhandled-rejections=throw` that kills the host process: precisely the outcome this
      // branch exists to prevent. `integrations/vercel-ai-sdk` and `integrations/mastra` draw the
      // same line for their own detached writes.
      void write.catch((error: unknown) => {
        try {
          this.handleError("addConversation", error, false);
        } catch {
          // Reporting must not escape either: a throwing `logger.warn` would land straight back
          // here as the unhandled rejection this whole branch is guarding against.
        }
      });
    }
    return {};
  };

  // ── createReactAgent hooks ──────────────────────────────────────────────────────────────

  /** The recall node under its `createReactAgent` name. */
  get preModelHook(): CortadelMemory["recallNode"] {
    return this.recallNode;
  }

  /** The persistence node under its `createReactAgent` name. */
  get postModelHook(): CortadelMemory["rememberNode"] {
    return this.rememberNode;
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────

  /** Decide whether this model call ends a turn, and what is new since the last persist. */
  private planPersist(
    state: unknown,
    config?: LangGraphRunnableConfig,
  ):
    | {
        store: ConversationCapableStore;
        namespace: string[];
        turns: ChatMessage[];
        cursor: string;
        thread: string;
      }
    | undefined {
    if (!this.persist) return undefined;
    const messages = messagesOf(state, this.messagesKey);
    if (messages.length === 0) return undefined;
    const last = messages.at(-1);
    // Mid tool loop: the model asked for a tool, or we are looking at the tool's reply. The turn
    // is not over, so persisting now would submit half a turn and then submit it again.
    if (hasToolCalls(last) || messageType(last) === "tool") return undefined;

    const resolved = this.resolveStore(config);
    if (resolved === undefined) return undefined;
    // Not `resolved` itself: inside a compiled graph LangGraph hands nodes an `AsyncBatchedStore`
    // wrapper, which does not forward `addConversation`. See {@link conversationStore}.
    const store = conversationStore(resolved);
    if (store === undefined) {
      this.warnNoConversation(resolved);
      return undefined;
    }

    const thread = threadId(config);
    const turns = toChatMessages(this.newMessages(thread, messages));
    if (turns.length === 0) return undefined;
    return {
      store,
      namespace: resolveNamespace(this.namespace, config),
      turns,
      cursor: messageId(last) ?? "",
      thread,
    };
  }

  /** Messages added since the last persist for this thread. */
  private newMessages(thread: string, messages: readonly unknown[]): unknown[] {
    const cursor = this.cursors.get(thread);
    if (cursor === undefined || cursor === "") return [...messages];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messageId(messages[index]) === cursor) return messages.slice(index + 1);
    }
    // The cursor is gone — the transcript was trimmed or summarised. Fall back to the current turn
    // only (from the last user message on) rather than re-submitting everything, which would spam
    // Cortadel's dedup with an entire replayed history.
    const anchor = lastUserIndex(messages);
    return anchor === undefined ? [...messages] : messages.slice(anchor);
  }

  private advanceCursor(thread: string, cursor: string): void {
    if (cursor === "") return;
    this.cursors.delete(thread);
    this.cursors.set(thread, cursor);
    evict(this.cursors, this.maxTracked);
  }

  private cachedBlock(thread: string, anchor: unknown): string | undefined {
    const entry = this.recallCache.get(thread);
    if (entry === undefined) return undefined;
    return entry[0] === anchorId(anchor) ? entry[1] : undefined;
  }

  private cacheBlock(thread: string, anchor: unknown, block: string): void {
    this.recallCache.delete(thread);
    this.recallCache.set(thread, [anchorId(anchor), block]);
    evict(this.recallCache, this.maxTracked);
  }

  private inject(block: string, messages: readonly unknown[]): Record<string, unknown> {
    if (block === "") return { [this.outputKey]: [...messages] };
    return { [this.outputKey]: [new SystemMessage(block), ...messages] };
  }

  private render(items: readonly SearchItem[]): string {
    const lines: string[] = [];
    for (const item of items) {
      const text = valueText(item.value);
      if (text !== "") lines.push(`- ${text}`);
    }
    if (lines.length === 0) return "";
    return `${this.header}\n${lines.join("\n")}`;
  }

  /**
   * The store to work through, explicit or ambient.
   *
   * Deliberately returns the store LangGraph handed over **as-is**, wrapper and all. Recall goes
   * through `search`, which `AsyncBatchedStore` does implement, and coalescing concurrent reads is
   * the entire reason that wrapper exists — unwrapping here would quietly opt every graph out of
   * it. Only persistence unwraps, and only because `addConversation` is not forwarded.
   */
  private resolveStore(config?: LangGraphRunnableConfig): BaseStore | undefined {
    if (this.store !== undefined) return this.store;
    const resolved = ambientStore(config);
    if (resolved === undefined && !this.warnedNoStore) {
      // Outside a graph context, or the graph was compiled without a store. Memory is an
      // enhancement — log once and let the agent run without it.
      this.warnedNoStore = true;
      this.logger.warn(
        "CortadelMemory found no store: pass store: new CortadelStore(...) to CortadelMemory, " +
          "or compile the graph with it. Running without memory.",
      );
    }
    return resolved;
  }

  private warnNoConversation(store: BaseStore): void {
    if (this.warnedNoConversation) return;
    this.warnedNoConversation = true;
    // Name the store the graph was actually compiled with, not the wrapper LangGraph put around
    // it. Reporting the wrapper told users who had compiled with a CortadelStore that their
    // CortadelStore "is not a CortadelStore", which sent them looking in the wrong place.
    this.logger.warn(
      `CortadelMemory cannot persist turns: ${storeName(innermostStore(store))} is not a ` +
        "CortadelStore, so it has no addConversation(). Recall still works; persistence is " +
        "disabled.",
    );
  }

  /**
   * Fail open (the default) or propagate, per `throwOnError`.
   *
   * `onCallPath` is `false` when the failure belongs to a detached write whose caller has already
   * returned. There is nobody left to throw to, so `throwOnError` cannot apply — see the
   * fire-and-forget branch of {@link rememberNode}.
   */
  private handleError(action: string, error: unknown, onCallPath = true): void {
    if (onCallPath && this.throwOnError) throw error;
    if (this.onError !== undefined) {
      try {
        this.onError(error);
      } catch (callbackError) {
        this.logger.warn(
          `Cortadel onError callback threw while observing a ${action} failure; ignoring it.`,
          callbackError,
        );
      }
      return;
    }
    this.logger.warn(`Cortadel memory unavailable — ${action} failed: ${String(error)}`);
  }
}

// ── Message helpers ──────────────────────────────────────────────────────────────────────────

/**
 * The LangGraph thread this turn belongs to — the key for both per-turn caches.
 *
 * Falls back to a shared sentinel when the graph runs without a checkpointer (no `thread_id`),
 * which is correct: a graph with no thread has exactly one implicit conversation.
 */
function threadId(config?: LangGraphRunnableConfig): string {
  const configurable = config?.configurable;
  const value = configurable?.thread_id ?? configurable?.threadId;
  return value === undefined || value === null || value === "" ? NO_THREAD : String(value);
}

/** Read the message list out of a graph state object. */
function messagesOf(state: unknown, key: string): unknown[] {
  if (state === null || typeof state !== "object") return [];
  const messages = (state as Record<string, unknown>)[key];
  return Array.isArray(messages) ? [...messages] : [];
}

/**
 * A message's LangChain type.
 *
 * `BaseMessage.getType()` is the current spelling (`_getType()` is deprecated), but a graph can
 * also be invoked with plain `{ role, content }` objects before the messages reducer coerces them,
 * so `role` is honoured as a fallback.
 */
function messageType(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  if (typeof record.getType === "function") return String((record.getType as () => string)());
  if (typeof record.type === "string") return record.type;
  if (typeof record.role === "string") return record.role;
  return "";
}

function lastUserIndex(messages: readonly unknown[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const type = messageType(messages[index]);
    if (type === "human" || type === "user") return index;
  }
  return undefined;
}

function messageId(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** LangChain JS keeps tool calls on `AIMessage.tool_calls` — snake_case, unlike the rest of the JS API. */
function hasToolCalls(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const calls = (message as Record<string, unknown>).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/** A stable identity for the turn's anchor message, even when LangChain assigned no id. */
function anchorId(message: unknown): string {
  return messageId(message) ?? `text:${textOf(message).slice(0, 256)}`;
}

/**
 * The text one LangChain content block contributes, or `undefined` when it contributes none.
 *
 * The two are distinct: a block that *is* the empty string still contributes a (blank) line, while
 * a non-text block — an image, a `thinking` part — contributes nothing at all and is skipped.
 */
function blockText(block: unknown): string | undefined {
  if (typeof block === "string") return block;
  if (block === null || typeof block !== "object") return undefined;
  const text = (block as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

/** Flatten a content-block array to plain text, one line per contributing block. */
function blocksText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const text = blockText(block);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n").trim();
}

/** Flatten a message's content to plain text, tolerating content-block arrays. */
function textOf(message: unknown): string {
  if (message === null || typeof message !== "object") {
    return typeof message === "string" ? message.trim() : "";
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return blocksText(content);
  return "";
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["content", "text", "memory", "data"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    }
  }
  return "";
}

/** Convert LangChain messages to Cortadel `ChatMessage`s, dropping tool traffic. */
function toChatMessages(messages: readonly unknown[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const message of messages) {
    if (hasToolCalls(message)) continue;
    const role = ROLES[messageType(message)];
    if (role === undefined) continue;
    const content = textOf(message);
    if (content === "") continue;
    turns.push({ role, content, uuid: messageId(message) });
  }
  return turns;
}

// ── Store unwrapping ─────────────────────────────────────────────────────────────────────────

/** How far to follow a chain of store wrappers before giving up. */
const MAX_STORE_UNWRAP_DEPTH = 8;

function isConversationCapable(store: BaseStore): store is ConversationCapableStore {
  return typeof (store as Partial<ConversationCapableStore>).addConversation === "function";
}

/**
 * The `addConversation`-capable store behind `store`, looking through LangGraph's own wrappers.
 *
 * A graph compiled with `.compile({ store })` never hands its nodes that object: LangGraph wraps it
 * in `AsyncBatchedStore`, which re-implements only `get`/`search`/`put`/`delete` and knows nothing
 * about Cortadel's `addConversation`. So on the store-less path — where {@link CortadelMemory}
 * reads the store off the config, the arrangement the README documents — a bare capability check
 * sees the wrapper, finds no `addConversation`, and silently disables persistence against a
 * perfectly good `CortadelStore`.
 *
 * The walk is **generic** (any object holding another store on `.store`) rather than a
 * `lg_name === "AsyncBatchedStore"` test, for two reasons:
 *
 * 1. Keyed on that one name, the next wrapper LangGraph introduces reinstates this bug silently,
 *    and — as here — only inside a compiled graph, which is the blind spot that hid it initially.
 *    `lg_name` is a general marker convention in this package (`DeltaSnapshot` carries one too) and
 *    is typed as a plain `string`, so there is no fixed set of names to match against anyway.
 * 2. Delegating through a `store` field is the shape LangGraph's wrapper actually has, so matching
 *    the shape covers today's wrapper and any successor that keeps the convention.
 *
 * It is conservative in the two ways that matter. It descends only when the current store cannot do
 * the job itself, so a wrapper that *does* implement `addConversation` keeps its interception; and
 * it is depth-bounded, so a self-referential or cyclic chain terminates.
 *
 * Bypassing the wrapper is safe because `addConversation` is not a `BaseStore` `Operation` at all —
 * `AsyncBatchedStore` has no queue for it, so there is no batching or ordering to break. The
 * unwrapped object is the very one the documented `store:` option passes in directly.
 */
function conversationStore(store: BaseStore): ConversationCapableStore | undefined {
  let candidate: BaseStore | undefined = store;
  for (let depth = 0; candidate !== undefined && depth <= MAX_STORE_UNWRAP_DEPTH; depth += 1) {
    if (isConversationCapable(candidate)) return candidate;
    candidate = wrappedStore(candidate);
  }
  return undefined;
}

/** The store `store` delegates to, when it is a wrapper around another one. */
function wrappedStore(store: BaseStore): BaseStore | undefined {
  const inner = (store as { store?: unknown }).store;
  if (inner === null || typeof inner !== "object" || inner === store) return undefined;
  // Duck-typed rather than `instanceof BaseStore`: `@langchain/langgraph-checkpoint` is a peer
  // dependency, so a second copy anywhere in the tree would fail an identity check for reasons
  // that have nothing to do with the object being a store. `batch` is the one method every
  // `BaseStore` must implement — get/search/put/delete are conveniences built on it.
  return typeof (inner as { batch?: unknown }).batch === "function"
    ? (inner as BaseStore)
    : undefined;
}

/** The innermost store in a wrapper chain — the object the graph was compiled with. */
function innermostStore(store: BaseStore): BaseStore {
  let candidate = store;
  for (let depth = 0; depth <= MAX_STORE_UNWRAP_DEPTH; depth += 1) {
    const inner = wrappedStore(candidate);
    if (inner === undefined) break;
    candidate = inner;
  }
  return candidate;
}

/** A store's class name for a warning, tolerating an exotic prototype. */
function storeName(store: BaseStore): string {
  const name: unknown = (store as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "" ? name : "the configured store";
}

/** Drop the oldest entries until the map fits. JS `Map` iterates in insertion order. */
function evict<V>(map: Map<string, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
