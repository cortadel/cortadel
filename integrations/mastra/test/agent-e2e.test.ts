import { Agent } from "@mastra/core/agent";
import { beforeEach, describe, expect, it } from "vitest";

import { cortadelMemory } from "../src/index.js";
import { fakeClientFactory, hit } from "./fake-client.js";

/**
 * The whole loop, offline: a real `Agent` from `@mastra/core` driving a stub
 * language model, with a real `CortadelMemoryProcessor` in front of it and a
 * fake Cortadel client behind it. Nothing here touches the network.
 *
 * What it proves, end to end:
 *   - the recalled memories actually reach the model's prompt as a system message
 *   - the finished turn actually reaches `addConversation`
 *   - `memory: { resource, thread }` is what scopes both
 */

interface CapturedPrompt {
  role: string;
  content: unknown;
}

/** Minimal LanguageModelV2 that records the prompt it was handed. */
function stubModel(reply: string) {
  const prompts: CapturedPrompt[][] = [];
  const finish = {
    finishReason: "stop" as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };

  const model = {
    specificationVersion: "v2",
    provider: "cortadel-test",
    modelId: "stub",
    supportedUrls: {},
    async doGenerate(options: { prompt: CapturedPrompt[] }) {
      prompts.push(options.prompt);
      return { content: [{ type: "text", text: reply }], warnings: [], ...finish };
    },
    async doStream(options: { prompt: CapturedPrompt[] }) {
      prompts.push(options.prompt);
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "r1", modelId: "stub", timestamp: new Date() },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: reply },
        { type: "text-end", id: "1" },
        { type: "finish", ...finish },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
        warnings: [],
      };
    },
  };

  return {
    model,
    /** System-role text handed to the model on the most recent call. */
    lastSystemText(): string {
      const prompt = prompts.at(-1) ?? [];
      return prompt
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n---\n");
    },
  };
}

const ALICE = "e2e-mastra-alice";

describe("agent end-to-end (stub model, fake Cortadel)", () => {
  let factory: ReturnType<typeof fakeClientFactory>;

  beforeEach(() => {
    factory = fakeClientFactory();
  });

  function buildAgent(reply = "Understood.") {
    const stub = stubModel(reply);
    const memory = cortadelMemory({ createClient: factory.createClient });
    const agent = new Agent({
      id: "cortadel-e2e",
      name: "cortadel-e2e",
      instructions: "You are a helpful assistant.",
      model: stub.model as never,
      tools: { ...memory.tools },
      inputProcessors: [memory.processor],
      outputProcessors: [memory.processor],
    });
    return { agent, stub, memory };
  }

  it("puts recalled memories into the model's system prompt", async () => {
    const { agent, stub } = buildAgent();
    factory.createClient(ALICE);
    factory.for(ALICE).hits = [hit("m1", "Alice ships to production only on Tuesdays")];

    await agent.generate("Can we release this Friday?", {
      memory: { resource: ALICE, thread: "t-1" },
    });

    const system = stub.lastSystemText();
    expect(system).toContain("You are a helpful assistant.");
    expect(system).toContain("Alice ships to production only on Tuesdays");
  });

  it("searches with what the user actually asked", async () => {
    const { agent } = buildAgent();

    await agent.generate("Can we release this Friday?", { memory: { resource: ALICE, thread: "t-1" } });

    expect(factory.for(ALICE).searchCalls[0]!.query).toBe("Can we release this Friday?");
  });

  it("persists the finished turn through addConversation", async () => {
    const { agent } = buildAgent("No — Tuesdays only.");

    await agent.generate("Can we release this Friday?", { memory: { resource: ALICE, thread: "t-1" } });

    expect(factory.for(ALICE).conversationCalls).toEqual([
      {
        messages: [
          { role: "user", content: "Can we release this Friday?" },
          { role: "assistant", content: "No — Tuesdays only." },
        ],
        options: { sessionId: "t-1" },
      },
    ]);
  });

  it("leaves the prompt clean when Cortadel has nothing to say", async () => {
    const { agent, stub } = buildAgent();

    await agent.generate("Can we release this Friday?", { memory: { resource: ALICE, thread: "t-1" } });

    expect(stub.lastSystemText()).toBe("You are a helpful assistant.");
  });

  it("keeps running — and keeps its prompt clean — when Cortadel is down", async () => {
    const stub = stubModel("Fine.");
    const memory = cortadelMemory({ createClient: factory.createClient, onError: () => {} });
    const agent = new Agent({
      id: "cortadel-e2e-down",
      name: "cortadel-e2e-down",
      instructions: "You are a helpful assistant.",
      model: stub.model as never,
      inputProcessors: [memory.processor],
      outputProcessors: [memory.processor],
    });
    factory.createClient(ALICE);
    factory.for(ALICE).searchError = new Error("connect ECONNREFUSED");
    factory.for(ALICE).conversationError = new Error("connect ECONNREFUSED");

    const result = await agent.generate("Can we release this Friday?", {
      memory: { resource: ALICE, thread: "t-1" },
    });

    expect(result.text).toBe("Fine.");
    expect(stub.lastSystemText()).toBe("You are a helpful assistant.");
  });

  it("keeps two users' memories apart across runs of the same agent", async () => {
    const { agent } = buildAgent();

    await agent.generate("What do you know about me?", { memory: { resource: ALICE, thread: "t-1" } });
    await agent.generate("What do you know about me?", { memory: { resource: "e2e-mastra-bob", thread: "t-2" } });

    expect(factory.requested).toEqual([ALICE, "e2e-mastra-bob"]);
    expect(factory.for(ALICE).searchCalls).toHaveLength(1);
    expect(factory.for("e2e-mastra-bob").searchCalls).toHaveLength(1);
  });

  it("registers both memory tools on the agent under their canonical names", async () => {
    const { agent } = buildAgent();
    const tools = await agent.listTools();

    // Mastra names a tool after its registration key, so these are the names
    // the model is offered.
    expect(Object.keys(tools).sort()).toEqual(["add_memories", "search_memory"]);
  });
});
