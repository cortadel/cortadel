import { describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ZodType } from "zod";

import { cortadelMemory, cortadelTools } from "../src/index.js";
import type { AddMemoriesResult, SearchMemoryResult } from "../src/index.js";
import { FakeCortadelClient, TEST_USER, hit, textResult, toolCallResult } from "./harness.js";

/** Calls a tool's `execute` the way the AI SDK does, with the options bag it always supplies. */
async function run<T>(toolDef: unknown, input: unknown): Promise<T> {
  const execute = (toolDef as { execute: (i: unknown, o: unknown) => Promise<T> }).execute;
  return execute(input, { toolCallId: "call-1", messages: [], context: undefined });
}

function schemaOf(toolDef: unknown): ZodType {
  return (toolDef as { inputSchema: ZodType }).inputSchema;
}

describe("tool registration", () => {
  it("registers the two tools under Cortadel's own MCP tool names", () => {
    const tools = cortadelTools({ client: new FakeCortadelClient(), userId: TEST_USER });

    expect(Object.keys(tools).sort()).toEqual(["add_memories", "search_memory"]);
    for (const name of ["search_memory", "add_memories"] as const) {
      expect(typeof tools[name].description).toBe("string");
      expect((tools[name].description as string).length).toBeGreaterThan(40);
      expect(tools[name].inputSchema).toBeDefined();
      expect(typeof (tools[name] as { execute?: unknown }).execute).toBe("function");
    }
  });

  it("never exposes a user id in a tool's input schema", () => {
    // The scoping guarantee: the user id lives on the client, so no prompt-injected instruction
    // can talk the model into reading another user's memories.
    const tools = cortadelTools({ client: new FakeCortadelClient(), userId: TEST_USER });

    for (const name of ["search_memory", "add_memories"] as const) {
      const parsed = schemaOf(tools[name]).safeParse({
        query: "x",
        memories: ["x"],
        userId: `${TEST_USER}-someone-else`,
      });
      expect(parsed.success).toBe(true);
      expect(JSON.stringify(parsed.data)).not.toContain("someone-else");
    }
  });

  it("validates the search input schema", () => {
    const tools = cortadelTools({ client: new FakeCortadelClient(), userId: TEST_USER });
    const schema = schemaOf(tools.search_memory);

    expect(schema.safeParse({ query: "what do you know?" }).success).toBe(true);
    expect(schema.safeParse({ query: "what do you know?", topK: 5 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ query: "" }).success).toBe(false);
    expect(schema.safeParse({ query: "x", topK: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", topK: 99 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", topK: 1.5 }).success).toBe(false);
  });

  it("validates the add input schema", () => {
    const tools = cortadelTools({ client: new FakeCortadelClient(), userId: TEST_USER });
    const schema = schemaOf(tools.add_memories);

    expect(schema.safeParse({ memories: ["a fact"] }).success).toBe(true);
    expect(schema.safeParse({ memories: [] }).success).toBe(false);
    expect(schema.safeParse({ memories: [""] }).success).toBe(false);
    expect(schema.safeParse({ memories: "a fact" }).success).toBe(false);
  });
});

