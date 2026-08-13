/**
 * `CortadelStore` — Cortadel behind LangGraph's `BaseStore` interface.
 *
 * `BaseStore` (`@langchain/langgraph-checkpoint`, `src/store/base.ts`) is LangGraph's one
 * long-term-memory extension point: it is what `StateGraph.compile({ store })`,
 * `entrypoint({ store })` and `createReactAgent({ store })` accept, what `getStore()` hands to a
 * node, and what a tool reads off its `LangGraphRunnableConfig`. Implementing it is what makes
 * Cortadel *native* here rather than bolted on.
 *
 * **The JS `BaseStore` is not the Python one.** It declares exactly **one** abstract member —
 * `batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>` — where Python
 * declares two (`batch` and `abatch`). Everything else (`get`/`search`/`put`/`delete`/
 * `listNamespaces`) is concrete on the base class and routes through it. There is also no
 * `supports_ttl` and no `ttl` argument anywhere in the JS surface, and the operations are plain
 * structural interfaces rather than classes, so they are discriminated by which properties are
 * present rather than by `isinstance`.
 *
 * Mapping the two models
 * ----------------------
 *
 * | LangGraph op                              | Cortadel call |
 * | ----------------------------------------- | ------------- |
 * | `PutOperation` with a value               | `add(text, AddOptions)` |
 * | `PutOperation` with `value: null`         | `delete([id])` |
 * | `GetOperation`                            | `get(id)` |
 * | `SearchOperation` with a `query`          | `search(query, SearchOptions)` — BM25+vector hybrid |
 * | `SearchOperation` without a `query`       | `list(ListOptions)` |
 * | `ListNamespacesOperation`                 | *no Cortadel equivalent* — served from a process-local registry |
 *
 * Three seams deserve attention, and all three are documented in the README:
 *
 * 1. **Namespace -> user id.** A Cortadel client is bound to one user id at construction, so
 *    per-user scoping means *one client per user*. `userId` therefore accepts a callable that
 *    derives the user id from the namespace (see {@link namespaceUserId}), and this store keeps a
 *    small cache of clients keyed by the resolved id.
 * 2. **Keys.** Cortadel mints its own memory ids; it has no upsert-by-caller-key. So the store's
 *    key space *is* Cortadel memory ids — that is what `search()` returns as `SearchItem.key`, and
 *    what `get()`/`delete()` expect. A caller-chosen key passed to `put()` is bridged to the minted
 *    id through a **process-local** alias table so `put(); get()` round-trips within one run; it
 *    does not survive a restart.
 * 3. **Degradation.** A memory backend must never take the agent down. Every Cortadel call is
 *    wrapped: `CortadelError` (which the SDK also throws for transport failures, with
 *    `code: "transport_error"`) is turned into an empty result and either handed to the `onError`
 *    callback or, when there isn't one, logged as a warning. Set `throwOnError: true` to opt out
 *    and have failures propagate.
 */
import {
  CortadelClient,
  CortadelError,
  type AddOptions,
  type ChatMessage,
  type ConversationOptions,
  type ConversationResult,
  type HealthResult,
  type ListOptions,
  type MemoryDetail,
  type MemoryListItem,
  type SearchHit,
  type SearchOptions,
} from "@cortadel/sdk";
import {
  BaseStore,
  type GetOperation,
  type Item,
  type ListNamespacesOperation,
  type MatchCondition,
  type Operation,
  type OperationResults,
  type PutOperation,
  type SearchItem,
  type SearchOperation,
} from "@langchain/langgraph-checkpoint";

import type { UserIdResolver } from "./namespace.js";

/** Signature of the `onError` observer: it is handed the error and returns nothing. */
export type ErrorCallback = (error: unknown) => void;

