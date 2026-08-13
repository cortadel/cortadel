// User-id scoping: how one OpenClaw turn maps onto a Cortadel user id.
import { describe, expect, it } from "vitest";

import { resolveAgentId, resolveSessionScopeKey, resolveUserId, sanitizeDiscriminator } from "../src/scope.js";

const BASE = "e2e-openclaw-scope";

describe("resolveUserId", () => {
  it("fixed scope ignores identity entirely", () => {
    expect(resolveUserId("fixed", BASE, {})).toBe(BASE);
    expect(resolveUserId("fixed", BASE, { agentId: "alpha", sessionKey: "alpha:telegram:42", senderId: "u-1" })).toBe(BASE);
  });

  it("agent scope suffixes the agent id", () => {
    expect(resolveUserId("agent", BASE, { agentId: "Alpha" })).toBe(`${BASE}:alpha`);
  });

  it("agent scope falls back to the session-key prefix", () => {
    expect(resolveUserId("agent", BASE, { sessionKey: "beta:telegram:42" })).toBe(`${BASE}:beta`);
  });

  it("session scope isolates each conversation", () => {
    const a = resolveUserId("session", BASE, { sessionKey: "alpha:telegram:42" });
    const b = resolveUserId("session", BASE, { sessionKey: "alpha:telegram:99" });
    expect(a).not.toBe(b);
    expect(a).toBe(`${BASE}:alpha-telegram-42`);
  });

  it("session scope falls back to sessionId when no key is present", () => {
    expect(resolveUserId("session", BASE, { sessionId: "uuid-123" })).toBe(`${BASE}:uuid-123`);
  });

  it("sender scope isolates each human in a shared chat", () => {
    // `_` is already safe, so it survives sanitizing; only unsafe runs collapse.
    expect(resolveUserId("sender", BASE, { senderId: "U_12345" })).toBe(`${BASE}:u_12345`);
    expect(resolveUserId("sender", BASE, { senderId: "user@example" })).toBe(`${BASE}:user-example`);
  });

  it("falls back to the base user id when the discriminator is missing", () => {
    // Better a predictable shared namespace than a scattering of anonymous ones.
    expect(resolveUserId("sender", BASE, { sessionKey: "alpha:x" })).toBe(BASE);
    expect(resolveUserId("agent", BASE, {})).toBe(BASE);
    expect(resolveUserId("session", BASE, {})).toBe(BASE);
  });

  it("falls back when sanitizing leaves nothing usable", () => {
    expect(resolveUserId("sender", BASE, { senderId: "!!!" })).toBe(BASE);
  });

  it("is stable: the same turn always resolves to the same namespace", () => {
    const identity = { agentId: "alpha", sessionKey: "alpha:discord:7", senderId: "u9" };
    for (const scope of ["fixed", "agent", "session", "sender"] as const) {
      expect(resolveUserId(scope, BASE, identity)).toBe(resolveUserId(scope, BASE, identity));
    }
  });
});

describe("sanitizeDiscriminator", () => {
  it("lowercases and collapses unsafe runs", () => {
    expect(sanitizeDiscriminator("Alpha:Telegram / 42")).toBe("alpha-telegram-42");
  });

  it("trims leading and trailing separators", () => {
    expect(sanitizeDiscriminator("--abc--")).toBe("abc");
  });

  it("caps very long opaque ids", () => {
    expect(sanitizeDiscriminator("x".repeat(500)).length).toBe(96);
  });
});

describe("resolveAgentId", () => {
  it("prefers the explicit agent id over the session-key prefix", () => {
    expect(resolveAgentId({ agentId: "explicit", sessionKey: "prefix:rest" })).toBe("explicit");
  });

  it("returns undefined for a session key with no agent prefix", () => {
    expect(resolveAgentId({ sessionKey: "main" })).toBeUndefined();
    expect(resolveAgentId({})).toBeUndefined();
  });
});

describe("resolveSessionScopeKey", () => {
  it("prefers sessionKey, then sessionId, then agentId", () => {
    expect(resolveSessionScopeKey({ sessionKey: "k", sessionId: "s", agentId: "a" })).toBe("k");
    expect(resolveSessionScopeKey({ sessionId: "s", agentId: "a" })).toBe("s");
    expect(resolveSessionScopeKey({ agentId: "a" })).toBe("a");
    expect(resolveSessionScopeKey({})).toBe("__global__");
  });
});
