/**
 * Client plumbing: turning a DeepAgents run into a Cortadel client bound to the right user.
 *
 * A Cortadel client is bound to **one** `userId` at construction — no SDK method takes a user id.
 * DeepAgents (via LangChain's agent runtime) instead carries per-run identity in two places: the
 * typed `runtime.context` object from `agent.invoke(input, { context })`, and the untyped
 * `runtime.configurable` bag (which LangChain fills straight from the run's `config.configurable` —
 * see `langchain/dist/agents/nodes/middleware.js`, where the middleware runtime is built as
 * `{ context, store, configurable: config?.configurable, writer, interrupt, signal }`).
 * `ClientProvider` bridges the two: it resolves a user id from the run, then hands back a cached
 * client for that user, constructing one on first use.
 *
 * **The `context` half only arrives if the consumer declared it.** A middleware receives an empty
 * `runtime.context` unless it sets a `contextSchema` naming the keys it wants — the same node file
 * filters the run's context down to that schema's shape. `createCortadelMemoryMiddleware` declares
 * `userIdKey` for exactly this reason; see `userIdContextSchema` in `middleware.ts`. Tools are not
 * filtered this way (`ToolNode` passes the run config through), which is why the two halves could
 * disagree about who the user was.
 *
 * Everything here is defensive on purpose. Memory is an enhancement, never a dependency: a
 * Cortadel server that is down, slow, or misconfigured must degrade to "the agent runs without
 * memory", not "the agent crashes".
 */

import {
  CortadelClient,
  type AddOptions,
  type ChatMessage,
  type ConversationOptions,
  type ConversationResult,
  type MemoryCreated,
  type SearchOptions,
  type SearchResults,
} from "@cortadel/sdk";

/**
 * The slice of the Cortadel SDK this package uses.
 *
 * `CortadelClient` satisfies it structurally, so `client`/`clientFactory` accept the real client —
 * and a test double only has to implement these three methods.
 */
export interface CortadelMemoryClient {
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults>;
  add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated>;
  addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
    signal?: AbortSignal,
  ): Promise<ConversationResult>;
}

/**
 * Recorded on Cortadel searches for access logging, and set as `AddOptions.app` on writes.
 * This is the integration's own published package name, verbatim.
 */
export const DEFAULT_APP_NAME = "@cortadel/deepagents";

/** Self-hosted default (`docker compose up`). The hosted service is `https://app.cortadel.ai`. */
export const DEFAULT_BASE_URL = "http://localhost:3001";

export const ENV_BASE_URL = "CORTADEL_BASE_URL";
export const ENV_API_KEY = "CORTADEL_API_KEY";
export const ENV_USER_ID = "CORTADEL_USER_ID";

/** Key on `runtime.context` / `runtime.configurable` holding the Cortadel user id. */
export const DEFAULT_USER_ID_KEY = "user_id";

/**
 * The parts of a run this package reads.
 *
 * Middleware hooks get LangChain's `Runtime` (`langchain/dist/agents/runtime.d.ts`) and tools get
 * `ToolRuntime` (`@langchain/core/dist/tools/types.d.ts`). The two are shaped differently —
 * `ToolRuntime` is a `RunnableConfig` with `state`/`context`/`config` bolted on — so both are
 * normalised to this before anything else looks at them.
 */