describe("search_memory", () => {
  it("returns the hits mapped to a compact model-facing shape", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [
      hit({ id: "m1", content: "A fact.", rrfScore: 0.7, createdAt: "2026-03-04T10:00:00Z" }),
      hit({ id: "m2", content: "Another fact." }),
    ];
    const tools = cortadelTools({ client: fake, userId: TEST_USER });

    const result = await run<SearchMemoryResult>(tools.search_memory, { query: "facts?" });

    expect(result).toEqual({
      count: 2,
      memories: [
        { id: "m1", content: "A fact.", score: 0.7, createdAt: "2026-03-04T10:00:00Z" },
        { id: "m2", content: "Another fact." },
      ],
    });
    expect(fake.searchCalls[0]?.query).toBe("facts?");
  });

  it("lets the model override topK but otherwise uses the configured defaults", async () => {
    const fake = new FakeCortadelClient();
    const tools = cortadelTools({
      client: fake,
      userId: TEST_USER,
      search: { topK: 6, mode: "text", rerank: "cross_encoder", sessionId: "s1" },
    });

    await run(tools.search_memory, { query: "a" });
    await run(tools.search_memory, { query: "b", topK: 20 });

    expect(fake.searchCalls[0]?.options).toMatchObject({ topK: 6, mode: "text", sessionId: "s1" });
    expect(fake.searchCalls[1]?.options).toMatchObject({ topK: 20, rerank: "cross_encoder" });
  });

  it("asks for ten memories by default, matching the SDK's own search default", async () => {
    const fake = new FakeCortadelClient();
    const tools = cortadelTools({ client: fake, userId: TEST_USER });

    await run(tools.search_memory, { query: "x" });

    expect(fake.searchCalls[0]?.options?.topK).toBe(10);
  });

  it("throws out of the tool when throwOnError is set", async () => {
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("connect ECONNREFUSED 127.0.0.1:3001");
    const tools = cortadelTools({
      client: fake,
      userId: TEST_USER,
      throwOnError: true,
      onError: () => {},
    });

    await expect(run(tools.search_memory, { query: "x" })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("warns through the console when a failure is swallowed unobserved", async () => {
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("down");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = cortadelTools({ client: fake, userId: TEST_USER });

    try {
      const result = await run<SearchMemoryResult>(tools.search_memory, { query: "x" });

      expect(result.error).toBe("down");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("applies minScore", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [
      hit({ id: "m1", content: "Strong.", rrfScore: 0.9 }),
      hit({ id: "m2", content: "Weak.", rrfScore: 0.2 }),
    ];
    const tools = cortadelTools({ client: fake, userId: TEST_USER, search: { minScore: 0.5 } });

    const result = await run<SearchMemoryResult>(tools.search_memory, { query: "x" });

    expect(result.memories.map((m) => m.id)).toEqual(["m1"]);
  });

  it("reports a failure as a result instead of throwing into the agent loop", async () => {
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("connect ECONNREFUSED 127.0.0.1:3001");
    const errors: string[] = [];
    const tools = cortadelTools({
      client: fake,
      userId: TEST_USER,
      onError: (_e, context) => errors.push(context.phase),
    });

    const result = await run<SearchMemoryResult>(tools.search_memory, { query: "x" });

    expect(result).toEqual({
      memories: [],
      count: 0,
      error: "connect ECONNREFUSED 127.0.0.1:3001",
    });
    expect(errors).toEqual(["recall"]);
  });
});

describe("add_memories", () => {
  it("stores each fact and separates writes from duplicates", async () => {
    const fake = new FakeCortadelClient();
    fake.addEvents = [
      { id: "m1", event: "ADD" },
      { id: "m2", event: "SKIP_DUPLICATE" },
    ];
    const tools = cortadelTools({
      client: fake,
      userId: TEST_USER,
      add: { app: "demo", infer: false, memoryType: "semantic" },
    });

    const result = await run<AddMemoriesResult>(tools.add_memories, {
      memories: ["Fact one.", "Fact two."],
    });

    expect(result).toEqual({ stored: 1, duplicates: 1, ids: ["m1", "m2"] });
    expect(fake.addCalls.map((c) => c.text)).toEqual(["Fact one.", "Fact two."]);
    expect(fake.addCalls[0]?.options).toEqual({
      app: "demo",
      infer: false,
      memoryType: "semantic",
      metadata: undefined,
    });
  });

  it("returns what it managed to store when a later write fails", async () => {
    const fake = new FakeCortadelClient();
    const tools = cortadelTools({ client: fake, userId: TEST_USER });
    const original = fake.add.bind(fake);
    let calls = 0;
    fake.add = async (text, options) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("503 degraded");
      }
      return original(text, options);
    };
    // No onError here, so the swallowed failure would reach console.warn — asserted in its own
    // test above; silenced here to keep the suite's output about failures that matter.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await run<AddMemoriesResult>(tools.add_memories, {
        memories: ["Fact one.", "Fact two."],
      });

      expect(result.stored).toBe(1);
      expect(result.ids).toEqual(["mem-1"]);
      expect(result.error).toBe("503 degraded");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("end to end through generateText", () => {
  it("the model can call search_memory and receives the memories back", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [hit({ id: "m1", content: "Deploys on Fridays." })];

    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCallResult("search_memory", { query: "deployment habits" }),
        textResult("You deploy on Fridays."),
      ],
    });

    const result = await generateText({
      model,
      tools: cortadelTools({ client: fake, userId: TEST_USER }),
      stopWhen: stepCountIs(5),
      prompt: "When do I deploy?",
    });

    expect(fake.searchCalls[0]?.query).toBe("deployment habits");
    expect(result.steps[0]?.toolResults[0]?.output).toEqual({
      count: 1,
      memories: [{ id: "m1", content: "Deploys on Fridays." }],
    });
    expect(result.text).toBe("You deploy on Fridays.");
  });
});

describe("composing tools with the middleware", () => {
  it("shares one client between both surfaces", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [hit({ id: "m1", content: "A fact." })];

    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate: textResult("Done.") }),
      middleware: cortadelMemory({ client: fake, userId: TEST_USER, awaitPersist: true }),
    });
    const tools = cortadelTools({ client: fake, userId: TEST_USER });

    await generateText({ model, tools, prompt: "Hello" });

    // One automatic recall from the middleware, and the tools are registered alongside it.
    expect(fake.searchCalls).toHaveLength(1);
    expect(fake.conversationCalls).toHaveLength(1);
    expect(Object.keys(tools)).toContain("search_memory");
  });
});
