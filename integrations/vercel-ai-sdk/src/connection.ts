import { CortadelClient } from "@cortadel/sdk";

import type { CortadelConnectionOptions, CortadelMemoryClient } from "./types.js";

/**
 * App name recorded on Cortadel searches made through this integration.
 *
 * It is this package's own published npm name, deliberately: an access log entry that names the
 * integration is the only way to tell, server-side, which client a search came from.
 */
export const DEFAULT_APP_NAME = "cortadel-vercel-ai-provider";

const DEFAULT_CLIENT_CACHE_SIZE = 64;

/**
 * Resolves a Cortadel client for a given user id.
 *
 * A Cortadel client is bound to one user id at construction, so multi-tenant use needs one client
 * per user. Clients are cheap (they hold no socket of their own — the SDK builds a fresh transport
 * per call and never mutates your `fetch`), but they are not free to construct on every token, so
 * they are cached with a bounded, insertion-ordered map.
 */
export class ClientResolver {
  private readonly fixedClient?: CortadelMemoryClient;
  private readonly defaultUserId?: string;
  private readonly cache = new Map<string, CortadelMemoryClient>();
  private readonly cacheSize: number;
  private readonly options: CortadelConnectionOptions;

  constructor(options: CortadelConnectionOptions) {
    if (options.client == null && options.baseUrl == null) {
      throw new Error(
        "Cortadel: provide either `client` or `baseUrl`. " +
          'Example: cortadelMemory({ baseUrl: "http://localhost:3001", userId: "e2e-alice" }).',
      );
    }
    if (options.client != null && options.baseUrl != null) {
      throw new Error(
        "Cortadel: `client` and `baseUrl` are mutually exclusive — a client already carries its " +
          "own base URL and user id.",
      );
    }
    if (options.client == null && !options.userId) {
      // Not fatal: a per-request providerOptions.cortadel.userId can still supply it. But a
      // middleware with neither is silently inert, which is a worse failure than a loud one.
      throw new Error(
        "Cortadel: `userId` is required unless you pass a pre-built `client`. It can still be " +
          "overridden per request with providerOptions.cortadel.userId.",
      );
    }

    this.options = options;
    this.fixedClient = options.client;
    this.defaultUserId = options.userId;
    this.cacheSize = options.clientCacheSize ?? DEFAULT_CLIENT_CACHE_SIZE;
  }

  /**
   * Whether a per-request user id can change which memories are touched. False when the caller
   * supplied their own client, since that client's user id is fixed and unreadable.
   */
  get supportsPerRequestUserId(): boolean {
    return this.fixedClient == null;
  }

  /**
   * The user id to attribute a call to. With a caller-supplied client the real user id is unknown,
   * so `userId` (if given) is used purely as a label for error/telemetry context.
   */
  resolveUserId(requestUserId?: string): string | undefined {
    if (this.fixedClient != null) {
      return this.defaultUserId ?? "<client-bound>";
    }
    return requestUserId ?? this.defaultUserId;
  }

  /** Returns the client for `userId`, constructing and caching one if needed. */
  resolve(userId: string): CortadelMemoryClient {
    if (this.fixedClient != null) {
      return this.fixedClient;
    }

    const cached = this.cache.get(userId);
    if (cached != null) {
      return cached;
    }

    const client = new CortadelClient({
      baseUrl: this.options.baseUrl as string,
      userId,
      apiKey: this.options.apiKey,
      appName: this.options.appName ?? DEFAULT_APP_NAME,
      fetch: this.options.fetch,
      timeoutMs: this.options.timeoutMs,
    });

    if (this.cacheSize > 0) {
      if (this.cache.size >= this.cacheSize) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) {
          this.cache.delete(oldest.value);
        }
      }
      this.cache.set(userId, client);
    }

    return client;
  }
}