/** The sliver of a logger this package uses. `console` satisfies it. */
export interface StoreLogger {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * The subset of `CortadelClient` this store calls.
 *
 * Declaring it structurally is what lets the offline test suite hand the store a plain fake
 * through `clientFactory` without a live server, a network stack, or module patching.
 */
export interface CortadelMemoryClient {
  add: CortadelClient["add"];
  addConversation: CortadelClient["addConversation"];
  search: CortadelClient["search"];
  list: CortadelClient["list"];
  get: CortadelClient["get"];
  delete: CortadelClient["delete"];
  health: CortadelClient["health"];
}

/** Recorded on writes (`AddOptions.app`) and on searches (the client's `appName`). */
export const DEFAULT_APP_NAME = "@cortadel/langgraph";

/** `Item.value` keys checked, in order, for the string to store as the memory's text. */
export const DEFAULT_TEXT_KEYS: readonly string[] = ["content", "text", "memory", "data"];

// Server-side ceilings from the Cortadel REST contract, mirrored here so we clamp with a warning
// instead of letting the server 400.
const MAX_SEARCH_TOP_K = 50;
const MAX_LIST_SIZE = 100;

// Cortadel returns timestamps in two shapes (ISO strings on search hits, Unix seconds on list/
// detail rows). When one is missing or unparseable we still owe LangGraph a Date; this sentinel is
// deterministic (unlike "now"), which keeps tests and diffs stable.
const UNKNOWN_TIME = new Date(0);

// Keys this store ever writes into `Item.value`. They are camelCase because that is what the
// TypeScript SDK's DTOs use, and `Item.value` is read by JavaScript callers. A `SearchOperation`
// filter naming anything else cannot be evaluated, so it is warned about once and ignored rather
// than silently excluding rows.
const FILTERABLE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "content",
  "text",
  "memory",
  "data",
  "categories",
  "tags",
  "memoryType",
  "appName",
  "source",
  "gist",
  "projectId",
  "state",
  "isGlobal",
  "isCurrent",
]);

// Filter keys the Cortadel search endpoint can enforce itself, so they are lifted out of the
// post-filter and pushed into SearchOptions.
const SERVER_FILTER_KEYS: readonly string[] = ["memoryType", "sessionId"];

/** Options for {@link CortadelStore}. */
export interface CortadelStoreOptions {
  /**
   * Cortadel server, e.g. `"http://localhost:3001"` (self-hosted) or `"https://app.cortadel.ai"`
   * (hosted).
   */
  baseUrl: string;
  /**
   * Either a fixed Cortadel user id, or a callable mapping a LangGraph namespace to one. Use
   * {@link namespaceUserId} for the common `["memories", "<user>"]` layout.
   */
  userId: UserIdResolver;
  /** Bearer token. Omit when the server has auth disabled (the self-hosted default). */
  apiKey?: string;
  /** Recorded for access logging, and used as `AddOptions.app` on writes. */
  appName?: string;
  /** Cortadel search mode — `"hybrid"` (default), `"text"` or `"vector"`. */
  searchMode?: string;
  /**
   * Set to `"cross_encoder"` to rerank with the server's cross-encoder. Any other value is
   * silently ignored by the server.
   */
  rerank?: string;
  /**
   * Default for Cortadel's background entity/category extraction on writes. `false` stores text
   * verbatim (dedup still applies).
   */
  infer?: boolean;
  /**
   * `Item.value` keys checked, in order, for the text to store. If none match, the whole value is
   * stored as deterministic JSON.
   */
  textKeys?: readonly string[];
  /** Key the memory text is exposed under on read. */
  valueKey?: string;
  /**
   * `false` (the default) fails open — a Cortadel failure becomes an empty result and the agent
   * keeps running. `true` propagates the error instead.
   */
  throwOnError?: boolean;
  /**
   * Optional callback invoked with the error whenever a failure is swallowed
   * (`throwOnError: false`). Supplying one replaces the default warning log, so it is also how you
   * route memory failures into your own telemetry — or silence them.
   */
  onError?: ErrorCallback;
  /** Per-request HTTP timeout in milliseconds. Set to `0` to disable. */
  timeoutMs?: number;
  /** Cap on the process-local caller-key -> memory-id alias table. */
  maxAliasEntries?: number;
  /** Logger to use. Defaults to `console`. */
  logger?: StoreLogger;
  /**
   * Builds the Cortadel client for a resolved user id. Defaults to a real `CortadelClient`; this
   * exists so tests (and unusual transports) can substitute one.
   */
  clientFactory?: (userId: string) => CortadelMemoryClient;
}