export interface RunScope {
  context?: unknown;
  configurable?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Normalise a middleware `Runtime` or a tool `ToolRuntime` into a {@link RunScope}. */
export function toRunScope(runtime: unknown): RunScope {
  if (!runtime || typeof runtime !== "object") return {};
  const source = runtime as {
    context?: unknown;
    configurable?: unknown;
    signal?: unknown;
    config?: { configurable?: unknown; signal?: unknown };
  };
  // `ToolRuntime.config` is the authoritative RunnableConfig for a tool call; the middleware
  // `Runtime` has no `config` and carries the same fields at the top level.
  const configurable = source.config?.configurable ?? source.configurable;
  const signal = source.config?.signal ?? source.signal;
  return {
    context: source.context,
    configurable:
      configurable && typeof configurable === "object"
        ? (configurable as Record<string, unknown>)
        : undefined,
    signal: signal instanceof AbortSignal ? signal : undefined,
  };
}

/**
 * Read `bag[key]` when it is a non-empty string.
 *
 * The `typeof value === "string"` test is load-bearing, not cosmetic: `bag` is an untrusted run
 * object, so this lookup can resolve an inherited `Object.prototype` member (`"constructor"`,
 * `"toString"`, `"__proto__"`). Every one of those is a function or an object and never a string,
 * so the type test rejects them and the run degrades to "no user id" — the check a bare truthiness
 * guard would have missed. Keep it if this ever widens beyond strings.
 *
 * Deliberately *not* an `Object.hasOwn` guard. LangChain's own context filter tests `key in
 * invokeContext` (`langchain/dist/agents/nodes/middleware.js`), so it honours a context object that
 * inherits the key from a prototype getter. Rejecting inherited keys here would make the tool path
 * disagree with the middleware path about who the user is — the exact split this module's header
 * warns about — while defending only against a globally polluted `Object.prototype`.
 */
function readString(bag: unknown, key: string): string | undefined {
  if (!bag || typeof bag !== "object") return undefined;
  const value = (bag as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function readEnv(name: string): string | undefined {
  // DeepAgents ships a browser build, so `process` is not guaranteed to exist.
  if (typeof process === "undefined" || !process.env) return undefined;
  // Same string test as `readString`, for the same reason: `process.env` inherits from
  // `Object.prototype`, so a non-literal `name` could otherwise resolve a function. Real env values
  // are always strings, so this rejects nothing a deployment can actually set.
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  // `||`, not `??`: an env var set to the empty string means "unset" here, so that a blank
  // `CORTADEL_BASE_URL` still falls through to the next default instead of pinning a blank URL.
  return value || undefined;
}

/**
 * Find the Cortadel user id for the current run.
 *
 * Looks in `runtime.context` first (the LangChain-native home for run-scoped identity), then falls
 * back to `runtime.configurable[key]`, which is where LangGraph Platform / Studio and most
 * hand-rolled callers put a user id.
 *
 * Only a non-empty string counts. Anything else — a number, `null`, `""` — resolves to `undefined`
 * and the run degrades to "no memory", which is why the middleware can afford to declare the
 * context key as `unknown` rather than risk a schema error inside the agent graph.
 */
export function resolveUserId(scope: RunScope, key: string = DEFAULT_USER_ID_KEY): string | undefined {
  return readString(scope.context, key) ?? readString(scope.configurable, key);
}

/** Read LangGraph's `thread_id` — the natural analogue of a Cortadel session id. */
export function resolveThreadId(scope: RunScope): string | undefined {
  return readString(scope.configurable, "thread_id");
}

/** Connection options shared by the middleware and the standalone tools. */
export interface CortadelConnectionOptions {
  /** Cortadel server URL. Defaults to `$CORTADEL_BASE_URL`, then `http://localhost:3001`. */
  baseUrl?: string;
  /**
   * Static Cortadel user id. Defaults to `$CORTADEL_USER_ID`. Leave unset for multi-user agents
   * that resolve the id per run.
   */
  userId?: string;
  /** Bearer token. Defaults to `$CORTADEL_API_KEY`. Omit when the server has auth disabled. */
  apiKey?: string;
  /** Recorded on searches for access logging, and set as `AddOptions.app` on writes. */
  appName?: string;
  /**
   * A caller-owned client. Pins every run to that client's user and is used verbatim — runtime
   * user ids are ignored, because a client cannot be re-bound to another user.
   */
  client?: CortadelMemoryClient;
  /** `userId -> client`, for full control over per-user client construction. */
  clientFactory?: (userId: string) => CortadelMemoryClient;
  /** Key on `runtime.context` / `runtime.configurable` holding the user id. Default `"user_id"`. */
  userIdKey?: string;
}

/**
 * Resolves and caches one Cortadel client per user id.
 *
 * Three construction modes, checked in this order:
 *
 * 1. `client` — a caller-owned client. Single-user mode: that client's user wins for every run.
 * 2. `clientFactory` — `userId -> client`. Full multi-user mode with caller-controlled
 *    construction (custom `fetch`, timeouts, …).
 * 3. `baseUrl` / `apiKey` / `appName` — the default factory, which builds a `CortadelClient` per
 *    user id.
 *
 * The TypeScript SDK holds no long-lived resource (it builds a fresh transport per call and never
 * mutates your `fetch`), so there is nothing to close — unlike the Python leg, this provider has no
 * teardown method.
 */
export class ClientProvider {
  readonly appName: string;
  readonly userIdKey: string;

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #staticUserId: string | undefined;
  readonly #client: CortadelMemoryClient | undefined;
  readonly #clientFactory: ((userId: string) => CortadelMemoryClient) | undefined;
  readonly #cache = new Map<string, CortadelMemoryClient>();
  readonly #warned = new Set<string>();

  constructor(options: CortadelConnectionOptions = {}) {
    this.#baseUrl = options.baseUrl ?? readEnv(ENV_BASE_URL) ?? DEFAULT_BASE_URL;
    this.#apiKey = options.apiKey ?? readEnv(ENV_API_KEY);
    this.appName = options.appName ?? DEFAULT_APP_NAME;
    this.#staticUserId = options.userId ?? readEnv(ENV_USER_ID);
    this.#client = options.client;
    this.#clientFactory = options.clientFactory;
    this.userIdKey = options.userIdKey ?? DEFAULT_USER_ID_KEY;
  }

  /** `true` when a caller-supplied client pins every run to one user. */
  get isSingleUser(): boolean {
    return this.#client !== undefined;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    console.warn(message);
  }

  /**
   * Return the client for this run, or `undefined` when no user id can be resolved.
   *
   * Returning `undefined` (rather than throwing) is what makes an unconfigured or partially
   * configured deployment degrade into "no memory this run" instead of a hard failure.
   */
  forRun(scope: RunScope): CortadelMemoryClient | undefined {
    const runUserId = resolveUserId(scope, this.userIdKey);

    if (this.#client) {
      if (runUserId && this.#staticUserId && runUserId !== this.#staticUserId) {
        this.#warnOnce(
          "pinned-client",
          `@cortadel/deepagents: a \`client\` was supplied, so this run's ${this.userIdKey}=` +
            `"${runUserId}" is ignored and memories stay scoped to "${this.#staticUserId}". ` +
            "Pass `clientFactory` for multi-user agents.",
        );
      }
      return this.#client;
    }

    const userId = runUserId ?? this.#staticUserId;
    if (!userId) {
      this.#warnOnce(
        "no-user-id",
        `@cortadel/deepagents: no Cortadel user id for this run (looked at runtime.context.` +
          `${this.userIdKey}, runtime.configurable.${this.userIdKey}, the \`userId\` option and ` +
          `$${ENV_USER_ID}). Memory is disabled for this run.`,
      );
      return undefined;
    }

    return this.forUser(userId);
  }

  /** Return (constructing and caching on first use) the client for `userId`. */
  forUser(userId: string): CortadelMemoryClient | undefined {
    if (this.#client) return this.#client;

    const cached = this.#cache.get(userId);
    if (cached) return cached;

    let built: CortadelMemoryClient;
    try {
      built = this.#clientFactory
        ? this.#clientFactory(userId)
        : new CortadelClient({
            baseUrl: this.#baseUrl,
            userId,
            apiKey: this.#apiKey,
            appName: this.appName,
          });
    } catch (error) {
      // `new CortadelClient({...})` throws a plain `Error` for a blank or non-http base URL. A
      // misconfigured URL must not kill the agent.
      this.#warnOnce(
        `construct:${userId}`,
        `@cortadel/deepagents: could not construct a Cortadel client for user "${userId}" ` +
          `(baseUrl="${this.#baseUrl}"): ${String(error)}. Memory is disabled for this user.`,
      );
      return undefined;
    }

    this.#cache.set(userId, built);
    return built;
  }
}
