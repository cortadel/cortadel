import type { ChatMessage, ConversationOptions, SearchOptions } from "@cortadel/sdk";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { InMemoryStore } from "@langchain/langgraph";
import { AsyncBatchedStore } from "@langchain/langgraph-checkpoint";
import { beforeEach, describe, expect, it } from "vitest";

import { CortadelMemory, CortadelStore } from "../src/index.js";
import { FakeBackend, NAMESPACE, RecordingLogger, USER, hit, serverError } from "./fake-cortadel.js";

let backend: FakeBackend;

function newStore(overrides: Record<string, unknown> = {}) {
  return new CortadelStore({
    baseUrl: "http://localhost:3001",
    userId: USER,
    throwOnError: false,
    logger: new RecordingLogger(),
    clientFactory: backend.factory,
    ...overrides,
  });
}

function newMemory(overrides: Partial<ConstructorParameters<typeof CortadelMemory>[0]> = {}) {
  return new CortadelMemory({
    store: newStore(),
    namespace: NAMESPACE,
    logger: new RecordingLogger(),
    ...overrides,
  });
}

const thread = (id: string): LangGraphRunnableConfig => ({ configurable: { thread_id: id } });

beforeEach(() => {
  backend = new FakeBackend();
});

describe("recall", () => {
  it("searches with the latest user message", async () => {
    const memory = newMemory();
    await memory.recallNode(
      { messages: [new HumanMessage("older"), new AIMessage("reply"), new HumanMessage("newest")] },
      thread("t1"),
    );
    const [query, options] = backend.first("search") as [string, SearchOptions];
    expect(query).toBe("newest");
    expect(options.topK).toBe(5);
  });

  it("defaults topK to five for automatic injection", async () => {
    const memory = newMemory();
    await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.topK).toBe(5);
  });

  it("bounds how many memories are injected", async () => {
    const memory = newMemory({ topK: 2 });
    await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.topK).toBe(2);
  });

  it("prepends the memories as a SystemMessage", async () => {
    backend.searchHits = [hit("m1", "Ships on Fridays."), hit("m2", "Prefers dark mode.")];
    const memory = newMemory();
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    const injected = update.llmInputMessages as unknown[];
    expect(injected).toHaveLength(2);
    expect(injected[0]).toBeInstanceOf(SystemMessage);
    expect(String((injected[0] as SystemMessage).content)).toContain("- Ships on Fridays.");
    expect(String((injected[0] as SystemMessage).content)).toContain("- Prefers dark mode.");
  });

  it("writes to the ephemeral channel, not to messages", async () => {
    backend.searchHits = [hit("m1", "a memory")];
    const memory = newMemory();
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    expect(Object.keys(update)).toEqual(["llmInputMessages"]);
    expect(update.messages).toBeUndefined();
  });

  it("injects nothing when there are no memories", async () => {
    const memory = newMemory();
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    const injected = update.llmInputMessages as unknown[];
    expect(injected).toHaveLength(1);
    expect(injected[0]).toBeInstanceOf(HumanMessage);
  });

  it("is skipped when the conversation has no user message", async () => {
    const memory = newMemory();
    await memory.recallNode({ messages: [new AIMessage("hello")] }, thread("t1"));
    expect(backend.count("search")).toBe(0);
  });

  it("searches once per user turn, not once per model call", async () => {
    const memory = newMemory();
    const anchor = new HumanMessage({ id: "h1", content: "q" });
    await memory.recallNode({ messages: [anchor] }, thread("t1"));
    await memory.recallNode({ messages: [anchor, new AIMessage("thinking")] }, thread("t1"));
    expect(backend.count("search")).toBe(1);
  });

  it("searches again on a fresh user turn", async () => {
    const memory = newMemory();
    const first = new HumanMessage({ id: "h1", content: "q1" });
    await memory.recallNode({ messages: [first] }, thread("t1"));
    await memory.recallNode(
      { messages: [first, new AIMessage("a"), new HumanMessage({ id: "h2", content: "q2" })] },
      thread("t1"),
    );
    expect(backend.count("search")).toBe(2);
  });

  it("keeps separate recall caches per thread", async () => {
    const memory = newMemory();
    const anchor = new HumanMessage({ id: "h1", content: "q" });
    await memory.recallNode({ messages: [anchor] }, thread("t1"));
    await memory.recallNode({ messages: [anchor] }, thread("t2"));
    expect(backend.count("search")).toBe(2);
  });

  it("can be turned off", async () => {
    const memory = newMemory({ recall: false });
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    expect(backend.count("search")).toBe(0);
    expect((update.llmInputMessages as unknown[])).toHaveLength(1);
  });

  it("lets the injection target be configured", async () => {
    backend.searchHits = [hit("m1", "a memory")];
    const memory = newMemory({ outputKey: "messages" });
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    expect(Object.keys(update)).toEqual(["messages"]);
  });

  it("handles content-block messages", async () => {
    const memory = newMemory();
    await memory.recallNode(
      { messages: [new HumanMessage({ content: [{ type: "text", text: "block text" }] })] },
      thread("t1"),
    );
    expect(backend.first("search")[0]).toBe("block text");
  });

  it("scopes recall to the thread's session when asked", async () => {
    const memory = newMemory({ scopeRecallToSession: true });
    await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t-42"));
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.sessionId).toBe("t-42");
  });

  it("does not scope recall to the session by default", async () => {
    const memory = newMemory();
    await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t-42"));
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.sessionId).toBeUndefined();
  });
});

