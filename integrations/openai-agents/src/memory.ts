/**
 * Shared plumbing: client construction, fail-soft call wrapping, and memory formatting.
 *
 * Two rules govern everything in this module.
 *
 * 1. **Memory must never take down the agent.** Every Cortadel call goes through
 *    {@link callSafely}, which reports and degrades instead of throwing. Callers opt into
 *    strictness with `throwOnError: true`, and observe failures with an `onError` callback.
 * 2. **A Cortadel client is bound to one user id at construction** — no method takes a user id.
 *    So "scope memory to a user" means "build one client per user", which is what
 *    {@link buildClient} exists to make explicit.
 */

import { CortadelClient, CortadelError, type SearchHit } from '@cortadel/sdk';

/** Recorded by the server for access logging on searches. Identifies this integration. */
export const DEFAULT_APP_NAME = 'cortadel-openai-agents';

/** Self-hosted default (`docker compose up`). The hosted service is `https://app.cortadel.ai`. */
export const DEFAULT_BASE_URL = 'http://localhost:3001';

/** Heading of the injected recall block, and the marker used to avoid double-injection. */
export const DEFAULT_MEMORY_HEADER = '# Long-term memory (Cortadel)';

const MEMORY_PREAMBLE =
  'Facts recalled from earlier conversations with this user. Treat them as background ' +
  'knowledge you already have. Use what is relevant, ignore what is not, and prefer what the ' +
  'user says now if it contradicts a recalled fact. Do not mention this block to the user.';

/**
 * Observer for a Cortadel failure. Receives the thrown value; its return value is ignored, and a
 * promise is awaited. It is called for *every* memory failure — observing a failure is
 * independent of whether `throwOnError` then propagates it.
 */
export type OnError = (error: unknown) => unknown;

/** How to reach Cortadel. Shared by {@link CortadelSession} and `cortadelMemoryTools`. */
export interface CortadelConnectionOptions {
  /** Cortadel server URL. Defaults to `$CORTADEL_BASE_URL`, then `http://localhost:3001`. */
  baseUrl?: string;
  /** Bearer token. Defaults to `$CORTADEL_API_KEY`; omit when the server has auth disabled. */
  apiKey?: string;
  /** Recorded for access logging on searches. Defaults to `"cortadel-openai-agents"`. */
  appName?: string;
}

/** Knobs shared by every Cortadel search this package makes. */
export interface RecallOptions {
  /** Cortadel search mode — `hybrid` (default), `text`, or `vector`. */
  searchMode?: string;
  /** Set to `"cross_encoder"` to rerank with the server's cross-encoder. */
  rerank?: string;
  /** Drop hits whose `rrfScore` is below this. `undefined` keeps everything. */
  minScore?: number;
}

/** Fail-open / fail-loud pair, uniform across every Cortadel integration. */
export interface ErrorOptions {
  /**
   * Propagate Cortadel failures to the caller instead of degrading. Defaults to `false` — a
   * memory outage must never take the agent down.
   */
  throwOnError?: boolean;
  /**
   * Called with the thrown value on every Cortadel failure. Replaces the default warning log;
   * may return a promise.
   */
  onError?: OnError;
}

function readEnv(name: string): string | undefined {
  // Guarded so the package still loads in a runtime without `process` (edge, browser bundles).
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }
  const value = process.env[name];
  return value ? value : undefined;
}

/** Explicit argument wins, then `CORTADEL_BASE_URL`, then the self-hosted default. */
export function resolveBaseUrl(baseUrl?: string): string {
  return baseUrl || readEnv('CORTADEL_BASE_URL') || DEFAULT_BASE_URL;
}

/**
 * Explicit argument wins, then `CORTADEL_API_KEY`.
 *
 * `undefined` is valid: a self-hosted server with an empty `Auth:Secret` accepts unauthenticated
 * requests.
 */
export function resolveApiKey(apiKey?: string): string | undefined {
  return apiKey || readEnv('CORTADEL_API_KEY') || undefined;
}