/** Extra options accepted by {@link CortadelStore.addConversation}. */
export interface AddConversationOptions {
  /** Session id grouping the extracted facts. */
  sessionId?: string;
  /** Project scope (e.g. a repo name) recorded on every extracted fact. */
  project?: string;
  /** Tags applied to every extracted fact. */
  tags?: string[];
  /** When `true`, extract facts about the assistant instead of the user. */
  isAgentMemory?: boolean;
}

/**
 * A LangGraph `BaseStore` backed by a Cortadel server.
 *
 * @example
 * ```ts
 * const store = new CortadelStore({ baseUrl: "http://localhost:3001", userId: "e2e-alice" });
 * await store.put(["memories", "e2e-alice"], "pref-1", { content: "Ships on Fridays." });
 * const hits = await store.search(["memories", "e2e-alice"], { query: "when do they deploy?" });
 * ```
 */
export class CortadelStore extends BaseStore {
  private readonly baseUrl: string;
  private readonly userId: UserIdResolver;
  private readonly apiKey?: string;
  private readonly appName: string;
  private readonly searchMode: string;
  private readonly rerank?: string;
  private readonly infer: boolean;
  private readonly textKeys: readonly string[];
  private readonly valueKey: string;
  private readonly throwOnError: boolean;
  private readonly onError?: ErrorCallback;
  private readonly timeoutMs: number;
  private readonly maxAliasEntries: number;
  private readonly logger: StoreLogger;
  private readonly clientFactory: (userId: string) => CortadelMemoryClient;

  private readonly clients = new Map<string, CortadelMemoryClient>();
  /** Caller-chosen key -> Cortadel-minted memory id. Process-local; see the module docstring. */
  private readonly aliases = new Map<string, string>();
  private readonly namespaces = new Set<string>();
  private readonly warnedFilterKeys = new Set<string>();
  private warnedOverfetch = false;

  constructor(options: CortadelStoreOptions) {
    super();
    if (options.onError !== undefined && typeof options.onError !== "function") {
      // Guards the pre-1.0 spelling, where onError was the mode string "warn"/"ignore"/"raise".
      // Failing loudly here beats a callback that is silently never called.
      throw new TypeError(
        `onError must be a function taking the error, not ${JSON.stringify(options.onError)}. ` +
          "To make failures fatal use throwOnError: true; to silence the default warning pass " +
          "onError: () => {}.",
      );
    }
    if (options.textKeys !== undefined && options.textKeys.length === 0) {
      throw new Error("textKeys must name at least one key.");
    }

    this.baseUrl = options.baseUrl;
    this.userId = options.userId;
    this.apiKey = options.apiKey;
    this.appName = options.appName ?? DEFAULT_APP_NAME;
    this.searchMode = options.searchMode ?? "hybrid";
    this.rerank = options.rerank;
    this.infer = options.infer ?? true;
    this.textKeys = options.textKeys ?? DEFAULT_TEXT_KEYS;
    this.valueKey = options.valueKey ?? "content";
    this.throwOnError = options.throwOnError ?? false;
    this.onError = options.onError;
    this.timeoutMs = options.timeoutMs ?? 100_000;
    this.maxAliasEntries = options.maxAliasEntries ?? 10_000;
    this.logger = options.logger ?? console;
    this.clientFactory =
      options.clientFactory ??
      ((userId: string) =>
        new CortadelClient({
          baseUrl: this.baseUrl,
          userId,
          apiKey: this.apiKey,
          appName: this.appName,
          timeoutMs: this.timeoutMs,
        }));
  }

  // ── BaseStore: the one abstract method ──────────────────────────────────────────────────

