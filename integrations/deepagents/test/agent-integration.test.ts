/**
 * End-to-end through a real `createDeepAgent`, entirely offline: a fake tool-calling model stands
 * in for the LLM and a fake Cortadel client stands in for the server. Nothing here opens a socket.
 *
 * `FakeToolCallingModel` echoes the concatenated prompt back as its reply
 * (`langchain/dist/agents/tests/utils.js`), which is exactly what makes it useful here — if the
 * recalled block reaches the model, it comes back out in the response text.
 */

import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { FakeToolCallingModel } from "langchain";
import { createDeepAgent } from "deepagents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ClientProvider, createCortadelMemoryMiddleware } from "../src/index.js";
import { FakeCortadelClient, hit } from "./fakes.js";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function buildAgent(client: FakeCortadelClient, checkpointer?: MemorySaver) {
  return createDeepAgent({
    model: new FakeToolCallingModel({}),
    middleware: [createCortadelMemoryMiddleware({ client })],
    ...(checkpointer ? { checkpointer } : {}),
  });
}

/**
 * A `clientFactory` that records which user ids a run actually built a client for.
 *
 * `built` is the assertion that matters for the context-scoping tests: it is empty exactly when the
 * middleware failed to resolve a user, which is the state a `console.warn` used to be the only
 * evidence of.
 */
function trackedFactory() {
  const built: string[] = [];
  const clients = new Map<string, FakeCortadelClient>();
  return {
    built,
    clients,
    client(userId: string): FakeCortadelClient {
      const client = clients.get(userId);
      if (!client) throw new Error(`no client was built for "${userId}"`);
      return client;
    },
    clientFactory(userId: string): FakeCortadelClient {
      built.push(userId);
      const client = new FakeCortadelClient(userId);
      clients.set(userId, client);
      return client;
    },
  };
}

const ask = (text: string) => ({ messages: [new HumanMessage(text)] });

describe("inside a real deep agent", () => {
  it("recalls before the model call, injects, and persists the turn", async () => {
    const client = new FakeCortadelClient();
    client.hits = [hit("m1", "The user ships on Fridays.", { createdAt: "2026-02-03T00:00:00Z" })];
    const agent = buildAgent(client);

    const result = await agent.invoke({
      messages: [new HumanMessage("when do I usually ship?")],
    });

    // (1) one hybrid search per turn, for the new user message
    expect(client.searchCalls).toHaveLength(1);
    expect(client.searchCalls[0]!.query).toBe("when do I usually ship?");

    // (2) the recalled block actually reached the model
    const reply = result.messages.at(-1)!;
    expect(reply.text).toContain("The user ships on Fridays. [recorded 2026-02-03]");
    expect(reply.text).toContain("<cortadel_memory>");

    // (3) the turn was persisted, dialogue only
    expect(client.conversationCalls).toHaveLength(1);
    expect(client.conversationCalls[0]!.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(client.conversationCalls[0]!.messages[0]!.content).toBe("when do I usually ship?");
  });

  it("keeps the injected block out of the conversation state", async () => {
    const client = new FakeCortadelClient();
    client.hits = [hit("m1", "The user prefers dark mode.")];
    const agent = buildAgent(client);

    const result = await agent.invoke({ messages: [new HumanMessage("hello")] });

    // The recall rides on a per-call ModelRequest override, never on a stored message.
    const stored = result.messages.filter((message) => message.getType() !== "ai");
    expect(stored.map((message) => message.text)).toEqual(["hello"]);
  });

  it("does not re-ingest its own history across turns on one thread", async () => {
    const client = new FakeCortadelClient();
    const agent = buildAgent(client, new MemorySaver());
    const config = { configurable: { thread_id: "e2e-deepagents-thread" } };

    await agent.invoke({ messages: [new HumanMessage("first question")] }, config);
    await agent.invoke({ messages: [new HumanMessage("second question")] }, config);

    expect(client.conversationCalls).toHaveLength(2);
    // Turn 2 sends only the suffix added since the cursor — never the whole thread again.
    const secondTurn = client.conversationCalls[1]!.messages;
    expect(secondTurn.map((message) => message.content)).toContain("second question");
    expect(secondTurn.map((message) => message.content)).not.toContain("first question");
    // The thread id is carried through as Cortadel's session id.
    expect(client.conversationCalls[1]!.options).toMatchObject({
      sessionId: "e2e-deepagents-thread",
    });
  });

  it("runs normally when Cortadel is unreachable", async () => {
    const client = new FakeCortadelClient();
    client.searchError = new Error("connect ECONNREFUSED");
    client.conversationError = new Error("connect ECONNREFUSED");
    const agent = buildAgent(client);

    const result = await agent.invoke({ messages: [new HumanMessage("still works?")] });

    expect(result.messages.at(-1)!.text).toContain("still works?");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("continuing without memory"));
  });

  it("registers the memory tools so the agent can call them itself", async () => {
    const client = new FakeCortadelClient();
    client.hits = [hit("m1", "The user maintains Project Alpha.")];
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ id: "call-1", name: "search_memory", args: { query: "what do they maintain?" } }],
          [],
        ],
      }),
      middleware: [createCortadelMemoryMiddleware({ client })],
    });

    const result = await agent.invoke({ messages: [new HumanMessage("what do I maintain?")] });

    const toolMessage = result.messages.find((message) => message.getType() === "tool");
    expect(toolMessage?.text).toContain("The user maintains Project Alpha.");
    // Two searches: one automatic recall for the turn, one from the tool the model chose to call.
    expect(client.searchCalls.map((call) => call.query)).toEqual([
      "what do I maintain?",
      "what do they maintain?",
    ]);
    expect(client.searchCalls[0]!.options).toMatchObject({ topK: 5 });
    expect(client.searchCalls[1]!.options).toMatchObject({ topK: 10 });
  });
});

