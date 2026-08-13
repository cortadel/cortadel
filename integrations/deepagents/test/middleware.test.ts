import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CORTADEL_SYSTEM_PROMPT,
  EMPTY_MEMORY_PLACEHOLDER,
  createCortadelMemoryMiddleware,
} from "../src/index.js";
import { FakeCortadelClient, cortadelError, hit } from "./fakes.js";

type Middleware = ReturnType<typeof createCortadelMemoryMiddleware>;

/**
 * `AgentMiddleware`'s hooks are typed as `handler | { hook, canJumpTo }`. `createMiddleware` stores
 * whatever it was handed verbatim (`langchain/dist/agents/middleware.js`), so these narrow the
 * union back to the plain functions this package registers.
 */
function beforeAgent(middleware: Middleware) {
  const hook = middleware.beforeAgent;
  if (typeof hook !== "function") throw new Error("beforeAgent is not a plain handler");
  return hook as (state: any, runtime: any) => Promise<any>;
}

function afterAgent(middleware: Middleware) {
  const hook = middleware.afterAgent;
  if (typeof hook !== "function") throw new Error("afterAgent is not a plain handler");
  return hook as (state: any, runtime: any) => Promise<any>;
}

function wrapModelCall(middleware: Middleware) {
  const hook = middleware.wrapModelCall;
  if (typeof hook !== "function") throw new Error("wrapModelCall is not registered");
  return hook as (request: any, handler: (request: any) => any) => any;
}

/**
 * A stand-in runtime for the direct-hook tests below.
 *
 * Read the caveat before trusting a test in this file: calling a hook directly proves what the hook
 * does with a runtime, never that the real runtime hands it one shaped this way. That gap hid a
 * blocking bug — the middleware had no `contextSchema`, so LangChain gave it a frozen *empty*
 * `runtime.context` and every `{ context: { user_id } }` case here passed against a runtime that
 * could not occur. Anything about how a run reaches the middleware belongs in
 * `agent-integration.test.ts`, where `createDeepAgent(...).invoke(...)` drives it for real.
 */
const RUNTIME = { context: {}, configurable: { thread_id: "e2e-thread-1" } };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("registration", () => {
  it("registers a named middleware with the two memory tools", () => {
    const middleware = createCortadelMemoryMiddleware({ client: new FakeCortadelClient() });
    expect(middleware.name).toBe("CortadelMemoryMiddleware");
    expect(middleware.tools?.map((tool) => (tool as { name: string }).name)).toEqual([
      "search_memory",
      "add_memories",
    ]);
  });

  it("omits the tools when exposeTools is false", () => {
    const middleware = createCortadelMemoryMiddleware({
      client: new FakeCortadelClient(),
      exposeTools: false,
    });
    expect(middleware.tools).toEqual([]);
  });

  it("declares only underscore-private state keys", () => {
    const middleware = createCortadelMemoryMiddleware({ client: new FakeCortadelClient() });
    const shape = Object.keys((middleware.stateSchema as { shape: object }).shape);
    expect(shape).toEqual([
      "_cortadelMemories",
      "_cortadelRecallQuery",
      "_cortadelPersistedCount",
    ]);
    // LangChain's FilterPrivateProps strips `_`-prefixed keys from the agent's public state.
    expect(shape.every((key) => key.startsWith("_"))).toBe(true);
  });

  it("rejects a system prompt without the memory slot", () => {
    expect(() =>
      createCortadelMemoryMiddleware({ client: new FakeCortadelClient(), systemPrompt: "no slot" }),
    ).toThrow(/\{cortadelMemories\}/);
  });

  it("rejects a non-string system prompt", () => {
    expect(() =>
      createCortadelMemoryMiddleware({
        client: new FakeCortadelClient(),
        systemPrompt: 42 as unknown as string,
      }),
    ).toThrow(TypeError);
  });
});

