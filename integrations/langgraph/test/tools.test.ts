import type { SearchOptions } from "@cortadel/sdk";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { InMemoryStore } from "@langchain/langgraph";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CortadelStore,
  createAddMemoriesTool,
  createMemoryTools,
  createSearchMemoryTool,
} from "../src/index.js";
import { FakeBackend, NAMESPACE, RecordingLogger, USER, hit, serverError } from "./fake-cortadel.js";

let backend: FakeBackend;

function newStore(overrides: Record<string, unknown> = {}) {
  return new CortadelStore({
    baseUrl: "http://localhost:3001",
    userId: USER,
    throwOnError: true,
    clientFactory: backend.factory,
    ...overrides,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonSchemaOf(tool: { schema: any }): Record<string, any> {
  return toJsonSchema(tool.schema) as Record<string, unknown>;
}

beforeEach(() => {
  backend = new FakeBackend();
});

describe("tool shape", () => {
  it("names both tools the way Cortadel's own MCP surface does", () => {
    const [search, add] = createMemoryTools({ store: newStore(), namespace: NAMESPACE });
    expect(search.name).toBe("search_memory");
    expect(add.name).toBe("add_memories");
    expect(search.description.length).toBeGreaterThan(40);
    expect(add.description.length).toBeGreaterThan(40);
  });

  it("advertises a usable JSON schema for search", () => {
    const tool = createSearchMemoryTool({ store: newStore(), namespace: NAMESPACE });
    const schema = jsonSchemaOf(tool);
    expect(Object.keys(schema.properties as object).sort()).toEqual(["query", "topK"]);
    expect((schema.properties as Record<string, Record<string, unknown>>).topK.default).toBe(10);
  });

  it("does not oblige the model to supply topK", () => {
    // zod v4's JSON Schema is derived from the *output* type, so a bare `.default()` would land in
    // `required` and force the model to send a value every call. `.optional()` around the default
    // is what keeps it advertised-but-omittable.
    const tool = createSearchMemoryTool({ store: newStore(), namespace: NAMESPACE });
    const required = (jsonSchemaOf(tool).required ?? []) as string[];
    expect(required).toEqual(["query"]);
  });

  it("advertises a list of strings for add", () => {
    const tool = createAddMemoriesTool({ store: newStore(), namespace: NAMESPACE });
    const schema = jsonSchemaOf(tool);
    const memories = (schema.properties as Record<string, Record<string, unknown>>).memories;
    expect(memories.type).toBe("array");
    expect((memories.items as Record<string, unknown>).type).toBe("string");
  });

  it("bakes the configured topK into the advertised schema, not just the closure", () => {
    // The model only ever sees the schema default, and zod fills it in during parsing before the
    // callback's fallback is consulted — so a configured topK that lived only in the closure would
    // silently never apply.
    const tool = createSearchMemoryTool({ store: newStore(), namespace: NAMESPACE, topK: 3 });
    const schema = jsonSchemaOf(tool);
    expect((schema.properties as Record<string, Record<string, unknown>>).topK.default).toBe(3);
  });

  it("lets names and descriptions be overridden", () => {
    const tool = createSearchMemoryTool({
      store: newStore(),
      namespace: NAMESPACE,
      name: "recall",
      description: "Look things up.",
    });
    expect(tool.name).toBe("recall");
    expect(tool.description).toBe("Look things up.");
  });
});

describe("search_memory", () => {
  it("returns the memories as tool text", async () => {
    backend.searchHits = [hit("m1", "Ships on Fridays.", { rrfScore: 0.812 })];
    const tool = createSearchMemoryTool({ store: newStore(), namespace: NAMESPACE });
    const result = await tool.invoke({ query: "deploy day" });
    expect(result).toBe("Relevant memories:\n1. Ships on Fridays. (relevance 0.812)");
  });

  it("says so when there is nothing", async () => {
    const tool = createSearchMemoryTool({ store: newStore(), namespace: NAMESPACE });
    expect(await tool.invoke({ query: "anything" })).toBe("No relevant memories found.");
  });

  it("passes the model's topK through", async () => {
    const tool = createSearchMemoryTool({ store: newStore(), namespace: NAMESPACE });
    await tool.invoke({ query: "q", topK: 2 });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.topK).toBe(2);
  });

  it("falls back to the configured topK when the model omits it", async () => {
    const tool = createSearchMemoryTool({ store: newStore(), namespace: NAMESPACE, topK: 4 });
    await tool.invoke({ query: "q" });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.topK).toBe(4);
  });

  it("forwards topK from createMemoryTools", async () => {
    const [search] = createMemoryTools({ store: newStore(), namespace: NAMESPACE, topK: 7 });
    await search.invoke({ query: "q" });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.topK).toBe(7);
  });

  it("reaches the model as a plain no-results answer when the server is down", async () => {
    backend.failures.set("search", serverError());
    const store = newStore({ throwOnError: false, logger: new RecordingLogger() });
    const tool = createSearchMemoryTool({ store, namespace: NAMESPACE });
    expect(await tool.invoke({ query: "q" })).toBe("No relevant memories found.");
  });
});

describe("add_memories", () => {
  it("writes one memory per fact", async () => {
    const tool = createAddMemoriesTool({ store: newStore(), namespace: NAMESPACE });
    const result = await tool.invoke({ memories: ["Fact one.", "Fact two."] });
    expect(result).toBe("Stored 2 memories.");
    expect(backend.count("add")).toBe(2);
    expect(backend.first("add")[0]).toBe("Fact one.");
  });

  it("uses the singular for one memory", async () => {
    const tool = createAddMemoriesTool({ store: newStore(), namespace: NAMESPACE });
    expect(await tool.invoke({ memories: ["Only one."] })).toBe("Stored 1 memory.");
  });

  it("ignores blank entries", async () => {
    const tool = createAddMemoriesTool({ store: newStore(), namespace: NAMESPACE });
    const result = await tool.invoke({ memories: ["  ", ""] });
    expect(result).toBe("Nothing to store: no non-empty memories were provided.");
    expect(backend.count("add")).toBe(0);
  });
});

describe("store resolution", () => {
  it("works against any BaseStore, not just Cortadel's", async () => {
    const store = new InMemoryStore();
    const namespace = ["memories", "e2e-inmemory"];
    const add = createAddMemoriesTool({ store, namespace });
    const search = createSearchMemoryTool({ store, namespace });
    await add.invoke({ memories: ["Prefers dark mode."] });
    expect(await search.invoke({ query: "anything" })).toContain("Prefers dark mode.");
  });

  it("explains itself when invoked outside a graph with no store", async () => {
    const tool = createSearchMemoryTool({ namespace: NAMESPACE });
    await expect(tool.invoke({ query: "q" })).rejects.toThrow(/No store is available/);
  });

  it("says what is missing when a templated namespace cannot be resolved", async () => {
    // A tool always receives a config object (LangChain synthesises one), so the failure is the
    // precise "missing userId" message rather than the "no config at all" one.
    const tool = createSearchMemoryTool({ store: newStore(), namespace: ["memories", "{userId}"] });
    await expect(tool.invoke({ query: "q" })).rejects.toThrow(
      /missing "userId" in config.configurable/,
    );
  });

  it("resolves a templated namespace from the invocation config", async () => {
    const store = newStore({ userId: (ns: string[]) => ns[ns.length - 1]! });
    const tool = createSearchMemoryTool({ store, namespace: ["memories", "{userId}"] });
    await tool.invoke({ query: "q" }, { configurable: { userId: "e2e-templated" } });
    expect(backend.users()).toEqual(["e2e-templated"]);
  });
});
