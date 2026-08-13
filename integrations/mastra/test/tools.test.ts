import { CortadelError } from "@cortadel/sdk";
import { standardSchemaToJSONSchema } from "@mastra/core/schema";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";

import { createCortadelTools } from "../src/index.js";
import type { CortadelErrorContext } from "../src/index.js";
import { fakeClientFactory, hit } from "./fake-client.js";

/** Tool `execute` only ever reads these fields off the execution context. */
function toolContext(options: {
  resourceId?: string;
  threadId?: string;
  requestContext?: RequestContext;
} = {}): never {
  return {
    agent: { resourceId: options.resourceId, threadId: options.threadId },
    requestContext: options.requestContext ?? new RequestContext(),
  } as never;
}

describe("tool registration", () => {
  const { search_memory: searchMemory, add_memories: addMemories } = createCortadelTools({
    createClient: fakeClientFactory().createClient,
  });

  it("names both tools after Cortadel's own MCP tools", () => {
    // Mastra names a tool after the key it is registered under, so these keys
    // are what the model actually calls.
    expect(Object.keys(createCortadelTools())).toEqual(["search_memory", "add_memories"]);
    expect(searchMemory.id).toBe("search_memory");
    expect(addMemories.id).toBe("add_memories");
  });

  it("lets the id prefix disambiguate two tool sets in a registry", () => {
    const tools = createCortadelTools({ idPrefix: "memory" });
    expect(tools.search_memory.id).toBe("memory_search_memory");
    expect(tools.add_memories.id).toBe("memory_add_memories");
    // The prefix is an id, not a rename: the model-facing keys are unchanged.
    expect(Object.keys(tools)).toEqual(["search_memory", "add_memories"]);
  });

  it("describes both tools so the model knows when to reach for them", () => {
    expect(searchMemory.description).toMatch(/long-term/i);
    expect(addMemories.description).toMatch(/long-term/i);
  });

  it("exposes a JSON schema the model can call: search takes a query", () => {
    const schema = standardSchemaToJSONSchema(searchMemory.inputSchema!) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["query", "topK"]);
    expect(schema.required).toEqual(["query"]);
  });

  it("exposes a JSON schema the model can call: add takes statements", () => {
    const schema = standardSchemaToJSONSchema(addMemories.inputSchema!) as {
      properties: { statements: { type: string; items: { type: string } } };
      required: string[];
    };
    expect(schema.required).toEqual(["statements"]);
    expect(schema.properties.statements.type).toBe("array");
    expect(schema.properties.statements.items.type).toBe("string");
  });

  it("declares output schemas for both tools", () => {
    expect(searchMemory.outputSchema).toBeDefined();
    expect(addMemories.outputSchema).toBeDefined();
  });

  it("rejects a malformed call before it reaches Cortadel", async () => {
    const result = (await searchMemory.execute!({} as never, toolContext())) as { error?: unknown };
    expect(result).toMatchObject({ error: true });
  });
});