  /**
   * Execute operations in order against Cortadel.
   *
   * Operations run sequentially rather than concurrently: a batch may legitimately contain a write
   * and a read of the same key, and Cortadel offers no batch endpoint that would preserve that
   * ordering for us. `AsyncBatchedStore` (which LangGraph wraps a compiled store in) will coalesce
   * concurrent operations into one call, so a heavily parallel graph trades throughput for that
   * ordering guarantee.
   */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const op of operations) {
      results.push(await this.execute(op));
    }
    return results as OperationResults<Op>;
  }

  // ── Cortadel-specific extensions (beyond BaseStore) ─────────────────────────────────────

  /**
   * Ingest a conversation so Cortadel distils durable facts from it.
   *
   * This has no `BaseStore` equivalent — `put` stores a fact you already wrote, whereas this hands
   * Cortadel raw turns and lets its extraction pipeline decide what is worth remembering. It is
   * what {@link CortadelMemory} calls after a turn completes.
   *
   * @returns The server's result, or `null` when the call failed and `throwOnError` is `false`.
   */
  async addConversation(
    namespace: string[],
    messages: Iterable<ChatMessage>,
    options: AddConversationOptions = {},
  ): Promise<ConversationResult | null> {
    const turns = [...messages];
    if (turns.length === 0) return null;
    const client = this.client(namespace);
    if (client === undefined) return null;
    const conversationOptions: ConversationOptions = {
      isAgentMemory: options.isAgentMemory ?? false,
      tags: options.tags,
      project: options.project,
      sessionId: options.sessionId,
    };
    try {
      return await client.addConversation(turns, conversationOptions);
    } catch (error) {
      this.handleError("addConversation", error);
      return null;
    }
  }

  /**
   * Check the Cortadel server.
   *
   * Note that Cortadel's `health` does not throw for a *degraded* server — inspect `result.status`
   * yourself. `null` means the call itself failed.
   */
  async health(namespace: string[] = []): Promise<HealthResult | null> {
    const client = this.client(namespace);
    if (client === undefined) return null;
    try {
      return await client.health();
    } catch (error) {
      this.handleError("health", error);
      return null;
    }
  }

  // ── Op dispatch ─────────────────────────────────────────────────────────────────────────

  /**
   * Route one operation.
   *
   * JS operations are structural interfaces, not classes, so the discriminant is which properties
   * are present. Order matters: a `PutOperation` also carries `namespace` and `key`, and
   * `ListNamespacesOperation.matchConditions` is optional, so it can only be recognised last.
   */
  private async execute(op: Operation): Promise<unknown> {
    if ("namespacePrefix" in op) return this.searchOp(op);
    if ("value" in op) return this.putOp(op);
    if ("key" in op && "namespace" in op) return this.getOp(op);
    if ("limit" in op && "offset" in op) return this.listNamespacesOp(op as ListNamespacesOperation);
    throw new Error(`Unknown operation type: ${JSON.stringify(op)}`);
  }

  // ── GetOperation ────────────────────────────────────────────────────────────────────────

  private async getOp(op: GetOperation): Promise<Item | null> {
    this.registerNamespace(op.namespace);
    const client = this.client(op.namespace);
    if (client === undefined) return null;
    const memoryId = this.resolveKey(op.namespace, op.key);
    let detail: MemoryDetail | null;
    try {
      detail = await client.get(memoryId);
    } catch (error) {
      this.handleError("get", error);
      return null;
    }
    return this.detailToItem(op.namespace, op.key, detail);
  }

  // ── SearchOperation ─────────────────────────────────────────────────────────────────────

  private async searchOp(op: SearchOperation): Promise<SearchItem[]> {
    this.registerNamespace(op.namespacePrefix);
    const client = this.client(op.namespacePrefix);
    if (client === undefined) return [];
    const limit = op.limit ?? 10;
    const offset = op.offset ?? 0;
    const [serverFilter, postFilter] = this.splitFilter(op.filter);
    let items: SearchItem[];
    try {
      if (op.query) {
        const results = await client.search(op.query, this.searchOptions(limit, offset, serverFilter));
        items = (results.results ?? []).map((hit) => this.hitToSearchItem(op.namespacePrefix, hit));
      } else {
        const page = await client.list(this.listOptions(limit, offset, serverFilter));
        items = (page.items ?? []).map((row) => this.rowToSearchItem(op.namespacePrefix, row));
      }
    } catch (error) {
      this.handleError("search", error);
      return [];
    }
    return this.applyFilter(items, postFilter).slice(offset, offset + limit);
  }

  private searchOptions(
    limit: number,
    offset: number,
    serverFilter: Record<string, string>,
  ): SearchOptions {
    const wanted = Math.max(1, limit + offset);
    if (wanted > MAX_SEARCH_TOP_K) this.warnOverfetch("search", wanted, MAX_SEARCH_TOP_K);
    return {
      topK: Math.min(MAX_SEARCH_TOP_K, wanted),
      mode: this.searchMode,
      sessionId: serverFilter.sessionId,
      rerank: this.rerank,
      memoryType: serverFilter.memoryType,
    };
  }

  private listOptions(
    limit: number,
    offset: number,
    serverFilter: Record<string, string>,
  ): ListOptions {
    const wanted = Math.max(1, limit + offset);
    if (wanted > MAX_LIST_SIZE) this.warnOverfetch("list", wanted, MAX_LIST_SIZE);
    return { page: 1, size: Math.min(MAX_LIST_SIZE, wanted), memoryType: serverFilter.memoryType };
  }

  /** Split a `SearchOperation.filter` into what the server can enforce and what we post-filter. */
  private splitFilter(
    raw: Record<string, unknown> | undefined,
  ): [Record<string, string>, Record<string, unknown>] {
    if (!raw) return [{}, {}];
    const server: Record<string, string> = {};
    const post: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (SERVER_FILTER_KEYS.includes(key) && typeof value === "string") {
        // memoryType is also present on a hit, so leaving it out of the post-filter is safe;
        // sessionId is not exposed on a hit at all and could not be checked here.
        server[key] = value;
        continue;
      }
      if (!FILTERABLE_KEYS.has(key)) {
        this.warnUnknownFilterKey(key);
        continue;
      }
      post[key] = value;
    }
    return [server, post];
  }

  private applyFilter(items: SearchItem[], postFilter: Record<string, unknown>): SearchItem[] {
    const entries = Object.entries(postFilter);
    if (entries.length === 0) return items;
    return items.filter((item) =>
      entries.every(([key, expected]) => matches(item.value[key], expected)),
    );
  }

  // ── PutOperation ────────────────────────────────────────────────────────────────────────

  private async putOp(op: PutOperation): Promise<void> {
    this.registerNamespace(op.namespace);
    const client = this.client(op.namespace);
    if (client === undefined) return;
    if (op.value === null) {
      const memoryId = this.resolveKey(op.namespace, op.key);
      try {
        await client.delete([memoryId]);
      } catch (error) {
        this.handleError("delete", error);
      }
      this.aliases.delete(aliasKey(op.namespace, op.key));
      return;
    }
    const [text, options] = this.valueToAdd(op);
    try {
      const created = await client.add(text, options);
      if (created?.id) this.rememberAlias(op.namespace, op.key, created.id);
    } catch (error) {
      this.handleError("put", error);
    }
  }

  private valueToAdd(op: PutOperation): [string, AddOptions] {
    const value: Record<string, unknown> = { ...(op.value ?? {}) };
    let text: string | undefined;
    for (const key of this.textKeys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim() !== "") {
        text = candidate;
        delete value[key];
        break;
      }
    }
    let metadata: Record<string, unknown>;
    if (text === undefined) {
      // No recognised text key: keep the caller's data intact as deterministic JSON rather than
      // silently dropping it. Cortadel will happily store it, but its extraction pipeline works
      // far better on prose — hence the README's `{ content: "..." }`.
      text = stableJson(op.value);
      metadata = {};
    } else {
      metadata = value;
    }
    return [
      text,
      {
        app: this.appName,
        metadata: { langgraph_namespace: op.namespace.join("/"), langgraph_key: op.key, ...metadata },
        // LangGraph's `index: false` means "do not make this semantically searchable". Cortadel
        // always embeds for hybrid search, so the closest honest analogue is `infer: false`: store
        // verbatim, skip background entity/category extraction. A list of field paths
        // (`index: ["a", "b"]`) has no Cortadel equivalent and is ignored.
        infer: op.index === false ? false : this.infer,
      },
    ];
  }

  // ── ListNamespacesOperation ─────────────────────────────────────────────────────────────

  /**
   * Serve namespaces from a process-local registry.
   *
   * Cortadel stores memories per user, not per namespace path — there is no endpoint that
   * enumerates namespaces. Rather than always returning `[]`, this returns the namespaces *this
   * store instance* has read from or written to, with the same prefix/suffix/wildcard/`maxDepth`
   * semantics as `InMemoryStore`. It is therefore accurate but not durable, and empty in a
   * freshly-started process.
   */
  private listNamespacesOp(op: ListNamespacesOperation): string[][] {
    let namespaces = [...this.namespaces].map((encoded) => JSON.parse(encoded) as string[]);
    const conditions = op.matchConditions;
    if (conditions && conditions.length > 0) {
      namespaces = namespaces.filter((ns) =>
        conditions.every((condition) => doesMatch(condition, ns)),
      );
    }
    if (op.maxDepth !== undefined) {
      const truncated = new Map<string, string[]>();
      for (const ns of namespaces) {
        const cut = ns.slice(0, op.maxDepth);
        truncated.set(JSON.stringify(cut), cut);
      }
      namespaces = [...truncated.values()];
    }
    namespaces.sort(compareNamespaces);
    return namespaces.slice(op.offset, op.offset + op.limit);
  }

  // ── Row -> Item mapping ─────────────────────────────────────────────────────────────────

  private detailToItem(
    namespace: string[],
    requestedKey: string,
    detail: MemoryDetail | null,
  ): Item | null {
    if (detail === null || detail === undefined) return null;
    const created = fromEpochSeconds(detail.createdAt);
    const value: Record<string, unknown> = { [this.valueKey]: detail.text, id: detail.id };
    putIf(value, "categories", detail.categories);
    putIf(value, "state", detail.state);
    putIf(value, "appName", detail.appName);
    putIf(value, "isCurrent", detail.isCurrent);
    if (detail.isGlobal) value.isGlobal = true;
    return {
      value,
      // The key the caller asked for, per the BaseStore contract. The Cortadel-minted id is always
      // available as value.id.
      key: requestedKey,
      namespace,
      createdAt: created,
      updatedAt: parseIso(detail.validAt) ?? created,
    };
  }

  private hitToSearchItem(namespace: string[], hit: SearchHit): SearchItem {
    const created = parseIso(hit.createdAt) ?? UNKNOWN_TIME;
    const value: Record<string, unknown> = { [this.valueKey]: hit.content, id: hit.id };
    putIf(value, "categories", hit.categories);
    putIf(value, "tags", hit.tags);
    putIf(value, "memoryType", hit.memoryType);
    putIf(value, "appName", hit.appName);
    putIf(value, "source", hit.source);
    putIf(value, "gist", hit.gist);
    putIf(value, "projectId", hit.projectId);
    if (hit.isGlobal) value.isGlobal = true;
    return {
      namespace,
      key: hit.id,
      value,
      createdAt: created,
      updatedAt: created,
      score: hit.rrfScore ?? undefined,
    };
  }

  private rowToSearchItem(namespace: string[], row: MemoryListItem): SearchItem {
    const created = fromEpochSeconds(row.createdAt);
    const value: Record<string, unknown> = { [this.valueKey]: row.content, id: row.id };
    putIf(value, "categories", row.categories);
    putIf(value, "memoryType", row.memoryType);
    putIf(value, "appName", row.appName);
    putIf(value, "state", row.state);
    putIf(value, "isCurrent", row.isCurrent);
    if (row.isGlobal) value.isGlobal = true;
    return {
      namespace,
      key: row.id,
      value,
      createdAt: created,
      updatedAt: parseIso(row.validAt) ?? created,
      // A plain list is unranked, so there is no score to report. Reporting a fabricated one would
      // be worse than leaving it undefined.
      score: undefined,
    };
  }

  // ── Clients ─────────────────────────────────────────────────────────────────────────────

  private resolveUserId(namespace: string[]): string | undefined {
    if (typeof this.userId === "string") return this.userId;
    let userId: string;
    try {
      userId = this.userId([...namespace]);
    } catch (error) {
      // A user-supplied callable — never let it kill the graph.
      this.handleError(`resolving a user id for namespace [${namespace.join(", ")}]`, error);
      return undefined;
    }
    if (!userId) {
      this.handleError(
        `resolving a user id for namespace [${namespace.join(", ")}]`,
        new Error(
          `No Cortadel user id could be derived from namespace [${namespace.join(", ")}].`,
        ),
      );
      return undefined;
    }
    return userId;
  }

  private client(namespace: string[]): CortadelMemoryClient | undefined {
    const userId = this.resolveUserId(namespace);
    if (userId === undefined) return undefined;
    let client = this.clients.get(userId);
    if (client === undefined) {
      client = this.clientFactory(userId);
      this.clients.set(userId, client);
    }
    return client;
  }

  // ── Aliases, namespaces, diagnostics ────────────────────────────────────────────────────

  /** Translate a caller-chosen key to the Cortadel memory id, if we minted one for it. */
  private resolveKey(namespace: string[], key: string): string {
    return this.aliases.get(aliasKey(namespace, key)) ?? key;
  }

  private rememberAlias(namespace: string[], key: string, memoryId: string): void {
    if (key === memoryId) return;
    const composite = aliasKey(namespace, key);
    this.aliases.delete(composite);
    this.aliases.set(composite, memoryId);
    while (this.aliases.size > this.maxAliasEntries) {
      const oldest = this.aliases.keys().next();
      if (oldest.done) break;
      this.aliases.delete(oldest.value);
    }
  }

  private registerNamespace(namespace: string[]): void {
    if (namespace.length > 0) this.namespaces.add(JSON.stringify(namespace));
  }

  /**
   * Fail open (the default) or propagate, per `throwOnError`.
   *
   * Fail-open hands the error to the `onError` callback when there is one, and otherwise logs a
   * warning — those are the two halves of the old `"warn"`/`"ignore"` modes, collapsed into one
   * knob.
   */
  private handleError(action: string, error: unknown): void {
    if (this.throwOnError) throw error;
    if (this.onError !== undefined) {
      try {
        this.onError(error);
      } catch (callbackError) {
        // An observer must not be able to take the agent down either.
        this.logger.warn(
          `Cortadel onError callback threw while observing a ${action} failure; ignoring it.`,
          callbackError,
        );
      }
      return;
    }
    if (error instanceof CortadelError) {
      this.logger.warn(
        `Cortadel memory unavailable — ${action} failed (status=${error.status} ` +
          `code=${error.code}): ${error.message}`,
      );
    } else {
      this.logger.warn(`Cortadel memory unavailable — ${action} failed: ${String(error)}`);
    }
  }

  private warnUnknownFilterKey(key: string): void {
    if (this.warnedFilterKeys.has(key)) return;
    this.warnedFilterKeys.add(key);
    this.logger.warn(
      `CortadelStore cannot evaluate the search filter key "${key}" (Cortadel exposes ` +
        `${[...FILTERABLE_KEYS].sort((a, b) => a.localeCompare(b)).join(", ")} on a hit); it is ` +
        `being ignored, so results ` +
        "are NOT filtered by it.",
    );
  }

  private warnOverfetch(endpoint: string, wanted: number, ceiling: number): void {
    if (this.warnedOverfetch) return;
    this.warnedOverfetch = true;
    this.logger.warn(
      `CortadelStore needed ${wanted} rows from ${endpoint} to honour limit+offset, but Cortadel ` +
        `caps that at ${ceiling}; results are truncated.`,
    );
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────────────────────

/** Add `key` only when it carries information — keeps `Item.value` free of null noise. */
function putIf(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

// A namespace is an array, so any single-character separator could collide with a label that
// happens to contain it. JSON encoding is unambiguous by construction and needs no such gamble —
// and it round-trips, which is what makes the namespace registry below readable back out.
function aliasKey(namespace: string[], key: string): string {
  return JSON.stringify([namespace, key]);
}

/** Lexicographic order over namespace paths, label by label — matches `InMemoryStore`'s ordering. */
function compareNamespaces(a: string[], b: string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}

/** Cortadel's list/detail rows carry Unix seconds (search hits carry ISO strings instead). */
function fromEpochSeconds(seconds: number | null | undefined): Date {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN_TIME;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? UNKNOWN_TIME : date;
}

/**
 * Parse an ISO 8601 timestamp, tolerating more than three fractional-second digits.
 *
 * Cortadel's .NET server emits up to seven. `Date.parse` handling of those is
 * implementation-defined, so they are truncated to milliseconds before parsing rather than left to
 * the engine.
 */
function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const normalised = trimmed.replace(/\.(\d{3})\d+/, ".$1");
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Compares by UTF-16 code unit — deliberately NOT `localeCompare`.
 *
 * This orders keys for {@link stableJson}, whose whole job is that the same value always produces
 * the same text. `localeCompare` is locale- and ICU-version-dependent, so it would make the
 * "stable" JSON differ between two machines that disagree on collation — exactly the property
 * being relied on. Code-unit order is the same everywhere, forever.
 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Deterministic JSON: object keys sorted, so the same value always produces the same text. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const record = inner as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort(byCodeUnit).map((key) => [key, record[key]]));
  });
}