/**
 * Per-user scoping, driven through `agent.invoke(...)` rather than by calling the hooks directly.
 *
 * These exist because the direct-hook tests in `middleware.test.ts` hand `beforeAgent` a
 * `{ context: { user_id } }` object that the real runtime never used to produce. LangChain JS does
 * not give a middleware the run's context: `MiddlewareNode.invokeMiddleware` starts from `{}` and
 * copies in only the keys named by *that middleware's own* `contextSchema`. With no schema declared,
 * `runtime.context` was a frozen empty object, so the whole `context` half of the README's "Per-user
 * scoping" was dead — and dead *asymmetrically*, since the tools resolve their user through
 * `ToolNode`, where the raw run config survives. A context-scoped deployment therefore got an agent
 * whose `search_memory` tool worked while automatic recall and persistence were off behind one
 * `console.warn`.
 *
 * Every test below goes through the real graph for that reason: a hand-built runtime cannot falsify
 * a claim about what the runtime hands you.
 */
describe("per-user scoping through a real run", () => {
  it("resolves the user id from runtime.context and runs both automatic halves", async () => {
    const factory = trackedFactory();
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      contextSchema: z.object({ user_id: z.string() }),
      middleware: [createCortadelMemoryMiddleware({ clientFactory: factory.clientFactory })],
    });

    await agent.invoke(ask("when do I usually ship?"), { context: { user_id: "e2e-ctx-user" } });

    // (1) a client was built for the run's context user — the assertion that was failing.
    expect(factory.built).toEqual(["e2e-ctx-user"]);
    const client = factory.client("e2e-ctx-user");
    // (2) automatic recall ran for that user.
    expect(client.searchCalls.map((call) => call.query)).toEqual(["when do I usually ship?"]);
    // (3) so did automatic persistence.
    expect(client.conversationCalls).toHaveLength(1);
    expect(client.conversationCalls[0]!.messages[0]!.content).toBe("when do I usually ship?");
    // (4) and none of it fell through to the "no Cortadel user id for this run" degradation.
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves from runtime.context even when the agent declares no contextSchema", async () => {
    const factory = trackedFactory();
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      middleware: [createCortadelMemoryMiddleware({ clientFactory: factory.clientFactory })],
    });

    await agent.invoke(ask("hello"), { context: { user_id: "e2e-undeclared-ctx" } });

    // The middleware declares the key itself, so the host agent does not have to.
    expect(factory.built).toEqual(["e2e-undeclared-ctx"]);
    expect(factory.client("e2e-undeclared-ctx").searchCalls).toHaveLength(1);
  });

  it("resolves the user id from runtime.configurable", async () => {
    const factory = trackedFactory();
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      middleware: [createCortadelMemoryMiddleware({ clientFactory: factory.clientFactory })],
    });

    // What LangGraph Platform / Studio populate.
    await agent.invoke(ask("hello"), { configurable: { user_id: "e2e-cfg-user" } });

    expect(factory.built).toEqual(["e2e-cfg-user"]);
    expect(factory.client("e2e-cfg-user").conversationCalls).toHaveLength(1);
  });

  it("prefers runtime.context over runtime.configurable", async () => {
    const factory = trackedFactory();
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      middleware: [createCortadelMemoryMiddleware({ clientFactory: factory.clientFactory })],
    });

    await agent.invoke(ask("hello"), {
      context: { user_id: "e2e-from-context" },
      configurable: { user_id: "e2e-from-configurable", thread_id: "e2e-precedence-thread" },
    });

    expect(factory.built).toEqual(["e2e-from-context"]);
    // `thread_id` still comes from `configurable`, which is never filtered.
    expect(factory.client("e2e-from-context").conversationCalls[0]!.options).toMatchObject({
      sessionId: "e2e-precedence-thread",
    });
  });

  it("honours a custom userIdKey through the real runtime", async () => {
    const factory = trackedFactory();
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      contextSchema: z.object({ tenant: z.string() }),
      middleware: [
        createCortadelMemoryMiddleware({
          userIdKey: "tenant",
          clientFactory: factory.clientFactory,
        }),
      ],
    });

    await agent.invoke(ask("hello"), { context: { tenant: "e2e-tenant-1" } });

    // The declared context key follows `userIdKey`; a hardcoded "user_id" would leave this broken.
    expect(factory.built).toEqual(["e2e-tenant-1"]);
    expect(factory.client("e2e-tenant-1").searchCalls).toHaveLength(1);
  });

  it("takes the userIdKey from a shared provider", async () => {
    const factory = trackedFactory();
    // A provider shared with separately-created tools carries its own key, and that is the key
    // `ClientProvider.forRun` will look up — so it must also be the one declared to the runtime.
    const provider = new ClientProvider({
      clientFactory: factory.clientFactory,
      userIdKey: "account_id",
    });
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      middleware: [createCortadelMemoryMiddleware({ provider, userIdKey: "ignored_key" })],
    });

    await agent.invoke(ask("hello"), { context: { account_id: "e2e-account-9" } });

    expect(factory.built).toEqual(["e2e-account-9"]);
  });

  it("keeps two context-scoped users isolated in one agent", async () => {
    const factory = trackedFactory();
    // The shape of examples/multi-user.ts.
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      contextSchema: z.object({ user_id: z.string() }),
      middleware: [createCortadelMemoryMiddleware({ clientFactory: factory.clientFactory })],
    });

    await agent.invoke(ask("alice question"), { context: { user_id: "e2e-alice" } });
    await agent.invoke(ask("bob question"), { context: { user_id: "e2e-bob" } });
    await agent.invoke(ask("alice again"), { context: { user_id: "e2e-alice" } });

    // One client per user, built once and cached.
    expect(factory.built).toEqual(["e2e-alice", "e2e-bob"]);
    expect(factory.client("e2e-alice").searchCalls.map((call) => call.query)).toEqual([
      "alice question",
      "alice again",
    ]);
    expect(factory.client("e2e-bob").searchCalls.map((call) => call.query)).toEqual([
      "bob question",
    ]);
    // Neither user's turn was written to the other's client.
    expect(factory.client("e2e-alice").conversationCalls).toHaveLength(2);
    expect(factory.client("e2e-bob").conversationCalls).toHaveLength(1);
  });

  it("resolves the same context user for automatic memory and for the tools", async () => {
    const factory = trackedFactory();
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [{ id: "call-1", name: "search_memory", args: { query: "what do they maintain?" } }],
          [],
        ],
      }),
      contextSchema: z.object({ user_id: z.string() }),
      middleware: [createCortadelMemoryMiddleware({ clientFactory: factory.clientFactory })],
    });

    await agent.invoke(ask("what do I maintain?"), { context: { user_id: "e2e-both-halves" } });

    // The regression's signature was a tool that worked while automatic memory silently did not.
    // One client, and every arm on it: automatic recall, the tool's search, the turn's write.
    expect(factory.built).toEqual(["e2e-both-halves"]);
    const client = factory.client("e2e-both-halves");
    expect(client.searchCalls.map((call) => call.query)).toEqual([
      "what do I maintain?",
      "what do they maintain?",
    ]);
    expect(client.conversationCalls).toHaveLength(1);
  });

  it("disables memory for the run instead of throwing on an unusable context id", async () => {
    const factory = trackedFactory();
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({}),
      middleware: [createCortadelMemoryMiddleware({ clientFactory: factory.clientFactory })],
    });

    // The middleware's contextSchema declares the key as `unknown`, not `string`, precisely so this
    // parses instead of throwing a ZodError out of the agent graph: a bad id must cost the run its
    // memory, never its answer.
    const result = await agent.invoke(ask("still works?"), {
      context: { user_id: 42 } as unknown as Record<string, never>,
    });

    expect(result.messages.at(-1)!.text).toContain("still works?");
    expect(factory.built).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no Cortadel user id for this run"));
  });
});