describe("persistence", () => {
  it("hands a finished turn to addConversation", async () => {
    const memory = newMemory();
    await memory.rememberNode(
      { messages: [new HumanMessage("I ship on Fridays."), new AIMessage("Noted.")] },
      thread("t1"),
    );
    const [turns, options] = backend.first("addConversation") as [ChatMessage[], ConversationOptions];
    expect(turns.map((turn) => [turn.role, turn.content])).toEqual([
      ["user", "I ship on Fridays."],
      ["assistant", "Noted."],
    ]);
    expect(options.sessionId).toBe("t1");
  });

  it("is a side effect, not a state update", async () => {
    const memory = newMemory();
    const update = await memory.rememberNode(
      { messages: [new HumanMessage("hi"), new AIMessage("hello")] },
      thread("t1"),
    );
    expect(update).toEqual({});
  });

  it("stores nothing mid tool loop", async () => {
    const memory = newMemory();
    const withCall = new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name: "search", args: {} }],
    });
    await memory.rememberNode({ messages: [new HumanMessage("q"), withCall] }, thread("t1"));
    expect(backend.count("addConversation")).toBe(0);
  });

  it("stores nothing when the last message is a tool reply", async () => {
    const memory = newMemory();
    const toolReply = new ToolMessage({ content: "result", tool_call_id: "c1" });
    await memory.rememberNode({ messages: [new HumanMessage("q"), toolReply] }, thread("t1"));
    expect(backend.count("addConversation")).toBe(0);
  });

  it("excludes tool traffic from what is persisted", async () => {
    const memory = newMemory();
    const withCall = new AIMessage({
      id: "a1",
      content: "let me look",
      tool_calls: [{ id: "c1", name: "search", args: {} }],
    });
    await memory.rememberNode(
      {
        messages: [
          new HumanMessage("q"),
          withCall,
          new ToolMessage({ content: "raw payload", tool_call_id: "c1" }),
          new AIMessage("Here is the answer."),
        ],
      },
      thread("t1"),
    );
    const [turns] = backend.first("addConversation") as [ChatMessage[]];
    expect(turns.map((turn) => turn.content)).toEqual(["q", "Here is the answer."]);
  });

  it("persists each message at most once", async () => {
    const memory = newMemory();
    const first = [
      new HumanMessage({ id: "h1", content: "one" }),
      new AIMessage({ id: "a1", content: "ok" }),
    ];
    await memory.rememberNode({ messages: first }, thread("t1"));
    await memory.rememberNode(
      {
        messages: [
          ...first,
          new HumanMessage({ id: "h2", content: "two" }),
          new AIMessage({ id: "a2", content: "sure" }),
        ],
      },
      thread("t1"),
    );
    const second = backend.calls.filter((call) => call.method === "addConversation")[1]!;
    const turns = second.args[0] as ChatMessage[];
    expect(turns.map((turn) => turn.content)).toEqual(["two", "sure"]);
  });

  it("stores nothing new when called again on an unchanged transcript", async () => {
    const memory = newMemory();
    const messages = [
      new HumanMessage({ id: "h1", content: "one" }),
      new AIMessage({ id: "a1", content: "ok" }),
    ];
    await memory.rememberNode({ messages }, thread("t1"));
    await memory.rememberNode({ messages }, thread("t1"));
    expect(backend.count("addConversation")).toBe(1);
  });

  it("falls back to the current turn only when the transcript was trimmed", async () => {
    const memory = newMemory();
    await memory.rememberNode(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "one" }),
          new AIMessage({ id: "a1", content: "ok" }),
        ],
      },
      thread("t1"),
    );
    // A summariser dropped the earlier turns, so the cursor id is nowhere to be found.
    await memory.rememberNode(
      {
        messages: [
          new SystemMessage({ id: "s1", content: "summary of earlier" }),
          new HumanMessage({ id: "h9", content: "latest question" }),
          new AIMessage({ id: "a9", content: "latest answer" }),
        ],
      },
      thread("t1"),
    );
    const second = backend.calls.filter((call) => call.method === "addConversation")[1]!;
    const turns = second.args[0] as ChatMessage[];
    expect(turns.map((turn) => turn.content)).toEqual(["latest question", "latest answer"]);
  });

  it("keeps separate cursors per thread", async () => {
    const memory = newMemory();
    const messages = [
      new HumanMessage({ id: "h1", content: "one" }),
      new AIMessage({ id: "a1", content: "ok" }),
    ];
    await memory.rememberNode({ messages }, thread("t1"));
    await memory.rememberNode({ messages }, thread("t2"));
    expect(backend.count("addConversation")).toBe(2);
  });

  it("can be turned off", async () => {
    const memory = newMemory({ persist: false });
    await memory.rememberNode(
      { messages: [new HumanMessage("q"), new AIMessage("a")] },
      thread("t1"),
    );
    expect(backend.count("addConversation")).toBe(0);
  });

  it("forwards project and tags", async () => {
    const memory = newMemory({ project: "cortadel", tags: ["agent"] });
    await memory.rememberNode(
      { messages: [new HumanMessage("q"), new AIMessage("a")] },
      thread("t1"),
    );
    const [, options] = backend.first("addConversation") as [unknown, ConversationOptions];
    expect(options.project).toBe("cortadel");
    expect(options.tags).toEqual(["agent"]);
  });

  it("omits the session id when sessionFromThread is off", async () => {
    const memory = newMemory({ sessionFromThread: false });
    await memory.rememberNode(
      { messages: [new HumanMessage("q"), new AIMessage("a")] },
      thread("t1"),
    );
    const [, options] = backend.first("addConversation") as [unknown, ConversationOptions];
    expect(options.sessionId).toBeUndefined();
  });

  it("still works with no thread_id at all", async () => {
    const memory = newMemory();
    await memory.rememberNode({ messages: [new HumanMessage("q"), new AIMessage("a")] });
    const [, options] = backend.first("addConversation") as [unknown, ConversationOptions];
    expect(options.sessionId).toBeUndefined();
    expect(backend.count("addConversation")).toBe(1);
  });

  it("does not await the write when awaitPersist is false", async () => {
    const memory = newMemory({ awaitPersist: false });
    await memory.rememberNode(
      { messages: [new HumanMessage("q"), new AIMessage("a")] },
      thread("t1"),
    );
    // The write was dispatched; whether it has landed is deliberately not awaited.
    expect(backend.count("addConversation")).toBe(1);
  });
});

