// Cortadel as an additive OpenClaw memory corpus — the mapping OpenClaw's own
// memory_search / memory_get see.
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
import { createCorpusSupplement, memoryPath, parseLookup, toCorpusGetResult, toCorpusSearchResult } from "../src/corpus.js";
import { CortadelGateway } from "../src/gateway.js";
import { cortadelError, detail, FakeCortadelClient, hit, recordingLogger, searchResults, TEST_USER } from "./helpers.js";

function supplementWith(raw: Parameters<typeof resolveConfig>[0] = {}, client = new FakeCortadelClient()) {
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
  return { supplement: createCorpusSupplement(gateway), client, seen };
}

describe("path round-trip", () => {
  it("emits an addressable path and parses it back", () => {
    expect(memoryPath("mem-1")).toBe("cortadel://mem-1");
    expect(parseLookup(memoryPath("mem-1"))).toBe("mem-1");
  });

  it("also accepts a bare id, for when the model uses the id field", () => {
    expect(parseLookup("mem-1")).toBe("mem-1");
    expect(parseLookup("  mem-1  ")).toBe("mem-1");
  });

  it("rejects empty lookups", () => {
    expect(parseLookup("")).toBeUndefined();
    expect(parseLookup("   ")).toBeUndefined();
    expect(parseLookup("cortadel://")).toBeUndefined();
  });
});

describe("toCorpusSearchResult", () => {
  it("maps a hit onto the corpus row shape", () => {
    const row = toCorpusSearchResult(
      hit("mem-1", "Alice prefers dark mode.", {
        rrfScore: 0.42,
        createdAt: "2026-05-01T10:00:00Z",
        memoryType: "semantic",
        appName: "telegram",
        gist: "Prefers dark mode",
      }),
    );

    expect(row).toMatchObject({
      corpus: "cortadel",
      path: "cortadel://mem-1",
      id: "mem-1",
      score: 0.42,
      snippet: "Alice prefers dark mode.",
      title: "Prefers dark mode",
      kind: "semantic",
      sourcePath: "telegram",
      sourceType: "cortadel",
      provenanceLabel: "Cortadel",
      // SearchHit.createdAt is already an ISO string on this schema.
      updatedAt: "2026-05-01T10:00:00Z",
    });
  });

  it("ranks an unscored hit last rather than dropping it", () => {
    expect(toCorpusSearchResult(hit("m", "text")).score).toBe(0);
  });

  it("falls back to the content head when there is no gist", () => {
    expect(toCorpusSearchResult(hit("m", "A memory with no gist.")).title).toBe("A memory with no gist.");
  });

  it("marks a globally shared memory in its provenance", () => {
    expect(toCorpusSearchResult(hit("m", "t", { isGlobal: true })).provenanceLabel).toBe("Cortadel (shared)");
  });
});

describe("toCorpusGetResult", () => {
  it("reads the detail schema's `text` field, not `content`", () => {
    const result = toCorpusGetResult(detail("mem-1", "line1\nline2\nline3"));
    expect(result.content).toBe("line1\nline2\nline3");
    expect(result.fromLine).toBe(1);
    expect(result.lineCount).toBe(3);
    expect(result.path).toBe("cortadel://mem-1");
  });

  it("converts the detail schema's Unix-seconds createdAt to ISO", () => {
    // MemoryDetail.createdAt is seconds; SearchHit.createdAt is an ISO string.
    expect(toCorpusGetResult(detail("mem-1", "x")).updatedAt).toBe(new Date(1_767_225_600 * 1000).toISOString());
  });

  it("honours 1-based line paging", () => {
    const result = toCorpusGetResult(detail("mem-1", "a\nb\nc\nd\ne"), 2, 2);
    expect(result.content).toBe("b\nc");
    expect(result.fromLine).toBe(2);
    expect(result.lineCount).toBe(2);
  });

  it("clamps paging past the end instead of throwing", () => {
    const result = toCorpusGetResult(detail("mem-1", "a\nb"), 99, 5);
    expect(result.content).toBe("");
    expect(result.lineCount).toBe(0);
  });
});

describe("corpus supplement", () => {
  it("searches Cortadel and returns corpus rows", async () => {
    const { supplement, client } = supplementWith();
    client.searchResult = searchResults("dark mode", [hit("m1", "Prefers dark mode.", { rrfScore: 0.9 })]);

    const rows = await supplement.search({ query: "dark mode" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.corpus).toBe("cortadel");
    expect(client.searches[0]!.query).toBe("dark mode");
  });

  it("does not restrict a corpus lookup to one session", async () => {
    const { supplement, client } = supplementWith();
    await supplement.search({ query: "anything", agentSessionKey: "alpha:telegram:42" });
    expect(client.searches[0]!.options).not.toHaveProperty("sessionId");
  });

  it("scopes the lookup to the user id the session resolves to", async () => {
    const { supplement, seen } = supplementWith({ recallScope: "session" });
    await supplement.search({ query: "anything", agentSessionKey: "alpha:telegram:42" });
    expect(seen).toEqual([`${TEST_USER}:alpha-telegram-42`]);
  });

  it("honours maxResults within Cortadel's 1-50 range", async () => {
    const { supplement, client } = supplementWith();
    await supplement.search({ query: "q", maxResults: 999 });
    expect((client.searches[0]!.options as { topK: number }).topK).toBe(50);
  });

  it("returns no rows for an empty query, without calling out", async () => {
    const { supplement, client } = supplementWith();
    expect(await supplement.search({ query: "   " })).toEqual([]);
    expect(client.searches).toHaveLength(0);
  });

  it("degrades to local-only results when Cortadel is down", async () => {
    // memory_search must keep working on its built-in corpus.
    const { supplement, client } = supplementWith();
    client.failure = cortadelError(0, "transport_error", "connection refused");
    await expect(supplement.search({ query: "anything" })).resolves.toEqual([]);
  });

  it("reads one memory back by path", async () => {
    const { supplement, client } = supplementWith();
    client.getResult = detail("m1", "Prefers dark mode.");
    const result = await supplement.get({ lookup: "cortadel://m1" });
    expect(result?.content).toBe("Prefers dark mode.");
    expect(client.gets).toEqual(["m1"]);
  });

  it("returns null for an unknown id, which the SDK reports as null rather than throwing", async () => {
    const { supplement } = supplementWith();
    await expect(supplement.get({ lookup: "cortadel://missing" })).resolves.toBeNull();
  });

  it("returns null for an unusable lookup without calling out", async () => {
    const { supplement, client } = supplementWith();
    await expect(supplement.get({ lookup: "" })).resolves.toBeNull();
    expect(client.gets).toHaveLength(0);
  });

  it("returns null instead of throwing when Cortadel is down", async () => {
    const { supplement, client } = supplementWith();
    client.failure = cortadelError(500, "http_error", "boom");
    await expect(supplement.get({ lookup: "cortadel://m1" })).resolves.toBeNull();
  });
});
