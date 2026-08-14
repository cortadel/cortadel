import { CortadelClient } from "@cortadel/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClientProvider,
  DEFAULT_APP_NAME,
  resolveThreadId,
  resolveUserId,
  toRunScope,
} from "../src/index.js";
import { FakeCortadelClient } from "./fakes.js";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  delete process.env.CORTADEL_USER_ID;
  delete process.env.CORTADEL_BASE_URL;
  delete process.env.CORTADEL_API_KEY;
});

describe("toRunScope", () => {
  it("normalises a middleware Runtime", () => {
    const signal = AbortSignal.timeout(60_000);
    const scope = toRunScope({
      context: { user_id: "e2e-ctx" },
      configurable: { thread_id: "e2e-thread-1" },
      signal,
    });
    expect(scope.context).toEqual({ user_id: "e2e-ctx" });
    expect(scope.configurable).toEqual({ thread_id: "e2e-thread-1" });
    expect(scope.signal).toBe(signal);
  });

  it("normalises a ToolRuntime, preferring its nested config", () => {
    const inner = { configurable: { user_id: "e2e-inner" }, signal: AbortSignal.timeout(60_000) };
    const scope = toRunScope({
      ...inner,
      config: inner,
      context: { tenant: "e2e-acme" },
      toolCallId: "call-1",
    });
    expect(scope.configurable).toEqual({ user_id: "e2e-inner" });
    expect(scope.signal).toBe(inner.signal);
    expect(scope.context).toEqual({ tenant: "e2e-acme" });
  });

  it("tolerates nonsense", () => {
    expect(toRunScope(undefined)).toEqual({});
    expect(toRunScope("nope")).toEqual({});
    expect(toRunScope({ configurable: "not-an-object", signal: "not-a-signal" })).toEqual({
      context: undefined,
      configurable: undefined,
      signal: undefined,
    });
  });
});

describe("resolveUserId / resolveThreadId", () => {
  it("prefers runtime.context over runtime.configurable", () => {
    const scope = toRunScope({
      context: { user_id: "e2e-from-context" },
      configurable: { user_id: "e2e-from-configurable" },
    });
    expect(resolveUserId(scope)).toBe("e2e-from-context");
  });

  it("falls back to configurable, then to nothing", () => {
    expect(resolveUserId(toRunScope({ configurable: { user_id: "e2e-cfg" } }))).toBe("e2e-cfg");
    expect(resolveUserId(toRunScope({ context: {}, configurable: {} }))).toBeUndefined();
    expect(resolveUserId(toRunScope({ configurable: { user_id: "" } }))).toBeUndefined();
  });

  it("reads a custom key", () => {
    const scope = toRunScope({ context: { tenant: "e2e-tenant" } });
    expect(resolveUserId(scope, "tenant")).toBe("e2e-tenant");
    expect(resolveUserId(scope)).toBeUndefined();
  });

  /**
   * The other dynamic-key lookup in the package. Unlike the role table in `messages.ts`, this one
   * type-tests its result, and no `Object.prototype` member is a string — so an inherited key
   * resolves to nothing instead of to a function. These lock that in.
   */
  it("resolves nothing from an inherited Object.prototype key", () => {
    const scope = toRunScope({ context: {}, configurable: {} });
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(resolveUserId(scope, key)).toBeUndefined();
    }
  });

  it("disables memory for a run rather than binding it to an inherited member", () => {
    const provider = new ClientProvider({
      baseUrl: "http://localhost:3001",
      userIdKey: "constructor",
    });
    expect(provider.forRun(toRunScope({ context: {}, configurable: {} }))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no Cortadel user id for this run"));
  });

  it("reads the LangGraph thread id", () => {
    expect(resolveThreadId(toRunScope({ configurable: { thread_id: "e2e-thread-9" } }))).toBe("e2e-thread-9");
    expect(resolveThreadId(toRunScope({ configurable: {} }))).toBeUndefined();
  });
});

describe("ClientProvider", () => {
  it("builds a real CortadelClient per user id and caches it", () => {
    const provider = new ClientProvider({ baseUrl: "http://localhost:3001" });
    const first = provider.forUser("e2e-alice");
    const second = provider.forUser("e2e-alice");
    const other = provider.forUser("e2e-bob");

    expect(first).toBeInstanceOf(CortadelClient);
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("defaults appName to the published package name", () => {
    expect(new ClientProvider().appName).toBe("@cortadel/deepagents");
    expect(DEFAULT_APP_NAME).toBe("@cortadel/deepagents");
  });

  it("falls back to the CORTADEL_* environment variables", () => {
    process.env.CORTADEL_USER_ID = "e2e-env-user";
    const built: string[] = [];
    const provider = new ClientProvider({
      clientFactory: (userId) => {
        built.push(userId);
        return new FakeCortadelClient(userId);
      },
    });
    expect(provider.forRun({})).toBeDefined();
    expect(built).toEqual(["e2e-env-user"]);
  });

  it("degrades instead of throwing on an unusable base URL", () => {
    const provider = new ClientProvider({ baseUrl: "not-a-url" });
    expect(provider.forUser("e2e-alice")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not construct a Cortadel client"));
    // Warned once, then quiet.
    provider.forUser("e2e-alice");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports single-user mode for a caller-supplied client", () => {
    const client = new FakeCortadelClient();
    const provider = new ClientProvider({ client });
    expect(provider.isSingleUser).toBe(true);
    expect(provider.forRun({ configurable: { user_id: "e2e-anyone" } })).toBe(client);
    expect(new ClientProvider({ baseUrl: "http://localhost:3001" }).isSingleUser).toBe(false);
  });

  it("warns once when no user id can be resolved", () => {
    const provider = new ClientProvider({ baseUrl: "http://localhost:3001" });
    expect(provider.forRun({})).toBeUndefined();
    expect(provider.forRun({ configurable: {} })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no Cortadel user id for this run"));
  });
});
