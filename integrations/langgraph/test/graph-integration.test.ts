/**
 * End-to-end proof, with no LLM and no server: a real compiled `StateGraph` that recalls before
 * the model node and persists after it, plus a real `createReactAgent` wired through
 * `preModelHook` / `postModelHook` / `store`.
 */
import type { ChatMessage } from "@cortadel/sdk";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
  messagesStateReducer,
  type LangGraphRunnableConfig,
  type Messages,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CortadelMemory,
  CortadelStore,
  ambientStore,
  createSearchMemoryTool,
} from "../src/index.js";
import { FakeBackend, NAMESPACE, RecordingLogger, USER, hit, serverError } from "./fake-cortadel.js";

let backend: FakeBackend;

/**
 * The two channels `createReactAgent` uses, rebuilt by hand so the graph below behaves exactly
 * like the prebuilt one: `llmInputMessages` is overwritten (not appended to) on every hook run,
 * and the model node reads it in preference to `messages`.
 */
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  llmInputMessages: Annotation<BaseMessage[], Messages>({
    reducer: (_left: BaseMessage[], right: Messages) => messagesStateReducer([], right),
    default: () => [],
  }),
});

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

/**
 * A stand-in for the model call. It answers with whatever memory block it was handed, which is how
 * the tests below assert that recall reached the model rather than the transcript.
 */
function fakeModelNode(state: typeof AgentState.State) {
  const seen = state.llmInputMessages.length > 0 ? state.llmInputMessages : state.messages;
  const memoryBlock = seen.find((message) => message instanceof SystemMessage);
  const answer =
    memoryBlock === undefined ? "no memory" : `saw memory: ${String(memoryBlock.content)}`;
  return { messages: [new AIMessage(answer)] };
}

function buildGraph(memory: CortadelMemory, store: CortadelStore) {
  return new StateGraph(AgentState)
    .addNode("recall", memory.recallNode)
    .addNode("model", fakeModelNode)
    .addNode("remember", memory.rememberNode)
    .addEdge(START, "recall")
    .addEdge("recall", "model")
    .addEdge("model", "remember")
    .addEdge("remember", END)
    .compile({ store, checkpointer: new MemorySaver() });
}

beforeEach(() => {
  backend = new FakeBackend();
});

describe("a compiled graph", () => {
  it("recalls before the model and persists after", async () => {
    backend.searchHits = [hit("m1", "Ships releases on Fridays.")];
    const store = newStore();
    const graph = buildGraph(new CortadelMemory({ store, namespace: NAMESPACE }), store);

    const result = await graph.invoke(
      { messages: [new HumanMessage("When should we deploy?")] },
      { configurable: { thread_id: "conv-1" } },
    );

    expect(backend.methods()).toEqual(["search", "addConversation"]);
    const answer = result.messages[result.messages.length - 1]!;
    expect(String(answer.content)).toContain("Ships releases on Fridays.");
    // The memory block reached the model but never joined the durable transcript.
    expect(result.messages.some((message) => message instanceof SystemMessage)).toBe(false);
  });

  /**
   * The regression that 126 passing tests missed, because every one of them either handed
   * `CortadelMemory` an explicit `store` or exercised the store-less path outside a graph.
   *
   * Inside a compiled graph the ambient store is an `AsyncBatchedStore` wrapping ours, and that
   * wrapper forwards only `get`/`search`/`put`/`delete` — so the whole persist half used to
   * disable itself here while warning that a `CortadelStore` "is not a CortadelStore". Recall kept
   * working, which is exactly why it went unnoticed.
   */
  it("persists from a store-less CortadelMemory, through LangGraph's store wrapper", async () => {
    backend.searchHits = [hit("m1", "Ships releases on Fridays.")];
    const logger = new RecordingLogger();
    const store = newStore({ logger });
    // No `store` option: the nodes read the compiled store off the config, as the README documents.
    const graph = buildGraph(new CortadelMemory({ namespace: NAMESPACE, logger }), store);

    const result = await graph.invoke(
      { messages: [new HumanMessage("When should we deploy?")] },
      { configurable: { thread_id: "conv-1" } },
    );

    // Both halves ran: the search that feeds the model, and the write that used to vanish.
    expect(backend.methods()).toEqual(["search", "addConversation"]);
    const [turns, options] = backend.first("addConversation") as [
      ChatMessage[],
      { sessionId?: string },
    ];
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(turns[0]!.content).toBe("When should we deploy?");
    expect(options.sessionId).toBe("conv-1");
    // Recall reached the model on this path too, and the answer proves it.
    expect(String(result.messages[result.messages.length - 1]!.content)).toContain(
      "Ships releases on Fridays.",
    );
    // And no warning: the old code reported the wrapper as "not a CortadelStore".
    expect(logger.warnings).toEqual([]);
  });

  it("persists only what is new on a second turn", async () => {
    const store = newStore();
    const graph = buildGraph(new CortadelMemory({ store, namespace: NAMESPACE }), store);
    const config = { configurable: { thread_id: "conv-1" } };

    await graph.invoke({ messages: [new HumanMessage("first")] }, config);
    await graph.invoke({ messages: [new HumanMessage("second")] }, config);

    const conversations = backend.calls.filter((call) => call.method === "addConversation");
    expect(conversations).toHaveLength(2);
    const secondTurn = conversations[1]!.args[0] as ChatMessage[];
    expect(secondTurn.map((turn) => turn.content)).toEqual(["second", "no memory"]);
  });

  it("treats two threads as two conversations sharing one long-term memory", async () => {
    const store = newStore();
    const graph = buildGraph(new CortadelMemory({ store, namespace: NAMESPACE }), store);

    await graph.invoke(
      { messages: [new HumanMessage("hello")] },
      { configurable: { thread_id: "conv-1" } },
    );
    await graph.invoke(
      { messages: [new HumanMessage("hello")] },
      { configurable: { thread_id: "conv-2" } },
    );

    const conversations = backend.calls.filter((call) => call.method === "addConversation");
    expect(conversations).toHaveLength(2);
    expect(conversations.map((call) => (call.args[1] as { sessionId?: string }).sessionId)).toEqual(
      ["conv-1", "conv-2"],
    );
    // Both threads resolved to the same Cortadel user, so both share the same memory namespace.
    expect(new Set(backend.users())).toEqual(new Set([USER]));
  });

  it("still answers when Cortadel is down", async () => {
    backend.failures.set("search", serverError());
    backend.failures.set("addConversation", serverError());
    const store = newStore();
    const graph = buildGraph(new CortadelMemory({ store, namespace: NAMESPACE }), store);

    const result = await graph.invoke(
      { messages: [new HumanMessage("Anything?")] },
      { configurable: { thread_id: "conv-1" } },
    );
    expect(String(result.messages[result.messages.length - 1]!.content)).toBe("no memory");
  });

  it("hands the store to a node through its config", async () => {
    backend.searchHits = [hit("m1", "reached through the config")];
    const store = newStore();
    let found = false;
    let seenText = "";
    const graph = new StateGraph(AgentState)
      .addNode(
        "peek",
        async (_state: typeof AgentState.State, config: LangGraphRunnableConfig) => {
          // LangGraph wraps a compiled store in `AsyncBatchedStore`, so this is not the same
          // object — but reads through it must land on ours. It also only drains while the graph
          // is running, which is why the read happens here rather than after `invoke` returns.
          const ambient = ambientStore(config);
          found = ambient !== undefined;
          const items = (await ambient?.search(NAMESPACE, { query: "q" })) ?? [];
          seenText = String(items[0]?.value.content ?? "");
          return {};
        },
      )
      .addEdge(START, "peek")
      .addEdge("peek", END)
      .compile({ store });

    await graph.invoke({ messages: [] });
    expect(found).toBe(true);
    expect(seenText).toBe("reached through the config");
    expect(backend.count("search")).toBe(1);
  });

  it("lets a store-less tool find the compiled store", async () => {
    backend.searchHits = [hit("m1", "Prefers dark mode.")];
    const store = newStore();
    const searchTool = createSearchMemoryTool({ namespace: NAMESPACE });
    let toolOutput = "";
    const graph = new StateGraph(AgentState)
      .addNode("call-tool", async (_s: typeof AgentState.State, config: LangGraphRunnableConfig) => {
        toolOutput = await searchTool.invoke({ query: "preferences" }, config);
        return {};
      })
      .addEdge(START, "call-tool")
      .addEdge("call-tool", END)
      .compile({ store });

    await graph.invoke({ messages: [] });
    expect(toolOutput).toContain("Prefers dark mode.");
  });

  it("resolves a templated namespace from the invocation config", async () => {
    const store = newStore({ userId: (ns: string[]) => ns[ns.length - 1]! });
    const graph = buildGraph(
      new CortadelMemory({ store, namespace: ["memories", "{userId}"] }),
      store,
    );

    await graph.invoke(
      { messages: [new HumanMessage("hi")] },
      { configurable: { thread_id: "conv-1", userId: "e2e-langgraph-tenant" } },
    );
    expect(new Set(backend.users())).toEqual(new Set(["e2e-langgraph-tenant"]));
  });
});

