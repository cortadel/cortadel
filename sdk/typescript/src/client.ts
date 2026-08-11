// The facade. Owns auth, base URL, userId scoping, error translation, and (via mapping.ts)
// mapping generated results into this package's own DTOs. Reproduces the behavior of
// sdk/dotnet/Cortadel.Sdk/CortadelClient.cs idiomatically, not its syntax — see the task report
// for a point-by-point mapping of the four hard-won .NET behaviors onto their TypeScript
// equivalents.
import type { AuthenticationProvider, RequestInformation } from "@microsoft/kiota-abstractions";
import { CustomFetchHandler, FetchRequestAdapter, HttpClient } from "@microsoft/kiota-http-fetchlibrary";

import { createCortadelApiClient, type CortadelApiClient } from "./generated/cortadelApiClient.js";
import type * as GM from "./generated/models/index.js";
import {
  mapConversationResult,
  mapHealthResult,
  mapMemoryCreated,
  mapMemoryDetail,
  mapMemoryList,
  mapSearchResults,
} from "./mapping.js";
import {
  type AddOptions,
  type ChatMessage,
  type ConversationOptions,
  type ConversationResult,
  CortadelError,
  type CortadelOptions,
  DEFAULT_LIST_SIZE,
  type HealthResult,
  type ListOptions,
  type MemoryCreated,
  type MemoryDetail,
  type MemoryList,
  type SearchOptions,
  type SearchResults,
} from "./models.js";

const DEFAULT_TIMEOUT_MS = 100_000;
const DEFAULT_APP_NAME = "cortadel-typescript";

/** Symbol-keyed so it can never collide with a real property on a thrown value. */
const FALLBACK_STATUS = Symbol("cortadel.fallbackStatus");