/**
 * A detached write outlives the node that dispatched it, so there is no caller left to receive a
 * throw. `throwOnError` therefore stops at the boundary: rethrowing inside the `.catch` callback
 * would reject the promise `.catch()` returns with nobody handling it, and Node >= 15 defaults to
 * `--unhandled-rejections=throw` — killing the host process over a memory write.
 */
describe("a failed fire-and-forget write", () => {
  /** Runs `body` with an unhandled-rejection recorder installed. */
  async function withUnhandledRejections(body: () => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const record = (reason: unknown) => {
      seen.push(String(reason));
    };
    process.on("unhandledRejection", record);
    try {
      await body();
      // Give the rejection a turn or two of the loop to surface as unhandled.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", record);
    }
    return seen;
  }

  it("does not escape as an unhandled rejection when throwOnError is true", async () => {
    backend.failures.set("addConversation", serverError());
    const observed: unknown[] = [];
    // Two independent flags of the same name. The store's `throwOnError` is what makes
    // `addConversation` reject at all (fail-open would swallow it there and resolve); the memory's
    // is the one under test — on the detached path it deliberately does not apply, so the rejection
    // has to land in `onError` rather than escape.
    const memory = newMemory({
      store: newStore({ throwOnError: true }),
      awaitPersist: false,
      throwOnError: true,
      onError: (error: unknown) => observed.push(error),
    });

    const escaped = await withUnhandledRejections(async () => {
      await memory.rememberNode(
        { messages: [new HumanMessage("q"), new AIMessage("a")] },
        thread("t1"),
      );
    });

    expect(escaped).toEqual([]);
    // Swallowed, but not silently: the failure still reached the observer.
    expect(observed).toHaveLength(1);
    expect(String(observed[0])).toContain("boom");
  });

  it("still returns normally from the node itself", async () => {
    backend.failures.set("addConversation", serverError());
    const memory = newMemory({
      store: newStore({ throwOnError: true }),
      awaitPersist: false,
      throwOnError: true,
    });
    await expect(
      memory.rememberNode(
        { messages: [new HumanMessage("q"), new AIMessage("a")] },
        thread("t1"),
      ),
    ).resolves.toEqual({});
  });

  it("survives a logger that throws while reporting it", async () => {
    backend.failures.set("addConversation", serverError());
    const memory = newMemory({
      store: newStore({ throwOnError: true }),
      awaitPersist: false,
      logger: {
        warn: () => {
          throw new Error("the logger is broken too");
        },
      },
    });

    const escaped = await withUnhandledRejections(async () => {
      await memory.rememberNode(
        { messages: [new HumanMessage("q"), new AIMessage("a")] },
        thread("t1"),
      );
    });
    expect(escaped).toEqual([]);
  });
});

