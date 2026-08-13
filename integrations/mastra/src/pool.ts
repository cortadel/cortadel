import { CortadelClient } from "@cortadel/sdk";

import type { CortadelClientLike, CortadelConnectionOptions } from "./types.js";

/** Self-hosted default, matching `docker compose up` (`docs/self-hosting.md`). */
export const DEFAULT_BASE_URL = "http://localhost:3001";

/** Recorded on searches and stamped on stored memories via `AddOptions.app`. */
export const DEFAULT_APP_NAME = "cortadel-mastra";

/** Upper bound on cached per-user clients, so a multi-tenant server can't leak. */
export const MAX_CACHED_CLIENTS = 128;

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/**
 * A `CortadelClient` is bound to exactly one `userId` at construction — there is
 * no per-call user argument anywhere on the SDK. Multi-user Mastra apps therefore
 * need one client per user id; this pool creates them lazily and keeps the most
 * recently used {@link MAX_CACHED_CLIENTS} around.
 */
export class CortadelClientPool {
  readonly #options: CortadelConnectionOptions;
  readonly #cache = new Map<string, CortadelClientLike>();

  constructor(options: CortadelConnectionOptions = {}) {
    this.#options = options;
  }

  /** The app name this pool stamps on writes and searches. */
  get appName(): string {
    return this.#options.appName ?? DEFAULT_APP_NAME;
  }

  /** Number of clients currently cached. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#cache.size;
  }

  /** Get (or lazily create) the client bound to `userId`. */
  get(userId: string): CortadelClientLike {
    const cached = this.#cache.get(userId);
    if (cached) {
      // Refresh recency so eviction is LRU rather than insertion-ordered.
      this.#cache.delete(userId);
      this.#cache.set(userId, cached);
      return cached;
    }

    const client = this.#create(userId);

    if (this.#cache.size >= MAX_CACHED_CLIENTS) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(userId, client);
    return client;
  }

  #create(userId: string): CortadelClientLike {
    if (this.#options.createClient) return this.#options.createClient(userId);

    const baseUrl = this.#options.baseUrl ?? readEnv("CORTADEL_BASE_URL") ?? DEFAULT_BASE_URL;
    const apiKey = this.#options.apiKey ?? readEnv("CORTADEL_API_KEY");

    return new CortadelClient({
      baseUrl,
      userId,
      ...(apiKey ? { apiKey } : {}),
      appName: this.appName,
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
    });
  }
}
