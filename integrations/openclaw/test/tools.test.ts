// Tool registration shape and execution, including the degraded path.
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
import { CortadelGateway } from "../src/gateway.js";
import { createTools } from "../src/tools.js";
import type { TurnIdentity } from "../src/types.js";
import { cortadelError, FakeCortadelClient, hit, recordingLogger, searchResults, TEST_USER } from "./helpers.js";

function toolsWith(raw: Parameters<typeof resolveConfig>[0] = {}, identity: TurnIdentity = {}, client = new FakeCortadelClient()) {
  const config = resolveConfig({ userId: TEST_USER, ...raw }, {});
  const seen: string[] = [];
  const gateway = new CortadelGateway(
    config,
    (userId) => {
      seen.push(userId);
      return client;
    },
    recordingLogger(),
  );
  const tools = createTools(gateway, identity);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, byName, client, seen };
}

describe("tool registration shape", () => {
  it("registers exactly the two tools declared in contracts.tools", () => {
    const { tools } = toolsWith();
    expect(tools.map((t) => t.name)).toEqual(["cortadel_search_memory", "cortadel_add_memories"]);
  });

  it("every tool carries the fields AnyAgentTool requires", () => {
    for (const tool of toolsWith().tools) {
      expect(typeof tool.name).toBe("string");
      // `label` is required on AnyAgentTool and easy to forget.
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("declares a TypeBox object schema with the documented properties", () => {
    const { byName } = toolsWith();
    const search = byName.get("cortadel_search_memory")!.parameters as { properties: Record<string, unknown>; required?: string[] };
    // `topK`, matching Cortadel's own MCP `search_memory` argument — `limit`
    // means "browse page size" there, so it must not be reused for the cap.
    expect(Object.keys(search.properties).sort()).toEqual(["query", "topK"]);
    expect(search.required).toEqual(["query"]);

    const add = byName.get("cortadel_add_memories")!.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(add.properties).sort()).toEqual(["memory_type", "text"]);
    expect(add.required).toEqual(["text"]);
  });
});

describe("cortadel_search_memory", () => {
  it("returns matching memories as text plus structured details", async () => {
    const { byName, client } = toolsWith();
    client.searchResult = searchResults("db", [hit("m1", "Uses Postgres.", { rrfScore: 0.8 })]);

    const result = await byName.get("cortadel_search_memory")!.execute("call-1", { query: "db" });
    expect(result.content[0]!.text).toContain("Uses Postgres.");
    expect(result.details).toMatchObject({ ok: true, query: "db" });
    expect((result.details as { results: unknown[] }).results).toHaveLength(1);
  });

  it("says so plainly when nothing matched", async () => {
    const { byName } = toolsWith();
    const result = await byName.get("cortadel_search_memory")!.execute("call-1", { query: "nothing" });
    expect(result.content[0]!.text).toContain("No Cortadel memories matched");
    expect(result.details).toMatchObject({ ok: true });
  });

  it("throws on missing input, per the OpenClaw tool contract", async () => {
    const { byName } = toolsWith();
    await expect(byName.get("cortadel_search_memory")!.execute("c", {})).rejects.toThrow(/query/);
    await expect(byName.get("cortadel_search_memory")!.execute("c", { query: "  " })).rejects.toThrow(/query/);
  });

  it("reports an outage in-band so the model can answer without memory", async () => {
    const { byName, client } = toolsWith();
    client.failure = cortadelError(0, "transport_error", "connection refused");

    const result = await byName.get("cortadel_search_memory")!.execute("call-1", { query: "db" });
    expect(result.content[0]!.text).toContain("unavailable");
    expect(result.details).toMatchObject({ ok: false, reason: "error" });
  });

  it("clamps topK into Cortadel's 1-50 range", async () => {
    const { byName, client } = toolsWith();
    await byName.get("cortadel_search_memory")!.execute("c", { query: "q", topK: 500 });
    expect((client.searches[0]!.options as { topK: number }).topK).toBe(50);
  });

  it("falls back to the configured topK when the model omits the argument", async () => {
    const { byName, client } = toolsWith({ topK: 7 });
    await byName.get("cortadel_search_memory")!.execute("c", { query: "q" });
    expect((client.searches[0]!.options as { topK: number }).topK).toBe(7);
  });

  it("ignores a stray `limit` rather than treating it as the cap", async () => {
    // Guards the rename: `limit` is a different argument on Cortadel's MCP
    // surface, so a model that sends it must not silently change the cap.
    const { byName, client } = toolsWith({ topK: 5 });
    await byName.get("cortadel_search_memory")!.execute("c", { query: "q", limit: 42 });
    expect((client.searches[0]!.options as { topK: number }).topK).toBe(5);
  });

  it("uses the turn identity to pick the Cortadel namespace", async () => {
    const { byName, seen } = toolsWith({ recallScope: "sender" }, { senderId: "U_777" });
    await byName.get("cortadel_search_memory")!.execute("c", { query: "q" });
    expect(seen).toEqual([`${TEST_USER}:u_777`]);
  });
});

describe("cortadel_add_memories", () => {
  it("stores a fact and reports the pipeline event", async () => {
    const { byName, client } = toolsWith();
    const result = await byName.get("cortadel_add_memories")!.execute("c", { text: "Ships on Fridays." });

    expect(client.adds[0]!.text).toBe("Ships on Fridays.");
    expect(result.details).toMatchObject({ ok: true, id: "mem-new", event: "ADD" });
  });

  it("distinguishes a deduplicated write from a new one", async () => {
    // A 200 does not mean something new was written.
    const { byName, client } = toolsWith();
    client.addResult = { id: "mem-1", event: "SKIP_DUPLICATE" };
    const result = await byName.get("cortadel_add_memories")!.execute("c", { text: "Ships on Fridays." });
    expect(result.content[0]!.text).toContain("Already known");
  });

  it("tags the memory with the configured app name", async () => {
    const { byName, client } = toolsWith();
    await byName.get("cortadel_add_memories")!.execute("c", { text: "fact" });
    expect((client.adds[0]!.options as { app: string }).app).toBe("cortadel-openclaw");
  });

  it("passes a valid memory_type through and ignores an invalid one", async () => {
    const { byName, client } = toolsWith();
    await byName.get("cortadel_add_memories")!.execute("c", { text: "fact", memory_type: "semantic" });
    expect((client.adds[0]!.options as { memoryType?: string }).memoryType).toBe("semantic");

    await byName.get("cortadel_add_memories")!.execute("c", { text: "fact", memory_type: "nonsense" });
    expect((client.adds[1]!.options as { memoryType?: string }).memoryType).toBeUndefined();
  });

  it("throws on missing text", async () => {
    const { byName } = toolsWith();
    await expect(byName.get("cortadel_add_memories")!.execute("c", {})).rejects.toThrow(/text/);
  });

  it("reports a write failure without throwing into the agent", async () => {
    const { byName, client } = toolsWith();
    client.failure = cortadelError(401, "unauthorized", "bad key");
    const result = await byName.get("cortadel_add_memories")!.execute("c", { text: "fact" });
    expect(result.details).toMatchObject({ ok: false });
    expect(result.content[0]!.text).toContain("Could not save");
  });
});