describe("search_memory", () => {
  it("searches the user's memory and maps the hits for the model", async () => {
    const factory = fakeClientFactory();
    const { search_memory: searchMemory } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
    });
    factory.createClient("e2e-mastra-alice");
    factory.for("e2e-mastra-alice").hits = [
      hit("m1", "Prefers dark mode", { rrfScore: 0.42, createdAt: "2026-01-01T00:00:00Z", categories: ["prefs"] }),
    ];

    const result = await searchMemory.execute!({ query: "preferences?" }, toolContext());

    expect(result).toEqual({
      count: 1,
      memories: [
        {
          id: "m1",
          content: "Prefers dark mode",
          score: 0.42,
          createdAt: "2026-01-01T00:00:00Z",
          categories: ["prefs"],
        },
      ],
    });
    expect(factory.for("e2e-mastra-alice").searchCalls[0]).toMatchObject({
      query: "preferences?",
      options: { topK: 10, mode: "hybrid" },
    });
  });

  it("honours the model's topK, the configured default, and the rerank flag", async () => {
    const factory = fakeClientFactory();
    const { search_memory: searchMemory } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
      topK: 3,
      rerank: true,
      searchMode: "vector",
    });

    await searchMemory.execute!({ query: "a" }, toolContext());
    await searchMemory.execute!({ query: "b", topK: 11 }, toolContext());

    const calls = factory.for("e2e-mastra-alice").searchCalls;
    expect(calls[0]!.options).toMatchObject({ topK: 3, mode: "vector", rerank: "cross_encoder" });
    expect(calls[1]!.options).toMatchObject({ topK: 11 });
  });

  it("scopes to Mastra's resourceId when no userId is pinned", async () => {
    const factory = fakeClientFactory();
    const { search_memory: searchMemory } = createCortadelTools({ createClient: factory.createClient });

    await searchMemory.execute!({ query: "x" }, toolContext({ resourceId: "e2e-mastra-alice" }));
    await searchMemory.execute!({ query: "x" }, toolContext({ resourceId: "e2e-mastra-bob" }));

    expect(factory.requested).toEqual(["e2e-mastra-alice", "e2e-mastra-bob"]);
    expect(factory.for("e2e-mastra-alice").searchCalls).toHaveLength(1);
    expect(factory.for("e2e-mastra-bob").searchCalls).toHaveLength(1);
  });

  it("reads the resourceId out of the request context when the agent context has none", async () => {
    const factory = fakeClientFactory();
    const { search_memory: searchMemory } = createCortadelTools({ createClient: factory.createClient });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "e2e-mastra-from-context");

    await searchMemory.execute!({ query: "x" }, toolContext({ requestContext }));

    expect(factory.requested).toEqual(["e2e-mastra-from-context"]);
  });

  it("searches across threads by default, and inside one when asked", async () => {
    const factory = fakeClientFactory();
    const wide = createCortadelTools({ createClient: factory.createClient, userId: "e2e-mastra-alice" });
    const scoped = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
      scopeRecallToSession: true,
    });

    await wide.search_memory.execute!({ query: "x" }, toolContext({ threadId: "t-1" }));
    await scoped.search_memory.execute!({ query: "x" }, toolContext({ threadId: "t-1" }));

    const calls = factory.for("e2e-mastra-alice").searchCalls;
    expect(calls[0]!.options).not.toHaveProperty("sessionId");
    expect(calls[1]!.options).toMatchObject({ sessionId: "t-1" });
  });

  it("returns an explanatory error instead of guessing a user id", async () => {
    const factory = fakeClientFactory();
    const { search_memory: searchMemory } = createCortadelTools({ createClient: factory.createClient });

    const result = (await searchMemory.execute!({ query: "x" }, toolContext())) as {
      count: number;
      error?: string;
    };

    expect(result.count).toBe(0);
    expect(result.error).toMatch(/No Cortadel user id/);
    expect(factory.requested).toEqual([]);
  });

  it("degrades to an error field — a memory outage never throws into the tool loop", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn<(error: unknown, context: CortadelErrorContext) => void>();
    const { search_memory: searchMemory } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
      onError,
    });
    factory.createClient("e2e-mastra-alice");
    factory.for("e2e-mastra-alice").searchError = new CortadelError(0, "transport_error", "connect ECONNREFUSED");

    const result = (await searchMemory.execute!({ query: "x" }, toolContext())) as {
      count: number;
      error?: string;
    };

    expect(result).toEqual({ memories: [], count: 0, error: "connect ECONNREFUSED" });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![1]).toMatchObject({ operation: "search-tool", userId: "e2e-mastra-alice" });
  });
});

