import type { CortadelLogger, CortadelMemoryClient, ResolvedCortadelConfig, TurnIdentity } from "./types.js";
import { resolveUserId } from "./scope.js";

/**
 * Everything between the plugin and the Cortadel server.
 *
 * Two jobs, both about not breaking the agent:
 *
 * 1. **One client per user id.** A `CortadelClient` is bound to a single user id
 *    at construction, so per-turn scoping means keeping a registry of clients
 *    rather than passing a user id per call.
 * 2. **Failure containment.** Memory is an enhancement; an unreachable Cortadel
 *    server must never take down the agent or slow every turn to the timeout.
 *    Each call gets a deadline, every throw is captured, and a circuit breaker
 *    stops hammering a server that is already failing.
 */

/** Result of a guarded Cortadel call. Never a throw. */
export type GatewayResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "disabled" | "open-circuit" | "error"; message: string };

/** Builds a client bound to one user id. Swapped for a fake in tests. */
export type CortadelClientFactory = (userId: string) => CortadelMemoryClient;

/** Cap on cached clients, so `session` scoping cannot grow the registry without bound. */
const MAX_CACHED_CLIENTS = 256;

/**
 * Consecutive-failure breaker with a cooldown.
 *
 * Mirrors the shape OpenClaw's own bundled active-memory plugin uses
 * (`circuitBreakerMaxTimeouts` / `circuitBreakerCooldownMs`) so operators see
 * familiar behaviour: after N consecutive failures, skip memory entirely until
 * the cooldown expires, then allow one probe.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;

  constructor(
    private readonly maxFailures: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when calls should be skipped. Self-closes once the cooldown elapses. */
  isOpen(): boolean {
    if (this.openedAt === undefined) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      // Cooldown elapsed: half-open. Let the next call through and judge by its result.
      this.openedAt = undefined;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.maxFailures) this.openedAt = this.now();
  }
}

/** Cap on a rendered object, so one odd throw cannot emit an unbounded log line. */
const MAX_RENDERED_ERROR = 200;

/**
 * Describe a thrown object that carries no usable `message`.
 *
 * `String(obj)` is `"[object Object]"` for anything that does not override
 * `toString`, which discards every field the log line existed to carry. JSON
 * keeps the shape. It can still fail (circular references, `BigInt`) or yield
 * nothing (a `toJSON` returning `undefined`), so the plain cast stays as the
 * last resort.
 */
function renderErrorValue(err: object): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(err) ?? String(err);
  } catch {
    // Circular or non-serialisable — fall back to whatever `toString` gives.
    rendered = String(err);
  }
  return rendered.length > MAX_RENDERED_ERROR ? `${rendered.slice(0, MAX_RENDERED_ERROR)}…` : rendered;
}

/**
 * Turn an unknown thrown value into one readable line.
 *
 * Covers the three shapes the Cortadel SDK can produce: `CortadelError` (which
 * carries `status`/`code`), an abort or timeout (which the SDK deliberately
 * propagates untouched rather than wrapping), and anything else.
 */
export function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; message?: unknown; status?: unknown; code?: unknown };
    if (e.name === "TimeoutError" || e.name === "AbortError") return "cortadel request timed out";
    const status = typeof e.status === "number" ? e.status : undefined;
    const code = typeof e.code === "string" ? e.code : undefined;
    const message = typeof e.message === "string" ? e.message : renderErrorValue(err);
    // Built separately rather than nested inline: a template literal inside a
    // template literal's interpolation is a readability trap.
    const statusSuffix = status === undefined ? "" : ` (${status})`;
    if (status !== undefined || code !== undefined) {
      return `cortadel ${code ?? "error"}${statusSuffix}: ${message}`;
    }
    return message;
  }
  return String(err);
}

export class CortadelGateway {
  private readonly clients = new Map<string, CortadelMemoryClient>();
  private readonly breaker: CircuitBreaker;

  constructor(
    readonly config: ResolvedCortadelConfig,
    private readonly factory: CortadelClientFactory,
    private readonly logger: CortadelLogger,
    /** When false every call short-circuits to `{ ok: false, reason: "disabled" }`. */
    private readonly enabled: boolean = true,
    now: () => number = Date.now,
  ) {
    this.breaker = new CircuitBreaker(config.circuitBreaker.maxFailures, config.circuitBreaker.cooldownMs, now);
  }

  /** The Cortadel user id this turn's memories belong to. */
  userIdFor(identity: TurnIdentity): string {
    return resolveUserId(this.config.recallScope, this.config.userId, identity);
  }

  /** Client for a user id, constructed on first use and reused afterwards. */
  clientFor(userId: string): CortadelMemoryClient {
    const cached = this.clients.get(userId);
    if (cached) {
      // Refresh LRU position so the hottest namespaces survive eviction.
      this.clients.delete(userId);
      this.clients.set(userId, cached);
      return cached;
    }
    const client = this.factory(userId);
    if (this.clients.size >= MAX_CACHED_CLIENTS) {
      const oldest = this.clients.keys().next();
      if (!oldest.done) this.clients.delete(oldest.value);
    }
    this.clients.set(userId, client);
    return client;
  }

  /**
   * Run one Cortadel call under the breaker and a deadline.
   *
   * Resolves to a result object in every case — including timeout, transport
   * failure, and an open breaker — so no caller has to guard against a throw.
   */
  async call<T>(userId: string, label: string, fn: (client: CortadelMemoryClient, signal: AbortSignal) => Promise<T>): Promise<GatewayResult<T>> {
    if (!this.enabled) return { ok: false, reason: "disabled", message: "cortadel memory is disabled" };
    if (this.breaker.isOpen()) {
      this.logger.debug?.(`[cortadel] skipping ${label}: circuit breaker open`);
      return { ok: false, reason: "open-circuit", message: "cortadel is temporarily unavailable" };
    }

    try {
      const value = await fn(this.clientFor(userId), AbortSignal.timeout(this.config.timeoutMs));
      this.breaker.recordSuccess();
      return { ok: true, value };
    } catch (err) {
      this.breaker.recordFailure();
      const message = describeError(err);
      this.logger.warn(`[cortadel] ${label} failed: ${message}`);
      return { ok: false, reason: "error", message };
    }
  }
}
