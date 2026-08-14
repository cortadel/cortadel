// Config resolution. No network, no server, no CORTADEL_* env required.
import { describe, expect, it } from "vitest";

import { DEFAULT_APP_NAME, DEFAULT_BASE_URL, DEFAULT_USER_ID, isUsableBaseUrl, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("fills in defaults for an empty config with no env", () => {
    const cfg = resolveConfig(undefined, {});
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.userId).toBe(DEFAULT_USER_ID);
    expect(cfg.appName).toBe(DEFAULT_APP_NAME);
    expect(cfg.recallScope).toBe("fixed");
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.corpusSupplement).toBe(true);
    // 5 — the Cortadel-wide default for automatic memory injection.
    expect(cfg.topK).toBe(5);
    expect(cfg.rerank).toBe(false);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.circuitBreaker).toEqual({ maxFailures: 3, cooldownMs: 60_000 });
  });

  it("falls back to env vars, and explicit config still wins", () => {
    const env = {
      CORTADEL_BASE_URL: "https://app.cortadel.ai",
      CORTADEL_API_KEY: "env-key",
      CORTADEL_USER_ID: "e2e-openclaw-env",
    };
    const fromEnv = resolveConfig({}, env);
    expect(fromEnv.baseUrl).toBe("https://app.cortadel.ai");
    expect(fromEnv.apiKey).toBe("env-key");
    expect(fromEnv.userId).toBe("e2e-openclaw-env");

    const explicit = resolveConfig({ baseUrl: "http://localhost:3001", userId: "e2e-openclaw-explicit" }, env);
    expect(explicit.baseUrl).toBe("http://localhost:3001");
    expect(explicit.userId).toBe("e2e-openclaw-explicit");
    // Not overridden explicitly, so the env value still applies.
    expect(explicit.apiKey).toBe("env-key");
  });

  it("clamps out-of-range numbers instead of throwing", () => {
    const cfg = resolveConfig({ topK: 9999, timeoutMs: 1, dedupeWindow: -5, minPromptChars: 1e9 }, {});
    expect(cfg.topK).toBe(50); // Cortadel caps top_k at 50
    expect(cfg.timeoutMs).toBe(250);
    expect(cfg.dedupeWindow).toBe(0);
    expect(cfg.minPromptChars).toBe(4_000);
  });

  it("ignores junk values rather than failing the plugin load", () => {
    const cfg = resolveConfig(
      { topK: "many", recallScope: "galaxy", autoRecall: "yes", baseUrl: "   ", tags: ["a", 7, "  "] } as never,
      {},
    );
    expect(cfg.topK).toBe(5);
    expect(cfg.recallScope).toBe("fixed");
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.tags).toEqual(["a"]);
  });

  it("accepts every documented recall scope", () => {
    for (const scope of ["fixed", "agent", "session", "sender"] as const) {
      expect(resolveConfig({ recallScope: scope }, {}).recallScope).toBe(scope);
    }
  });
});

describe("isUsableBaseUrl", () => {
  it("accepts http and https", () => {
    expect(isUsableBaseUrl("http://localhost:3001")).toBe(true);
    expect(isUsableBaseUrl("https://app.cortadel.ai")).toBe(true);
  });

  it("rejects what the Cortadel SDK constructor would throw on", () => {
    expect(isUsableBaseUrl("")).toBe(false);
    expect(isUsableBaseUrl("not a url")).toBe(false);
    expect(isUsableBaseUrl("/relative/path")).toBe(false);
    expect(isUsableBaseUrl("ftp://example.com")).toBe(false);
  });
});