describe("degradation", () => {
  it("leaves the transcript intact when the server is unreachable", async () => {
    backend.failures.set("search", serverError());
    const memory = newMemory();
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    const injected = update.llmInputMessages as unknown[];
    expect(injected).toHaveLength(1);
    expect(injected[0]).toBeInstanceOf(HumanMessage);
  });

  it("survives with no store at all", async () => {
    const logger = new RecordingLogger();
    const memory = new CortadelMemory({ namespace: NAMESPACE, logger });
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    expect((update.llmInputMessages as unknown[])).toHaveLength(1);
    expect(await memory.rememberNode({ messages: [new HumanMessage("q")] }, thread("t1"))).toEqual(
      {},
    );
    expect(logger.warnings.join("\n")).toMatch(/found no store/);
    // Warned once, not once per node call.
    expect(logger.warnings.filter((line) => line.includes("found no store"))).toHaveLength(1);
  });

  it("still recalls against a non-Cortadel store but cannot persist", async () => {
    const logger = new RecordingLogger();
    const store = new InMemoryStore();
    await store.put(NAMESPACE, "k1", { content: "Prefers dark mode." });
    const memory = new CortadelMemory({ store, namespace: NAMESPACE, logger });
    const update = await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    expect((update.llmInputMessages as unknown[])).toHaveLength(2);
    await memory.rememberNode(
      { messages: [new HumanMessage("q"), new AIMessage("a")] },
      thread("t1"),
    );
    expect(logger.warnings.join("\n")).toMatch(/is not a CortadelStore/);
  });

  it("names the wrapped store in that warning, not LangGraph's wrapper", async () => {
    const logger = new RecordingLogger();
    const store = new AsyncBatchedStore(new InMemoryStore());
    store.start();
    const memory = new CortadelMemory({ store, namespace: NAMESPACE, logger });
    await memory.rememberNode(
      { messages: [new HumanMessage("q"), new AIMessage("a")] },
      thread("t1"),
    );
    await store.stop();
    // Reporting "AsyncBatchedStore is not a CortadelStore" would name an object the user never
    // created and send them looking in the wrong place.
    expect(logger.warnings.join("\n")).toMatch(/InMemoryStore is not a CortadelStore/);
    expect(logger.warnings.join("\n")).not.toMatch(/AsyncBatchedStore/);
  });

  it("routes a recall failure to onError when one is set", async () => {
    const observed: unknown[] = [];
    const store = {
      search: async () => {
        throw new Error("store exploded");
      },
    } as unknown as InMemoryStore;
    const memory = new CortadelMemory({ store, namespace: NAMESPACE, onError: (e) => observed.push(e) });
    await memory.recallNode({ messages: [new HumanMessage("q")] }, thread("t1"));
    expect(observed).toHaveLength(1);
  });
});

describe("the createReactAgent hook aliases", () => {
  it("are the node callables under their LangGraph names", () => {
    const memory = newMemory();
    expect(memory.preModelHook).toBe(memory.recallNode);
    expect(memory.postModelHook).toBe(memory.rememberNode);
  });

  it("stay bound when detached from the instance", async () => {
    const memory = newMemory();
    const { preModelHook, postModelHook } = memory;
    await preModelHook({ messages: [new HumanMessage("q")] }, thread("t1"));
    await postModelHook({ messages: [new HumanMessage("q"), new AIMessage("a")] }, thread("t1"));
    expect(backend.count("search")).toBe(1);
    expect(backend.count("addConversation")).toBe(1);
  });
});
