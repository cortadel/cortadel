/** The memory tools, driven through the real in-process MCP server. */

import { beforeEach, describe, expect, it } from "vitest";
import { CortadelError } from "@cortadel/sdk";

import { CortadelMemory } from "../src/index.js";
import { FakeCortadel, callTool, hit, listTools, toolText } from "./helpers.js";

let fake: FakeCortadel;
let memory: CortadelMemory;

beforeEach(() => {
  fake = new FakeCortadel();
  memory = CortadelMemory.fromClient(fake);
});

describe("registration and schema shape", () => {
  it("registers exactly the two memory tools", async () => {
    const names = (await listTools(memory)).map((tool) => tool.name).sort();
    expect(names).toEqual(["add_memories", "search_memory"]);
  });

  it("requires query and leaves top_k optional", async () => {
    const search = (await listTools(memory)).find((tool) => tool.name === "search_memory")!;

    expect(search.inputSchema.required).toEqual(["query"]);
    expect(Object.keys(search.inputSchema.properties ?? {}).sort()).toEqual(["query", "top_k"]);
    expect(search.inputSchema.properties?.top_k?.type).toBe("integer");
  });

  it("requires text and constrains memory_type", async () => {
    const add = (await listTools(memory)).find((tool) => tool.name === "add_memories")!;

    expect(add.inputSchema.required).toEqual(["text"]);
    expect(add.inputSchema.properties?.memory_type?.enum).toEqual([
      "episodic",
      "semantic",
      "procedural",
    ]);
  });

  it("annotates search read-only, which is what lets Claude batch it", async () => {
    const search = (await listTools(memory)).find((tool) => tool.name === "search_memory")!;

    expect(search.annotations?.readOnlyHint).toBe(true);
  });

  it("carries the MCP server prefix on the allowed-tool names", () => {
    expect(memory.allowedTools).toEqual([
      "mcp__cortadel__search_memory",
      "mcp__cortadel__add_memories",
    ]);
  });

  it("lets serverName drive the prefix", () => {
    const renamed = CortadelMemory.fromClient(fake, { serverName: "team_memory" });

    expect(renamed.allowedTools).toEqual([
      "mcp__team_memory__search_memory",
      "mcp__team_memory__add_memories",
    ]);
    expect(renamed.mcpServer.name).toBe("team_memory");
  });

  it("builds the MCP server once", () => {
    expect(memory.mcpServer).toBe(memory.mcpServer);
  });

  it("exposes the same tool definitions the server carries", () => {
    expect(memory.tools.map((tool) => tool.name)).toEqual(["search_memory", "add_memories"]);
    expect(memory.tools).toBe(memory.tools);
  });
});

describe("search_memory", () => {
  it("returns formatted hits", async () => {
    fake.searchResults = [hit("mem-a", "Alice ships on Fridays.", { rrfScore: 0.42 })];

    const result = await callTool(memory, "search_memory", { query: "when does alice ship?" });

    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toBe("- (2026-08-13, score 0.42) [id mem-a] Alice ships on Fridays.");
  });

  it("uses the configured topK by default", async () => {
    await callTool(memory, "search_memory", { query: "anything at all" });

    const [query, options] = fake.searches[0]!;
    expect(query).toBe("anything at all");
    expect(options?.topK).toBe(5);
    expect(options?.mode).toBe("hybrid");
  });

  it("honours an explicit top_k", async () => {
    await callTool(memory, "search_memory", { query: "anything at all", top_k: 3 });

    expect(fake.searches[0]![1]?.topK).toBe(3);
  });

  it("rejects an out-of-range top_k at the MCP layer", async () => {
    const result = await callTool(memory, "search_memory", { query: "anything", top_k: 900 });

    expect(result.isError).toBe(true);
    expect(fake.searches).toEqual([]);
  });

  it("clamps top_k when the handler is called directly", async () => {
    // The SDK's own schema validation rejects out-of-range values, but a direct
    // handler call should still not send the server a top_k it will reject.
    await memory.toolSearch({ query: "anything at all", top_k: 900 });

    expect(fake.searches[0]![1]?.topK).toBe(50);
  });

  it("reports an empty result set", async () => {
    const result = await callTool(memory, "search_memory", { query: "nothing stored yet" });

    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toContain("No memories found");
  });

  it("rejects a missing query before the handler runs", async () => {
    const result = await callTool(memory, "search_memory", {});

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("query");
    expect(fake.searches).toEqual([]);
  });
});

describe("add_memories", () => {
  it("stores the text and stamps the app", async () => {
    await callTool(memory, "add_memories", { text: "Alice prefers dark mode." });

    const [text, options] = fake.adds[0]!;
    expect(text).toBe("Alice prefers dark mode.");
    expect(options?.app).toBe("@cortadel/claude-agent-sdk");
    expect(options?.memoryType).toBeUndefined();
  });

  it("passes memory_type through", async () => {
    await callTool(memory, "add_memories", {
      text: "Deploys go out on Tuesday.",
      memory_type: "procedural",
    });

    expect(fake.adds[0]![1]?.memoryType).toBe("procedural");
  });

  it("surfaces the pipeline event, because a 2xx is not always a write", async () => {
    fake.created = { id: "mem-9", event: "SKIP_DUPLICATE" };

    const result = await callTool(memory, "add_memories", { text: "Alice prefers dark mode." });

    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toContain("mem-9");
    expect(toolText(result)).toContain("SKIP_DUPLICATE");
  });
});

describe("error propagation", () => {
  it("turns a search failure into an isError result rather than throwing at the agent", async () => {
    fake.searchError = new CortadelError(503, "transport_error", "connection refused");

    const result = await callTool(memory, "search_memory", { query: "when does alice ship?" });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("transport_error");
    expect(toolText(result)).toContain("503");
    expect(toolText(result)).toContain("connection refused");
  });

  it("turns a write failure into an isError result", async () => {
    fake.addError = new CortadelError(422, "validation_error", "text is required");

    const result = await callTool(memory, "add_memories", { text: "Alice prefers dark mode." });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("validation_error");
  });

  it("turns an unexpected failure into an isError result", async () => {
    fake.searchError = new RangeError("boom");

    const result = await callTool(memory, "search_memory", { query: "when does alice ship?" });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("RangeError: boom");
  });

  it("also reports a tool failure to onError", async () => {
    const seen: unknown[] = [];
    const observed = CortadelMemory.fromClient(fake, { onError: (error) => seen.push(error) });
    fake.searchError = new CortadelError(503, "transport_error", "connection refused");

    const result = await callTool(observed, "search_memory", { query: "when does alice ship?" });

    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(CortadelError);
  });

  it("leaves tool behaviour unchanged under throwOnError", async () => {
    // A tool failure is already surfaced — to the model, as `isError` — so it is
    // never swallowed, and `throwOnError` has nothing to change.
    const strict = CortadelMemory.fromClient(fake, { throwOnError: true });
    fake.addError = new CortadelError(422, "validation_error", "text is required");

    const result = await callTool(strict, "add_memories", { text: "Alice prefers dark mode." });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("validation_error");
  });
});