/**
 * Construct a Cortadel client scoped to `userId`.
 *
 * Every seam this package plugs into (`Session.getItems`/`addItems`, `callModelInputFilter`, and
 * `tool()` `execute` bodies) is awaited by the runner, so the promise-based client is the right
 * one throughout — there is no blocking variant in the TypeScript SDK and none is wanted.
 */
export function buildClient(
  userId: string,
  options: CortadelConnectionOptions = {},
): CortadelClient {
  const apiKey = resolveApiKey(options.apiKey);
  return new CortadelClient({
    baseUrl: resolveBaseUrl(options.baseUrl),
    userId,
    ...(apiKey ? { apiKey } : {}),
    appName: options.appName ?? DEFAULT_APP_NAME,
  });
}

/** Describe a thrown value for a log line, unwrapping `CortadelError`'s status/code. */
export function describeError(error: unknown): string {
  if (error instanceof CortadelError) {
    return `status=${error.status} code=${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Hand `error` to `onError`. Returns whether a callback was actually invoked.
 *
 * A callback that throws must not replace the failure it was told about, so its own error is
 * logged and dropped.
 */
export async function notifyError(
  onError: OnError | undefined,
  error: unknown,
  description: string,
): Promise<boolean> {
  if (!onError) {
    return false;
  }
  try {
    await onError(error);
  } catch (callbackError) {
    console.warn(
      `[cortadel-openai-agents] onError callback threw while reporting a ${description} ` +
        `failure: ${describeError(callbackError)}`,
    );
  }
  return true;
}

/**
 * Await `factory()`, degrading to `fallback` when Cortadel is unavailable.
 *
 * `onError` observes the failure either way; `throwOnError` decides whether it then propagates.
 * When a failure is swallowed and no `onError` is set, it is logged as a warning instead — a
 * callback replaces the log, it does not add to it.
 */
export async function callSafely<T>(
  factory: () => Promise<T>,
  options: {
    description: string;
    throwOnError: boolean;
    fallback: T;
    onError?: OnError;
  },
): Promise<T> {
  try {
    return await factory();
  } catch (error) {
    const reported = await notifyError(options.onError, error, options.description);
    if (options.throwOnError) {
      throw error;
    }
    if (!reported) {
      console.warn(
        `[cortadel-openai-agents] Cortadel ${options.description} failed: ${describeError(error)}`,
      );
    }
    return options.fallback;
  }
}

/**
 * Drop hits below `minScore`.
 *
 * `SearchHit.rrfScore` is optional; a hit without one is kept, because the alternative is
 * silently discarding results the server did rank.
 */
export function filterHits(hits: readonly SearchHit[], minScore?: number): SearchHit[] {
  if (minScore === undefined) {
    return [...hits];
  }
  return hits.filter((hit) => hit.rrfScore === undefined || hit.rrfScore === null || hit.rrfScore >= minScore);
}

/** Render hits as a numbered list. Empty string when nothing survives. */
export function formatHitLines(hits: readonly SearchHit[]): string {
  const lines = hits.map((hit) => hit.content?.trim()).filter((line): line is string => !!line);
  if (lines.length === 0) {
    return '';
  }
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

/**
 * Render search hits as the block injected into the model's context.
 *
 * Returns an empty string for no hits, which callers treat as "inject nothing".
 */
export function formatMemoryBlock(
  hits: readonly SearchHit[],
  header: string = DEFAULT_MEMORY_HEADER,
): string {
  const numbered = formatHitLines(hits);
  if (!numbered) {
    return '';
  }
  return `${header}\n${MEMORY_PREAMBLE}\n\n${numbered}`;
}

/**
 * Whether `header` already appears in any of `haystacks`.
 *
 * Guards against double-injection when this filter is chained with another one — or with a
 * second Cortadel session — that already added the block.
 */
export function headerAlreadyPresent(header: string, haystacks: readonly unknown[]): boolean {
  return haystacks.some((text) => typeof text === 'string' && text.includes(header));
}
