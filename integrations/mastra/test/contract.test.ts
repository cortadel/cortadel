import { CortadelClient } from "@cortadel/sdk";
import { Agent } from "@mastra/core/agent";
import type { InputProcessor, OutputProcessor } from "@mastra/core/processors";
import { describe, expect, it } from "vitest";

import { CortadelMemoryProcessor, cortadelMemory, createCortadelTools } from "../src/index.js";
import type { CortadelClientLike } from "../src/index.js";
import { fakeClientFactory } from "./fake-client.js";

/**
 * These tests are the seam checks: they fail loudly if either the Cortadel SDK
 * or Mastra changes the shape this package is built on. No network, no keys.
 */
describe("Cortadel SDK contract", () => {
  it("a real CortadelClient satisfies CortadelClientLike", () => {
    const client: CortadelClientLike = new CortadelClient({
      baseUrl: "http://localhost:3001",
      userId: "e2e-mastra-contract",
      appName: "cortadel-mastra",
    });

    expect(typeof client.search).toBe("function");
    expect(typeof client.add).toBe("function");
    expect(typeof client.addConversation).toBe("function");
  });

  it("only builds on the seven published SDK methods", () => {
    const client = new CortadelClient({ baseUrl: "http://localhost:3001", userId: "e2e-mastra-contract" });
    for (const method of ["add", "addConversation", "search", "list", "get", "delete", "health"]) {
      expect(typeof (client as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });
});

describe("Mastra contract", () => {
  const factory = fakeClientFactory();
  const memory = cortadelMemory({ createClient: factory.createClient, userId: "e2e-mastra-contract" });

  it("the processor is assignable to both InputProcessor and OutputProcessor", () => {
    const asInput: InputProcessor = memory.processor;
    const asOutput: OutputProcessor = memory.processor;

    expect(asInput.id).toBe("cortadel-memory");
    expect(asOutput.id).toBe("cortadel-memory");
  });

  it("an Agent accepts the processor in both arrays and the tools alongside", () => {
    const agent = new Agent({
      id: "cortadel-contract-agent",
      name: "cortadel-contract-agent",
      instructions: "You are a helpful assistant.",
      model: "openai/gpt-5",
      tools: { ...memory.tools },
      inputProcessors: [memory.processor],
      outputProcessors: [memory.processor],
    });

    expect(agent.id).toBe("cortadel-contract-agent");
  });

  it("cortadelMemory shares one client pool between the processor and the tools", async () => {
    const shared = fakeClientFactory();
    const bundle = cortadelMemory({ createClient: shared.createClient, userId: "e2e-mastra-shared" });

    await bundle.tools.search_memory.execute!({ query: "anything" }, {} as never);
    expect(bundle.pool.size).toBe(1);
    expect(shared.requested).toEqual(["e2e-mastra-shared"]);
  });

  it("exports the tools and processor as separately usable pieces", () => {
    expect(Object.keys(createCortadelTools())).toEqual(["search_memory", "add_memories"]);
    expect(new CortadelMemoryProcessor()).toBeInstanceOf(CortadelMemoryProcessor);
  });
});