describe("createReactAgent", () => {
  it("accepts the store and both hooks, and drives them", async () => {
    backend.searchHits = [hit("m1", "Ships releases on Fridays.")];
    const store = newStore();
    const memory = new CortadelMemory({ store, namespace: NAMESPACE });

    const agent = createReactAgent({
      llm: new FakeListChatModel({ responses: ["Deploy on Friday."] }),
      tools: [],
      store,
      preModelHook: memory.preModelHook,
      postModelHook: memory.postModelHook,
      checkpointer: new MemorySaver(),
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("When should we deploy?")] },
      { configurable: { thread_id: "agent-1" } },
    );

    expect(backend.methods()).toEqual(["search", "addConversation"]);
    // The recalled block was fed to the model but never appended to the transcript.
    expect(result.messages.some((message) => message instanceof SystemMessage)).toBe(false);
    expect(String(result.messages[result.messages.length - 1]!.content)).toBe("Deploy on Friday.");
    const [turns] = backend.first("addConversation") as [ChatMessage[]];
    expect(turns.map((turn) => turn.content)).toEqual([
      "When should we deploy?",
      "Deploy on Friday.",
    ]);
  });

  /** The same store-less regression, on the prebuilt agent most users actually reach for. */
  it("drives a store-less CortadelMemory off the agent's own store", async () => {
    backend.searchHits = [hit("m1", "Ships releases on Fridays.")];
    const logger = new RecordingLogger();
    const store = newStore({ logger });
    const memory = new CortadelMemory({ namespace: NAMESPACE, logger });

    const agent = createReactAgent({
      llm: new FakeListChatModel({ responses: ["Deploy on Friday."] }),
      tools: [],
      store,
      preModelHook: memory.preModelHook,
      postModelHook: memory.postModelHook,
      checkpointer: new MemorySaver(),
    });

    await agent.invoke(
      { messages: [new HumanMessage("When should we deploy?")] },
      { configurable: { thread_id: "agent-2" } },
    );

    expect(backend.methods()).toEqual(["search", "addConversation"]);
    const [turns] = backend.first("addConversation") as [ChatMessage[]];
    expect(turns.map((turn) => turn.content)).toEqual([
      "When should we deploy?",
      "Deploy on Friday.",
    ]);
    expect(logger.warnings).toEqual([]);
  });
});