describe("recall (beforeAgent)", () => {
  it("searches for the latest human message and stores the hits in private state", async () => {
    const client = new FakeCortadelClient();
    client.hits = [hit("m1", "The user ships on Fridays.", { createdAt: "2026-01-02T03:04:05Z", rrfScore: 0.5 })];
    const middleware = createCortadelMemoryMiddleware({ client });

    const update = await beforeAgent(middleware)(
      { messages: [new HumanMessage("when do we ship?")] },
      RUNTIME,
    );

    expect(client.searchCalls).toHaveLength(1);
    expect(client.searchCalls[0]!.query).toBe("when do we ship?");
    expect(client.searchCalls[0]!.options).toMatchObject({ topK: 5, mode: "hybrid" });
    expect(update).toEqual({
      _cortadelMemories: [
        { id: "m1", content: "The user ships on Fridays.", createdAt: "2026-01-02T03:04:05Z", score: 0.5 },
      ],
      _cortadelRecallQuery: "when do we ship?",
    });
  });

  it("does nothing when the turn has no human message", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client });

    const update = await beforeAgent(middleware)({ messages: [new AIMessage("hi")] }, RUNTIME);

    expect(update).toBeUndefined();
    expect(client.searchCalls).toHaveLength(0);
  });

  it("does not re-search when the recall query is unchanged (resumed run)", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client });

    const state = {
      messages: [new HumanMessage("same question")],
      _cortadelRecallQuery: "same question",
    };
    expect(await beforeAgent(middleware)(state, RUNTIME)).toBeUndefined();
    expect(client.searchCalls).toHaveLength(0);
  });

  it("honours topK, searchMode, rerank and memoryType", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({
      client,
      topK: 3,
      searchMode: "vector",
      rerank: true,
      memoryType: "semantic",
    });

    await beforeAgent(middleware)({ messages: [new HumanMessage("q")] }, RUNTIME);

    expect(client.searchCalls[0]!.options).toEqual({
      topK: 3,
      mode: "vector",
      rerank: "cross_encoder",
      memoryType: "semantic",
    });
  });

  it("passes the thread id as sessionId only when scopeRecallToSession is on", async () => {
    const scoped = new FakeCortadelClient();
    await beforeAgent(createCortadelMemoryMiddleware({ client: scoped, scopeRecallToSession: true }))(
      { messages: [new HumanMessage("q")] },
      RUNTIME,
    );
    expect(scoped.searchCalls[0]!.options).toMatchObject({ sessionId: "e2e-thread-1" });

    const unscoped = new FakeCortadelClient();
    await beforeAgent(createCortadelMemoryMiddleware({ client: unscoped }))(
      { messages: [new HumanMessage("q")] },
      RUNTIME,
    );
    expect(unscoped.searchCalls[0]!.options).not.toHaveProperty("sessionId");
  });

  it("threads the run's AbortSignal into the search", async () => {
    const client = new FakeCortadelClient();
    const signal = AbortSignal.timeout(60_000);
    await beforeAgent(createCortadelMemoryMiddleware({ client }))(
      { messages: [new HumanMessage("q")] },
      { ...RUNTIME, signal },
    );
    expect(client.searchCalls[0]!.signal).toBe(signal);
  });
});

describe("injection (wrapModelCall)", () => {
  it("appends the recalled block to the system message without touching the transcript", () => {
    const middleware = createCortadelMemoryMiddleware({ client: new FakeCortadelClient() });
    const messages = [new HumanMessage("hello")];
    const request = {
      systemMessage: new SystemMessage("You are a deep agent."),
      messages,
      state: {
        _cortadelMemories: [{ id: "m1", content: "The user prefers dark mode.", createdAt: "2026-01-02T00:00:00Z" }],
      },
    };

    let seen: any;
    wrapModelCall(middleware)(request, (next) => {
      seen = next;
      return new AIMessage("ok");
    });

    expect(seen.systemMessage.text).toContain("You are a deep agent.");
    expect(seen.systemMessage.text).toContain("1. The user prefers dark mode. [recorded 2026-01-02]");
    expect(seen.systemMessage.text).toContain("<cortadel_memory>");
    // The original request object and the conversation are untouched.
    expect(request.systemMessage.text).toBe("You are a deep agent.");
    expect(seen.messages).toBe(messages);
  });

  it("renders a placeholder when nothing was recalled", () => {
    const middleware = createCortadelMemoryMiddleware({ client: new FakeCortadelClient() });
    let seen: any;
    wrapModelCall(middleware)(
      { systemMessage: new SystemMessage(""), messages: [], state: {} },
      (next) => {
        seen = next;
        return new AIMessage("ok");
      },
    );
    expect(seen.systemMessage.text).toContain(EMPTY_MEMORY_PLACEHOLDER);
  });

  it("injects nothing when systemPrompt is null", () => {
    const middleware = createCortadelMemoryMiddleware({
      client: new FakeCortadelClient(),
      systemPrompt: null,
    });
    const request = { systemMessage: new SystemMessage("base"), messages: [], state: {} };
    let seen: any;
    wrapModelCall(middleware)(request, (next) => {
      seen = next;
      return new AIMessage("ok");
    });
    expect(seen).toBe(request);
  });

  it("uses a custom template's slot", () => {
    const middleware = createCortadelMemoryMiddleware({
      client: new FakeCortadelClient(),
      systemPrompt: "REMEMBERED:\n{cortadelMemories}",
    });
    let seen: any;
    wrapModelCall(middleware)(
      {
        systemMessage: new SystemMessage("base"),
        messages: [],
        state: { _cortadelMemories: [{ id: "m1", content: "a fact" }] },
      },
      (next) => {
        seen = next;
        return new AIMessage("ok");
      },
    );
    expect(seen.systemMessage.text).toBe("base\n\nREMEMBERED:\n1. a fact");
    expect(seen.systemMessage.text).not.toContain(CORTADEL_SYSTEM_PROMPT.slice(0, 20));
  });
});

