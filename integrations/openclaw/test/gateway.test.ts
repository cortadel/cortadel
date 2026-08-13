// Failure containment: an unreachable Cortadel must never throw into the agent.
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
import { CircuitBreaker, CortadelGateway, describeError } from "../src/gateway.js";
import { cortadelError, FakeCortadelClient, recordingLogger, TEST_USER } from "./helpers.js";

function gatewayWith(raw: Parameters<typeof resolveConfig>[0], client = new FakeCortadelClient(), enabled = true) {
  const logger = recordingLogger();
  const config = resolveConfig({ userId: TEST_USER, ...raw }, {});
  const gateway = new CortadelGateway(config, () => client, logger, enabled);
  return { gateway, logger, client };
}

describe("CortadelGateway.call", () => {
  it("returns the value on success", async () => {
    const { gateway, client } = gatewayWith({});
    client.searchResult = { query: "q", results: [], total: 0 };
    const outcome = await gateway.call(TEST_USER, "test", (c, s) => c.search("q", undefined, s));
    expect(outcome).toEqual({ ok: true, value: { query: "q", results: [], total: 0 } });
  });

  it("captures a CortadelError instead of throwing, and warns", async () => {
    const { gateway, logger, client } = gatewayWith({});
    client.failure = cortadelError(503, "http_error", "service unavailable");

    const outcome = await gateway.call(TEST_USER, "test", (c, s) => c.search("q", undefined, s));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("error");
    expect(outcome.message).toContain("503");
    expect(logger.lines.some((l) => l.startsWith("warn:"))).toBe(true);
  });

  it("captures a non-Error throw", async () => {
    const { gateway, client } = gatewayWith({});
    client.failure = "kaboom";
    const outcome = await gateway.call(TEST_USER, "test", (c, s) => c.search("q", undefined, s));
    expect(outcome.ok).toBe(false);
  });

  it("short-circuits when disabled, without touching the client", async () => {
    const { gateway, client } = gatewayWith({}, new FakeCortadelClient(), false);
    const outcome = await gateway.call(TEST_USER, "test", (c, s) => c.search("q", undefined, s));
    expect(outcome).toMatchObject({ ok: false, reason: "disabled" });
    expect(client.searches).toHaveLength(0);
  });

  it("stops calling once the breaker opens, then retries after the cooldown", async () => {
    const logger = recordingLogger();
    const config = resolveConfig({ userId: TEST_USER, circuitBreaker: { maxFailures: 2, cooldownMs: 30_000 } }, {});
    const client = new FakeCortadelClient();
    client.failure = cortadelError(0, "transport_error", "connection refused");

    let now = 1_000;
    const gateway = new CortadelGateway(config, () => client, logger, true, () => now);
    const call = () => gateway.call(TEST_USER, "test", (c, s) => c.search("q", undefined, s));

    expect((await call()).ok).toBe(false);
    expect((await call()).ok).toBe(false);
    expect(client.searches).toHaveLength(2);

    // Breaker is now open: no further calls reach the client.
    const blocked = await call();
    expect(blocked).toMatchObject({ ok: false, reason: "open-circuit" });
    expect(client.searches).toHaveLength(2);

    // After the cooldown it half-opens and lets one probe through.
    now += 30_000;
    client.failure = undefined;
    const recovered = await call();
    expect(recovered.ok).toBe(true);
    expect(client.searches).toHaveLength(3);
  });

  it("passes an abort signal so a hung server cannot stall a turn", async () => {
    const { gateway } = gatewayWith({ timeoutMs: 250 });
    let seen: AbortSignal | undefined;
    await gateway.call(TEST_USER, "test", async (_c, signal) => {
      seen = signal;
      return null;
    });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe("CortadelGateway client registry", () => {
  it("builds one client per user id and reuses it", () => {
    const config = resolveConfig({ userId: TEST_USER }, {});
    let built = 0;
    const gateway = new CortadelGateway(
      config,
      (userId) => {
        built += 1;
        return new FakeCortadelClient(userId);
      },
      recordingLogger(),
    );

    const a1 = gateway.clientFor("u1");
    const a2 = gateway.clientFor("u1");
    const b = gateway.clientFor("u2");

    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(built).toBe(2);
  });

  it("resolves the user id from the configured scope", () => {
    const { gateway } = gatewayWith({ recallScope: "agent" });
    expect(gateway.userIdFor({ agentId: "alpha" })).toBe(`${TEST_USER}:alpha`);
    expect(gateway.userIdFor({})).toBe(TEST_USER);
  });
});

describe("CircuitBreaker", () => {
  it("stays closed below the threshold", () => {
    const breaker = new CircuitBreaker(3, 1_000, () => 0);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  it("a success resets the failure streak", () => {
    const breaker = new CircuitBreaker(2, 1_000, () => 0);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });
});

describe("describeError", () => {
  it("names a timeout plainly", () => {
    expect(describeError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toContain("timed out");
    // The SDK deliberately propagates aborts untouched rather than wrapping them.
    expect(describeError(Object.assign(new Error("x"), { name: "AbortError" }))).toContain("timed out");
  });

  it("includes the Cortadel status and code", () => {
    expect(describeError(cortadelError(404, "not_found", "missing"))).toBe("cortadel not_found (404): missing");
  });

  it("falls back to the message, then to String()", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError(42)).toBe("42");
  });
});
