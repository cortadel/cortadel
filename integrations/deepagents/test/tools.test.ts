import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicStructuredTool } from "@langchain/core/tools";

import { ClientProvider, createCortadelTools } from "../src/index.js";
import { FakeCortadelClient, cortadelError, hit } from "./fakes.js";

/**
 * The shape LangChain's ToolNode hands a tool: the run config, spread, plus `config`/`toolCallId`/
 * `state` (`langchain/dist/agents/nodes/ToolNode.js`, `runTool`). Tests mirror it so the tools are
 * exercised the way the agent actually calls them.
 */
function runConfig(configurable: Record<string, unknown> = { user_id: "e2e-tools-user" }) {
  const config = { configurable };
  return { ...config, config, toolCallId: "call-1" };
}

function tools(options: Parameters<typeof createCortadelTools>[0]) {
  const [search, add] = createCortadelTools(options) as DynamicStructuredTool[];
  return { search: search!, add: add! };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("registration", () => {
  it("exposes the two canonical tools with usable schemas", () => {
    const { search, add } = tools({ client: new FakeCortadelClient() });

    expect(search.name).toBe("search_memory");
    expect(add.name).toBe("add_memories");
    expect(search.description).toContain("long-term memory");
    expect(add.description).toContain("Never record credentials");

    expect(Object.keys((search.schema as { shape: object }).shape)).toEqual(["query", "topK"]);
    expect(Object.keys((add.schema as { shape: object }).shape)).toEqual(["memories"]);
  });

  it("defaults topK to 10 — the SDK's own SearchOptions default", async () => {
    const client = new FakeCortadelClient();
    const { search } = tools({ client });
    await search.invoke({ query: "anything" }, runConfig());
    expect(client.searchCalls[0]!.options).toMatchObject({ topK: 10 });
  });
});

describe("search_memory", () => {
  it("renders hits with their recorded date", async () => {
    const client = new FakeCortadelClient();
    client.hits = [
      hit("m1", "The user prefers dark mode.", { createdAt: "2026-03-04T10:00:00Z" }),
      hit("m2", "The user ships on Fridays."),
    ];
    const { search } = tools({ client });

    const result = await search.invoke({ query: "preferences", topK: 2 }, runConfig());

    expect(result).toBe(
      'Memories for "preferences":\n' +
        "1. The user prefers dark mode. [recorded 2026-03-04]\n" +
        "2. The user ships on Fridays.",
    );
    expect(client.searchCalls[0]!.options).toMatchObject({ topK: 2, mode: "hybrid" });
  });

  it("says so plainly when there is nothing to find", async () => {
    const { search } = tools({ client: new FakeCortadelClient() });
    expect(await search.invoke({ query: "nothing" }, runConfig())).toBe(
      'No memories found for "nothing".',
    );
  });

  it("forwards rerank and memoryType", async () => {
    const client = new FakeCortadelClient();
    const { search } = tools({ client, rerank: true, memoryType: "procedural" });
    await search.invoke({ query: "q" }, runConfig());
    expect(client.searchCalls[0]!.options).toMatchObject({
      rerank: "cross_encoder",
      memoryType: "procedural",
    });
  });
});

describe("add_memories", () => {
  it("stores each fact and reports the pipeline event", async () => {
    const client = new FakeCortadelClient();
    const { add } = tools({ client });

    const result = await add.invoke(
      { memories: ["The user ships on Fridays.", "  ", "The user prefers dark mode."] },
      runConfig(),
    );

    expect(client.addCalls.map((call) => call.text)).toEqual([
      "The user ships on Fridays.",
      "The user prefers dark mode.",
    ]);
    expect(client.addCalls[0]!.options).toMatchObject({ app: "@cortadel/deepagents" });
    expect(result).toBe(
      "Recorded in Cortadel:\n" +
        "- ADD: The user ships on Fridays.\n" +
        "- ADD: The user prefers dark mode.",
    );
  });

  it("refuses an all-blank list without calling the server", async () => {
    const client = new FakeCortadelClient();
    const { add } = tools({ client });
    expect(await add.invoke({ memories: ["", "   "] }, runConfig())).toBe(
      "Nothing to remember: no non-empty memories were provided.",
    );
    expect(client.addCalls).toHaveLength(0);
  });

  it("tags writes with memoryType when configured", async () => {
    const client = new FakeCortadelClient();
    const { add } = tools({ client, memoryType: "semantic" });
    await add.invoke({ memories: ["a durable fact"] }, runConfig());
    expect(client.addCalls[0]!.options).toMatchObject({ memoryType: "semantic" });
  });
});

describe("degrading gracefully", () => {
  it("returns an explanatory string instead of aborting the turn", async () => {
    const client = new FakeCortadelClient();
    client.searchError = cortadelError();
    const { search } = tools({ client });

    expect(await search.invoke({ query: "q" }, runConfig())).toBe(
      "Cortadel memory is unavailable right now (http_error: server down). Continue without it.",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("search_memory failed"));
  });

  it("reports the failure to onError instead of warning", async () => {
    const client = new FakeCortadelClient();
    client.addError = cortadelError();
    const seen: unknown[] = [];
    const { add } = tools({ client, onError: (error) => seen.push(error) });

    await add.invoke({ memories: ["a fact"] }, runConfig());

    expect(seen).toEqual([client.addError]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws when throwOnError is set", async () => {
    const client = new FakeCortadelClient();
    client.searchError = cortadelError();
    const { search } = tools({ client, throwOnError: true });
    await expect(search.invoke({ query: "q" }, runConfig())).rejects.toBe(client.searchError);
  });

  it("tells the model memory is unconfigured when no user id can be resolved", async () => {
    const { search, add } = tools({ baseUrl: "http://localhost:3001" });
    expect(await search.invoke({ query: "q" }, runConfig({}))).toBe(
      "Cortadel memory is not configured for this run; continue without it.",
    );
    expect(await add.invoke({ memories: ["a fact"] }, runConfig({}))).toBe(
      "Cortadel memory is not configured for this run; nothing was recorded.",
    );
  });
});

describe("per-user scoping", () => {
  it("resolves a client per run from configurable.user_id", async () => {
    const built = new Map<string, FakeCortadelClient>();
    const { search } = tools({
      clientFactory: (userId) => {
        const client = new FakeCortadelClient(userId);
        built.set(userId, client);
        return client;
      },
    });

    await search.invoke({ query: "alice" }, runConfig({ user_id: "e2e-alice" }));
    await search.invoke({ query: "bob" }, runConfig({ user_id: "e2e-bob" }));

    expect([...built.keys()].sort()).toEqual(["e2e-alice", "e2e-bob"]);
    expect(built.get("e2e-alice")!.searchCalls[0]!.query).toBe("alice");
    expect(built.get("e2e-bob")!.searchCalls[0]!.query).toBe("bob");
  });

  it("shares one client cache when a provider is passed in", async () => {
    const built: string[] = [];
    const provider = new ClientProvider({
      clientFactory: (userId) => {
        built.push(userId);
        return new FakeCortadelClient(userId);
      },
    });
    const first = tools({ provider });
    const second = tools({ provider });

    await first.search.invoke({ query: "q" }, runConfig({ user_id: "e2e-shared" }));
    await second.add.invoke({ memories: ["a fact"] }, runConfig({ user_id: "e2e-shared" }));

    expect(built).toEqual(["e2e-shared"]);
  });
});
