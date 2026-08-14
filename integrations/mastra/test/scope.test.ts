import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { describe, expect, it } from "vitest";

import { mergeScopes, resolveUserId, scopeFromMessages, scopeFromRequestContext } from "../src/index.js";

describe("scopeFromMessages", () => {
  it("takes the newest resourceId and threadId", () => {
    const scope = scopeFromMessages([
      { role: "user", resourceId: "e2e-mastra-old", threadId: "thread-old" },
      { role: "assistant", resourceId: "e2e-mastra-new", threadId: "thread-new" },
    ]);
    expect(scope).toEqual({ resourceId: "e2e-mastra-new", threadId: "thread-new" });
  });

  it("fills each field independently from whichever message has it", () => {
    const scope = scopeFromMessages([
      { role: "user", resourceId: "e2e-mastra-alice" },
      { role: "assistant", threadId: "thread-1" },
    ]);
    expect(scope).toEqual({ resourceId: "e2e-mastra-alice", threadId: "thread-1" });
  });

  it("ignores empty strings and junk entries", () => {
    expect(scopeFromMessages([null, 7, { resourceId: "" }])).toEqual({});
    expect(scopeFromMessages(undefined)).toEqual({});
  });
});

describe("scopeFromRequestContext", () => {
  it("reads Mastra's own well-known request-context keys", () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "e2e-mastra-alice");
    requestContext.set(MASTRA_THREAD_ID_KEY, "thread-9");

    expect(scopeFromRequestContext(requestContext)).toEqual({
      resourceId: "e2e-mastra-alice",
      threadId: "thread-9",
    });
  });

  it("is empty for a context that carries neither key", () => {
    expect(scopeFromRequestContext(new RequestContext())).toEqual({
      resourceId: undefined,
      threadId: undefined,
    });
  });

  it("swallows a throwing context rather than failing the run", () => {
    const hostile = {
      get() {
        throw new Error("unknown key");
      },
    };
    expect(scopeFromRequestContext(hostile)).toEqual({});
  });

  it("tolerates no context at all", () => {
    expect(scopeFromRequestContext(undefined)).toEqual({});
  });
});

describe("mergeScopes", () => {
  it("keeps the first non-empty value per field", () => {
    expect(
      mergeScopes({ resourceId: "e2e-a" }, { resourceId: "e2e-b", threadId: "t" }, undefined),
    ).toEqual({ resourceId: "e2e-a", threadId: "t", requestContext: undefined });
  });
});

describe("resolveUserId", () => {
  const scope = { resourceId: "e2e-mastra-resource" };

  it("prefers resolveUserId over everything else", () => {
    const userId = resolveUserId(scope, {
      userId: "e2e-mastra-pinned",
      resolveUserId: (s) => `e2e-tenant:${s.resourceId}`,
    });
    expect(userId).toBe("e2e-tenant:e2e-mastra-resource");
  });

  it("falls through to the pinned userId when resolveUserId returns nothing", () => {
    const userId = resolveUserId(scope, { userId: "e2e-mastra-pinned", resolveUserId: () => undefined });
    expect(userId).toBe("e2e-mastra-pinned");
  });

  it("falls back to Mastra's resourceId", () => {
    expect(resolveUserId(scope, {})).toBe("e2e-mastra-resource");
  });

  it("returns undefined when there is nothing to scope to", () => {
    expect(resolveUserId({}, {})).toBeUndefined();
  });
});
