import type { CortadelOpenClawConfig, CortadelRecallScope, ResolvedCortadelConfig } from "./types.js";

/** Self-hosted default, matching `docker compose up` from the Cortadel repo root. */
export const DEFAULT_BASE_URL = "http://localhost:3001";
/** Recorded on searches for Cortadel access logging. */
export const DEFAULT_APP_NAME = "cortadel-openclaw";
export const DEFAULT_USER_ID = "default";

const DEFAULTS = {
  // 5 is the Cortadel-wide default for automatic memory injection. The
  // `cortadel_search_memory` tool's own `topK` argument falls back to this same
  // value rather than to the SDK's search default of 10, so one knob governs both.
  topK: 5,
  minScore: 0,
  timeoutMs: 5_000,
  dedupeWindow: 200,
  minPromptChars: 8,
  maxFailures: 3,
  cooldownMs: 60_000,
} as const;

const RECALL_SCOPES: readonly CortadelRecallScope[] = ["fixed", "agent", "session", "sender"];

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Trimmed non-empty string, or `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Apply defaults, environment fallbacks, and range clamping to raw plugin config.
 *
 * Env fallbacks exist so a key never has to be written into `openclaw.json`:
 * `CORTADEL_BASE_URL`, `CORTADEL_API_KEY`, and `CORTADEL_USER_ID` fill in for
 * `baseUrl`, `apiKey`, and `userId` respectively. Explicit config always wins.
 *
 * This never throws: a plugin that refuses to load takes the whole agent with
 * it, so bad values are clamped or replaced rather than rejected. `baseUrl` is
 * the one value we cannot invent, and an unusable one is reported by
 * {@link isUsableBaseUrl} so the caller can disable memory and keep going.
 */
export function resolveConfig(
  raw: CortadelOpenClawConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedCortadelConfig {
  const cfg = raw ?? {};
  const breaker = cfg.circuitBreaker ?? {};

  const scope = cfg.recallScope;
  const recallScope: CortadelRecallScope =
    typeof scope === "string" && (RECALL_SCOPES as readonly string[]).includes(scope) ? (scope as CortadelRecallScope) : "fixed";

  return {
    baseUrl: str(cfg.baseUrl) ?? str(env.CORTADEL_BASE_URL) ?? DEFAULT_BASE_URL,
    apiKey: str(cfg.apiKey) ?? str(env.CORTADEL_API_KEY),
    userId: str(cfg.userId) ?? str(env.CORTADEL_USER_ID) ?? DEFAULT_USER_ID,
    appName: str(cfg.appName) ?? DEFAULT_APP_NAME,
    recallScope,
    autoRecall: bool(cfg.autoRecall, true),
    autoCapture: bool(cfg.autoCapture, true),
    corpusSupplement: bool(cfg.corpusSupplement, true),
    promptSupplement: bool(cfg.promptSupplement, true),
    // Cortadel's own contract caps top_k at 50.
    topK: clampInt(cfg.topK, DEFAULTS.topK, 1, 50),
    minScore: clampNumber(cfg.minScore, DEFAULTS.minScore, 0, Number.MAX_SAFE_INTEGER),
    rerank: bool(cfg.rerank, false),
    timeoutMs: clampInt(cfg.timeoutMs, DEFAULTS.timeoutMs, 250, 120_000),
    dedupeWindow: clampInt(cfg.dedupeWindow, DEFAULTS.dedupeWindow, 0, 5_000),
    minPromptChars: clampInt(cfg.minPromptChars, DEFAULTS.minPromptChars, 0, 4_000),
    circuitBreaker: {
      maxFailures: clampInt(breaker.maxFailures, DEFAULTS.maxFailures, 1, 100),
      cooldownMs: clampInt(breaker.cooldownMs, DEFAULTS.cooldownMs, 1_000, 600_000),
    },
    tags: Array.isArray(cfg.tags) ? cfg.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : undefined,
    project: str(cfg.project),
  };
}

/**
 * Whether `baseUrl` is something the Cortadel SDK will accept.
 *
 * The SDK constructor throws a plain `Error` for a blank, relative, or
 * non-http(s) URL. We check first so a typo degrades to "memory disabled with a
 * warning" instead of an exception escaping `register()`.
 */
export function isUsableBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