describe("add_memories", () => {
  it("stores every statement and reports what the pipeline did with each", async () => {
    const factory = fakeClientFactory();
    const { add_memories: addMemories } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
    });

    const result = await addMemories.execute!(
      { statements: ["Alice prefers dark mode.", "Alice ships on Fridays."] },
      toolContext(),
    );

    expect(result).toEqual({
      count: 2,
      stored: [
        { text: "Alice prefers dark mode.", id: "mem-1", event: "ADD" },
        { text: "Alice ships on Fridays.", id: "mem-2", event: "ADD" },
      ],
    });
  });

  it("labels the writing app via AddOptions.app (appName is search-only)", async () => {
    const factory = fakeClientFactory();
    const { add_memories: addMemories } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
    });

    await addMemories.execute!({ statements: ["A fact."] }, toolContext());

    expect(factory.for("e2e-mastra-alice").addCalls[0]!.options).toEqual({ app: "cortadel-mastra" });
  });

  it("surfaces SKIP_DUPLICATE rather than pretending a write happened", async () => {
    const factory = fakeClientFactory();
    const { add_memories: addMemories } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
    });
    factory.createClient("e2e-mastra-alice");
    factory.for("e2e-mastra-alice").addEvent = "SKIP_DUPLICATE";

    const result = (await addMemories.execute!({ statements: ["A fact."] }, toolContext())) as {
      stored: Array<{ event?: string }>;
    };

    expect(result.stored[0]!.event).toBe("SKIP_DUPLICATE");
  });

  it("reports a write failure per statement without throwing", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn();
    const { add_memories: addMemories } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
      onError,
    });
    factory.createClient("e2e-mastra-alice");
    factory.for("e2e-mastra-alice").addError = new CortadelError(503, "http_error", "server unavailable");

    const result = (await addMemories.execute!({ statements: ["A fact."] }, toolContext())) as {
      count: number;
      stored: Array<{ error?: string }>;
    };

    expect(result.count).toBe(0);
    expect(result.stored[0]!.error).toBe("server unavailable");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("refuses to write without a resolved user id", async () => {
    const factory = fakeClientFactory();
    const { add_memories: addMemories } = createCortadelTools({ createClient: factory.createClient });

    const result = (await addMemories.execute!({ statements: ["A fact."] }, toolContext())) as {
      error?: string;
    };

    expect(result.error).toMatch(/No Cortadel user id/);
    expect(factory.requested).toEqual([]);
  });
});

describe("throwOnError — memory as a hard dependency", () => {
  it("throws the search failure instead of returning it, after telling onError", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn<(error: unknown, context: CortadelErrorContext) => void>();
    const { search_memory: searchMemory } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
      throwOnError: true,
      onError,
    });
    factory.createClient("e2e-mastra-alice");
    factory.for("e2e-mastra-alice").searchError = new CortadelError(0, "transport_error", "connect ECONNREFUSED");

    await expect(searchMemory.execute!({ query: "x" }, toolContext())).rejects.toThrow(
      "connect ECONNREFUSED",
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  it("throws a write failure too", async () => {
    const factory = fakeClientFactory();
    const { add_memories: addMemories } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
      throwOnError: true,
      onError: () => {},
    });
    factory.createClient("e2e-mastra-alice");
    factory.for("e2e-mastra-alice").addError = new CortadelError(503, "http_error", "server unavailable");

    await expect(
      addMemories.execute!({ statements: ["A fact."] }, toolContext()),
    ).rejects.toThrow("server unavailable");
  });

  it("throws rather than silently no-opping when no user id resolves", async () => {
    const { search_memory: searchMemory } = createCortadelTools({
      createClient: fakeClientFactory().createClient,
      throwOnError: true,
    });

    await expect(searchMemory.execute!({ query: "x" }, toolContext())).rejects.toThrow(
      /No Cortadel user id/,
    );
  });

  it("is off by default — the tool still returns its error field", async () => {
    const factory = fakeClientFactory();
    const { search_memory: searchMemory } = createCortadelTools({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
      onError: () => {},
    });
    factory.createClient("e2e-mastra-alice");
    factory.for("e2e-mastra-alice").searchError = new Error("down");

    await expect(searchMemory.execute!({ query: "x" }, toolContext())).resolves.toMatchObject({
      error: "down",
    });
  });
});