describe("persistence (afterAgent)", () => {
  const turn = [new HumanMessage("remember I ship on Fridays"), new AIMessage("Noted.")];

  it("persists the human/assistant dialogue and advances the cursor", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client });

    const update = await afterAgent(middleware)({ messages: turn }, RUNTIME);

    expect(client.conversationCalls).toHaveLength(1);
    expect(client.conversationCalls[0]!.messages).toEqual([
      { role: "user", content: "remember I ship on Fridays" },
      { role: "assistant", content: "Noted." },
    ]);
    expect(client.conversationCalls[0]!.options).toMatchObject({
      isAgentMemory: false,
      sessionId: "e2e-thread-1",
    });
    expect(update).toEqual({ _cortadelPersistedCount: 2 });
  });

  it("only sends the suffix after the cursor, never re-ingesting history", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client });

    const update = await afterAgent(middleware)(
      { messages: [...turn, new HumanMessage("and on Mondays")], _cortadelPersistedCount: 2 },
      RUNTIME,
    );

    expect(client.conversationCalls[0]!.messages).toEqual([
      { role: "user", content: "and on Mondays" },
    ]);
    expect(update).toEqual({ _cortadelPersistedCount: 3 });
  });

  it("does nothing when the cursor already covers every message", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client });
    const update = await afterAgent(middleware)(
      { messages: turn, _cortadelPersistedCount: 2 },
      RUNTIME,
    );
    expect(client.conversationCalls).toHaveLength(0);
    expect(update).toBeUndefined();
  });

  it("skips tool traffic and leaves the cursor put", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client });
    const update = await afterAgent(middleware)(
      {
        messages: [
          new AIMessage({ content: "", tool_calls: [{ id: "1", name: "ls", args: {} }] }),
          new ToolMessage({ content: "a.txt", tool_call_id: "1" }),
        ],
      },
      RUNTIME,
    );
    expect(client.conversationCalls).toHaveLength(0);
    expect(update).toBeUndefined();
  });

  it("does nothing when writeMemories is off", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client, writeMemories: false });
    expect(await afterAgent(middleware)({ messages: turn }, RUNTIME)).toBeUndefined();
    expect(client.conversationCalls).toHaveLength(0);
  });

  it("forwards tags, project and isAgentMemory", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({
      client,
      tags: ["deepagents"],
      project: "e2e-project",
      isAgentMemory: true,
    });
    await afterAgent(middleware)({ messages: turn }, RUNTIME);
    expect(client.conversationCalls[0]!.options).toEqual({
      isAgentMemory: true,
      tags: ["deepagents"],
      project: "e2e-project",
      sessionId: "e2e-thread-1",
    });
  });

  it("awaits the write by default", async () => {
    const client = new FakeCortadelClient();
    client.blockConversation();
    const middleware = createCortadelMemoryMiddleware({ client });

    let settled = false;
    const pending = afterAgent(middleware)({ messages: turn }, RUNTIME).then((update) => {
      settled = true;
      return update;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    client.flush();
    expect(await pending).toEqual({ _cortadelPersistedCount: 2 });
  });

  it("returns immediately and advances the cursor when awaitPersist is false", async () => {
    const client = new FakeCortadelClient();
    client.blockConversation();
    const middleware = createCortadelMemoryMiddleware({ client, awaitPersist: false });

    const update = await afterAgent(middleware)({ messages: turn }, RUNTIME);

    expect(update).toEqual({ _cortadelPersistedCount: 2 });
    expect(client.conversationCalls).toHaveLength(1);
    // No `signal`: a detached write must not be cancelled by the run tearing down around it.
    expect(client.conversationCalls[0]!.signal).toBeUndefined();
    client.flush();
  });
});