/**
 * Compare one `Item.value` field against a `SearchOperation.filter` value.
 *
 * Supports the operator objects the JS `SearchOperation` documents (`$eq`, `$ne`, `$gt`, `$gte`,
 * `$lt`, `$lte`) — a JS-only capability; the Python `BaseStore` filter has no such contract.
 * Scalar-against-array also means membership (`{ categories: "work" }` matches a memory tagged
 * `["work", "travel"]`).
 */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    return Object.entries(expected as Record<string, unknown>).every(([operator, operand]) => {
      switch (operator) {
        case "$eq":
          return matches(actual, operand);
        case "$ne":
          return !matches(actual, operand);
        case "$gt":
          return compare(actual, operand, (a, b) => a > b);
        case "$gte":
          return compare(actual, operand, (a, b) => a >= b);
        case "$lt":
          return compare(actual, operand, (a, b) => a < b);
        case "$lte":
          return compare(actual, operand, (a, b) => a <= b);
        default:
          return false;
      }
    });
  }
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.includes(expected);
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, i) => item === expected[i]);
  }
  return actual === expected;
}

function compare(
  actual: unknown,
  operand: unknown,
  predicate: (a: number | string, b: number | string) => boolean,
): boolean {
  if (typeof actual === "number" && typeof operand === "number") return predicate(actual, operand);
  if (typeof actual === "string" && typeof operand === "string") return predicate(actual, operand);
  return false;
}

/**
 * Prefix/suffix namespace matching with `*` wildcards.
 *
 * Same semantics as `InMemoryStore`, so `listNamespaces` behaves identically whichever store a
 * graph is compiled with.
 */
function doesMatch(condition: MatchCondition, namespace: string[]): boolean {
  const path = condition.path;
  if (namespace.length < path.length) return false;
  if (condition.matchType === "prefix") {
    return path.every((expected, index) => expected === "*" || namespace[index] === expected);
  }
  if (condition.matchType === "suffix") {
    const offset = namespace.length - path.length;
    return path.every((expected, index) => expected === "*" || namespace[offset + index] === expected);
  }
  throw new Error(`Unsupported match type: ${String(condition.matchType)}`);
}