type StatusCarrier = { responseStatusCode?: unknown; status?: unknown; [FALLBACK_STATUS]?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * An `AbortSignal`-driven cancellation (the caller's own signal firing, or our per-request
 * timeout expiring) must propagate untouched rather than becoming a `CortadelError` — this is the
 * TypeScript analogue of the .NET facade's narrow `catch` clauses that never swallow
 * `OperationCanceledException`. Checked by name rather than `instanceof Error`/`instanceof
 * DOMException`: `DOMException` does not extend `Error`, and different runtimes/stub fetches
 * surface an aborted request differently, but every one of them sets `.name`.
 */
function isAbortLike(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Attaches the status our own fetch wrapper observed, as a last resort for errors that carry no
 * status of their own (e.g. Kiota's bare `Error` when a response has no Content-Type to parse). */
function attachFallbackStatus(err: unknown, status: number | undefined): void {
  if (status !== undefined && isRecord(err) && !(FALLBACK_STATUS in err)) {
    (err as StatusCarrier)[FALLBACK_STATUS] = status;
  }
}

function resolvedStatus(err: unknown): number {
  if (!isRecord(err)) return 0;
  const carrier = err as StatusCarrier;
  if (typeof carrier.responseStatusCode === "number") return carrier.responseStatusCode;
  if (typeof carrier.status === "number") return carrier.status;
  if (typeof carrier[FALLBACK_STATUS] === "number") return carrier[FALLBACK_STATUS] as number;
  return 0;
}

/** True for the generated `ValidationProblemDetails` shape — the only error schema with `errors`/`title`/`type`/`instance`. */
function isValidationProblemDetailsLike(
  err: unknown,
): err is { detail?: string | null; title?: string | null; errors?: { additionalData?: Record<string, unknown> } | null } {
  return isRecord(err) && ("errors" in err || "title" in err || "type" in err || "instance" in err);
}

/** True for the generated `ErrorResponse` shape — the only error schema with `code`/`messageEscaped`. */
function isErrorResponseLike(err: unknown): err is { code?: string | null; messageEscaped?: string | null } {
  return isRecord(err) && ("code" in err || "messageEscaped" in err);
}

/** True for a real `Error` instance (covers Kiota's `DefaultApiError`, thrown when no error schema is registered for the status code). */
function isErrorInstance(err: unknown): err is Error {
  return err instanceof Error;
}

/** True for the generated `HealthResponse` shape (the contract $refs it for both the 200 and 503
 * bodies, so a degraded server throws its own success-shaped type — see `health()`). Distinguished
 * from ErrorResponse/ValidationProblemDetails by `status` being a *string* ("ok"/"degraded") here
 * versus a numeric HTTP status on the error schemas. */
function isHealthResponseLike(err: unknown): err is GM.HealthResponse {
  if (!isRecord(err)) return false;
  if ("checks" in err) return true;
  return typeof (err as { status?: unknown }).status === "string";
}

function flattenFieldError(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (v == null ? "" : String(v))).join("; ");
  return value == null ? "" : String(value);
}

/**
 * A model-state 400 carries field-level errors in `ValidationProblemDetails.errors` (an open
 * ASP.NET Core ModelState map that lands in Kiota's `additionalData` bag since it has no declared
 * properties). Fold them into the message instead of discarding them — the .NET leg's original
 * opaque "An error occurred" was a documented complaint.
 */
function buildValidationMessage(err: { detail?: string | null; title?: string | null; errors?: { additionalData?: Record<string, unknown> } | null }): string {
  const base = err.detail || err.title || "Validation failed.";
  const fields = err.errors?.additionalData;
  if (!fields || Object.keys(fields).length === 0) return base;
  const parts = Object.entries(fields).map(([key, value]) => `${key}: ${flattenFieldError(value)}`);
  return `${base} (${parts.join(", ")})`;
}

/** Custom auth provider — deliberately not `ApiKeyAuthenticationProvider`: that built-in calls
 * `validateProtocol()` and throws for any non-https host that isn't literally "localhost", which
 * would break every self-hosted `http://box:3001` deployment. This one just sets the header. */
function createAuthProvider(apiKey: string | undefined): AuthenticationProvider {
  return {
    authenticateRequest: async (request: RequestInformation): Promise<void> => {
      if (apiKey) request.headers.add("Authorization", `Bearer ${apiKey}`);
    },
  };
}

/**
 * A thin, typed client for the Cortadel REST API. Create one and reuse it. All calls are scoped
 * to the `userId` given at construction.
 *
 * Internally this is a facade over a Kiota-generated transport (`./generated`); the generated
 * types never appear on this class's public surface (enforced by `src/index.ts`'s exports and its
 * own encapsulation test).
 */
export class CortadelClient {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly appName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly authProvider: AuthenticationProvider;

  constructor(options: CortadelOptions) {
    if (!options || !options.baseUrl || !options.baseUrl.trim()) {
      throw new Error("CortadelOptions.baseUrl is required.");
    }
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new Error(`CortadelOptions.baseUrl must be an absolute URL, got: "${options.baseUrl}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`CortadelOptions.baseUrl must use http or https, got: "${options.baseUrl}"`);
    }
    if (!options.userId || !options.userId.trim()) {
      throw new Error("CortadelOptions.userId is required.");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.userId = options.userId;
    this.appName = options.appName?.trim() || DEFAULT_APP_NAME;
    // Never mutate a caller-supplied fetch: we only ever wrap this reference in our own closure
    // (see `invoke` below) instead of attaching headers/state to it, so a `fetch` shared across
    // multiple CortadelClients (or other callers) is never affected by this client's auth or
    // timeout behavior.
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authProvider = createAuthProvider(options.apiKey);
  }

  /** Store a memory. By default the server extracts entities/categories in the background; set {@link AddOptions.infer} to `false` to store verbatim. */
  async add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated> {
    const body: GM.CreateMemoryRequest = {
      userId: this.userId,
      text,
      app: options?.app ?? null,
      infer: options?.infer ?? true,
      memoryType: options?.memoryType ?? null,
      metadata: options?.metadata ? { additionalData: options.metadata } : null,
    };
    try {
      const res = await this.invokeRequired((api) => api.api.v1.memories.post(body), signal);
      return mapMemoryCreated(res);
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /** Distill a multi-turn conversation into atomic facts and store each one. */
  async addConversation(messages: ChatMessage[], options?: ConversationOptions, signal?: AbortSignal): Promise<ConversationResult> {
    const body: GM.AddConversationRequest = {
      userId: this.userId,
      messages: messages.map((m) => ({ role: m.role, content: m.content, uuid: m.uuid ?? null })),
      isAgentMemory: options?.isAgentMemory ?? false,
      tags: options?.tags ?? null,
      project: options?.project ?? null,
      sessionId: options?.sessionId ?? null,
      transcriptPath: options?.transcriptPath ?? null,
    };
    try {
      const res = await this.invokeRequired((api) => api.api.v1.memories.fromConversation.post(body), signal);
      return mapConversationResult(res);
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /** Hybrid search (BM25 + vector + RRF, optional cross-encoder rerank). */
  async search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults> {
    const body: GM.SearchMemoriesRequest = {
      query,
      userId: this.userId,
      appName: this.appName,
      topK: options?.topK ?? 10,
      mode: options?.mode ?? "hybrid",
      sessionId: options?.sessionId ?? null,
      rerank: options?.rerank ?? null,
      memoryType: options?.memoryType ?? null,
    };
    try {
      const res = await this.invokeRequired((api) => api.api.v1.memories.search.post(body), signal);
      return mapSearchResults(res);
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /** List memories for the user, newest-first, with pagination and optional filters. */
  async list(options?: ListOptions, signal?: AbortSignal): Promise<MemoryList> {
    try {
      const res = await this.invokeRequired(
        (api) =>
          api.api.v1.memories.get({
            queryParameters: {
              userId: this.userId,
              page: options?.page ?? 1,
              size: options?.size ?? DEFAULT_LIST_SIZE,
              appId: options?.appId || undefined,
              categories: options?.categories || undefined,
              searchQuery: options?.searchQuery || undefined,
              // Trap: includeSuperseded is a *string* query param on the generated builder
              // ("true"), not a bool — ListOptions.includeSuperseded is a bool and must be
              // stringified, mirroring the .NET facade's own note on this same trap.
              includeSuperseded: options?.includeSuperseded ? "true" : undefined,
              memoryType: options?.memoryType || undefined,
            },
          }),
        signal,
      );
      return mapMemoryList(res);
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /** Fetch a single memory by id. Returns `null` if it does not exist — including a 404 with an
   * empty body and no Content-Type (what a server returns for an unmatched route, or a proxy 404
   * page), which Kiota's own parser cannot turn into a typed error at all. */
  async get(memoryId: string, signal?: AbortSignal): Promise<MemoryDetail | null> {
    try {
      const res = await this.invoke((api) => api.api.v1.memories.byMemoryId(memoryId).get({ queryParameters: { userId: this.userId } }), signal);
      return res ? mapMemoryDetail(res) : null;
    } catch (err) {
      if (resolvedStatus(err) === 404) return null;
      throw this.translateError(err);
    }
  }

  /** Delete one or more memories. Returns the server's confirmation message. */
  async delete(memoryIds: string[], signal?: AbortSignal): Promise<string> {
    const body: GM.DeleteMemoriesRequest = { userId: this.userId, memoryIds };
    try {
      const res = await this.invokeRequired((api) => api.api.v1.memories.delete(body), signal);
      return res.message ?? "";
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /** Server health (database + embedding provider reachability). */
  async health(signal?: AbortSignal): Promise<HealthResult> {
    try {
      const res = await this.invokeRequired((api) => api.api.health.get(), signal);
      return mapHealthResult(res);
    } catch (err) {
      // Trap: the contract $refs HealthResponse for both the 200 and the 503 body, so Kiota
      // error-maps the 503 and a degraded server throws its own success-shaped type rather than
      // returning it. The documented surface never throws on "degraded" — only on
      // transport/unexpected-status failures — so catch it and map it like a normal body.
      if (isHealthResponseLike(err)) return mapHealthResult(err);
      throw this.translateError(err);
    }
  }

  // ── Generated call execution ────────────────────────────────────────────

  /**
   * Composes the per-call `AbortSignal` (if any) with the client's timeout. Kiota's TypeScript
   * runtime has no cancellation support of its own (no `signal` anywhere in
   * `@microsoft/kiota-http-fetchlibrary`'s request path) — this client adds it by threading the
   * combined signal into the `fetch` wrapper built fresh for each call, see `invoke` below.
   */
  private composeSignal(callerSignal?: AbortSignal): AbortSignal | undefined {
    const signals: AbortSignal[] = [];
    if (callerSignal) signals.push(callerSignal);
    if (this.timeoutMs > 0) signals.push(AbortSignal.timeout(this.timeoutMs));
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }

  /**
   * Builds a fresh request adapter (and generated client) for a single call and runs `op` against
   * it. Deliberately per-call rather than one shared instance held for the client's lifetime: the
   * `fetch` wrapper below is the only way to recover the real HTTP status when Kiota's own parser
   * fails before it can attach one (see `get`'s 404 handling), and capturing that status in a
   * variable shared across concurrent calls on one client would race. Building lightweight Kiota
   * wrapper objects per call costs nothing that matters — the actual network stack (whatever
   * `fetch` implementation is underneath) is unaffected and keeps its own connection pooling
   * regardless of how many small JS objects wrap it.
   */
  private async invoke<T>(op: (api: CortadelApiClient) => Promise<T | undefined>, signal?: AbortSignal): Promise<T | undefined> {
    const status: { value?: number } = {};
    const combinedSignal = this.composeSignal(signal);
    const customFetch = async (url: string, init: RequestInit): Promise<Response> => {
      const res = await this.fetchImpl(url, combinedSignal ? { ...init, signal: combinedSignal } : init);
      status.value = res.status;
      return res;
    };
    // Deliberately bypass Kiota's default middleware chain (only `CustomFetchHandler` runs) by
    // passing an explicit middleware list: `HttpClient`'s default chain includes a `RetryHandler`
    // that silently retries 429/503/504 up to 3 times with multi-second delays. That would make a
    // degraded-health 503 (see `health()`'s HealthResponse quirk) take several seconds to surface
    // instead of returning immediately, and no caller of this facade opted into hidden retries.
    // The .NET facade avoids this the same way, just by construction: `HttpClientRequestAdapter`
    // there wraps a bare `HttpClient` that never goes through Kiota's `KiotaClientFactory`
    // pipeline, so it never gets a retry handler either.
    const httpClient = new HttpClient(customFetch, new CustomFetchHandler(customFetch));
    const adapter = new FetchRequestAdapter(this.authProvider, undefined, undefined, httpClient);
    adapter.baseUrl = this.baseUrl;
    try {
      return await op(createCortadelApiClient(adapter));
    } catch (err) {
      attachFallbackStatus(err, status.value);
      throw err;
    }
  }

  /** Same as `invoke`, but a successful call resolving to `undefined` (an empty body Kiota still
   * treated as success) is itself an error — matches the .NET facade's `ExecuteAsync`. */
  private async invokeRequired<T>(op: (api: CortadelApiClient) => Promise<T | undefined>, signal?: AbortSignal): Promise<T> {
    const res = await this.invoke(op, signal);
    if (res === undefined) throw new CortadelError(502, "empty_response", "The server returned an empty response.");
    return res;
  }

  /**
   * Translates whatever `invoke`/`invokeRequired` threw into a `CortadelError` carrying real
   * status/code/message — except cancellation, which must never become a `CortadelError` (see
   * `isAbortLike`), and an already-translated `CortadelError`, returned unchanged so `get`/`health`
   * can call this after their own bespoke handling without double-wrapping.
   */
  private translateError(err: unknown): unknown {
    if (err instanceof CortadelError) return err;
    if (isAbortLike(err)) return err;

    const status = resolvedStatus(err);
    if (isValidationProblemDetailsLike(err)) {
      return new CortadelError(status, "validation_error", buildValidationMessage(err));
    }
    if (isErrorResponseLike(err)) {
      const message = err.messageEscaped;
      return new CortadelError(status, err.code || "http_error", message || "The request failed.");
    }
    if (isErrorInstance(err)) {
      return new CortadelError(status, "http_error", err.message || "The request failed.");
    }
    return new CortadelError(status, "transport_error", "The request failed.");
  }
}