describe("degrading gracefully", () => {
  it("swallows a recall failure and warns", async () => {
    const client = new FakeCortadelClient();
    client.searchError = cortadelError();
    const middleware = createCortadelMemoryMiddleware({ client });

    expect(
      await beforeAgent(middleware)({ messages: [new HumanMessage("q")] }, RUNTIME),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recall failed (http_error: server down)"));
  });

  it("swallows a persist failure and does NOT advance the cursor", async () => {
    const client = new FakeCortadelClient();
    client.conversationError = cortadelError();
    const middleware = createCortadelMemoryMiddleware({ client });

    expect(
      await afterAgent(middleware)({ messages: [new HumanMessage("hi")] }, RUNTIME),
    ).toBeUndefined();
  });

  it("reports every failure to onError while still degrading", async () => {
    const client = new FakeCortadelClient();
    client.searchError = cortadelError(500, "boom", "kaboom");
    const seen: unknown[] = [];
    const middleware = createCortadelMemoryMiddleware({ client, onError: (error) => seen.push(error) });

    await beforeAgent(middleware)({ messages: [new HumanMessage("q")] }, RUNTIME);

    expect(seen).toEqual([client.searchError]);
    // An observer replaces the warning; it does not add to it.
    expect(warn).not.toHaveBeenCalled();
  });

  it("rethrows when throwOnError is set", async () => {
    const client = new FakeCortadelClient();
    client.searchError = cortadelError();
    const middleware = createCortadelMemoryMiddleware({ client, throwOnError: true });

    await expect(
      beforeAgent(middleware)({ messages: [new HumanMessage("q")] }, RUNTIME),
    ).rejects.toBe(client.searchError);
  });

  it("does nothing when the run carries no user id and none is configured", async () => {
    const middleware = createCortadelMemoryMiddleware({ baseUrl: "http://localhost:3001" });
    const update = await beforeAgent(middleware)(
      { messages: [new HumanMessage("q")] },
      { context: {}, configurable: {} },
    );
    expect(update).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no Cortadel user id for this run"));
  });
});

describe("per-user scoping", () => {
  it("builds one client per runtime user id via clientFactory", async () => {
    const built = new Map<string, FakeCortadelClient>();
    const middleware = createCortadelMemoryMiddleware({
      clientFactory: (userId) => {
        const client = new FakeCortadelClient(userId);
        built.set(userId, client);
        return client;
      },
    });

    await beforeAgent(middleware)(
      { messages: [new HumanMessage("alice question")] },
      { context: { user_id: "e2e-alice" }, configurable: {} },
    );
    await beforeAgent(middleware)(
      { messages: [new HumanMessage("bob question")] },
      { context: {}, configurable: { user_id: "e2e-bob" } },
    );
    await beforeAgent(middleware)(
      { messages: [new HumanMessage("alice again")] },
      { context: { user_id: "e2e-alice" }, configurable: {} },
    );

    expect([...built.keys()].sort()).toEqual(["e2e-alice", "e2e-bob"]);
    // The alice client was cached and reused for her second turn.
    expect(built.get("e2e-alice")!.searchCalls.map((call) => call.query)).toEqual([
      "alice question",
      "alice again",
    ]);
    expect(built.get("e2e-bob")!.searchCalls.map((call) => call.query)).toEqual(["bob question"]);
  });

  it("honours a custom userIdKey", async () => {
    const built: string[] = [];
    const middleware = createCortadelMemoryMiddleware({
      userIdKey: "tenant",
      clientFactory: (userId) => {
        built.push(userId);
        return new FakeCortadelClient(userId);
      },
    });
    await beforeAgent(middleware)(
      { messages: [new HumanMessage("q")] },
      { context: { tenant: "e2e-tenant-1" }, configurable: {} },
    );
    expect(built).toEqual(["e2e-tenant-1"]);
  });

  it("warns once when a pinned client shadows the run's user id", async () => {
    const client = new FakeCortadelClient();
    const middleware = createCortadelMemoryMiddleware({ client, userId: "e2e-pinned" });

    for (const query of ["one", "two"]) {
      await beforeAgent(middleware)(
        { messages: [new HumanMessage(query)] },
        { context: { user_id: "e2e-someone-else" }, configurable: {} },
      );
    }

    expect(client.searchCalls).toHaveLength(2);
    const pinnedWarnings = warn.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("memories stay scoped to"),
    );
    expect(pinnedWarnings).toHaveLength(1);
  });
});
