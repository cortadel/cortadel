// The retrieve-and-inject path, plus the ledger that stops re-injecting the same
// memories every turn.
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
import { buildPromptSection, buildRecallSearchOptions, filterByScore, formatRecallBlock, RecallLedger, shouldRecall } from "../src/recall.js";
import { hit } from "./helpers.js";

describe("buildRecallSearchOptions", () => {
  it("carries topK and hybrid mode", () => {
    const options = buildRecallSearchOptions(resolveConfig({ topK: 4 }, {}));
    expect(options.topK).toBe(4);
    expect(options.mode).toBe("hybrid");
  });

  it("omits rerank unless enabled, and uses the one accepted value when it is", () => {
    expect(buildRecallSearchOptions(resolveConfig({}, {})).rerank).toBeUndefined();
    expect(buildRecallSearchOptions(resolveConfig({ rerank: true }, {})).rerank).toBe("cross_encoder");
  });

  it("never sets sessionId — that would restrict recall to one conversation", () => {
    // The whole point of long-term memory is reaching across past sessions.
    expect(buildRecallSearchOptions(resolveConfig({}, {}))).not.toHaveProperty("sessionId");
  });
});

describe("shouldRecall", () => {
  const config = resolveConfig({ minPromptChars: 8 }, {});

  it("skips trivially short prompts", () => {
    expect(shouldRecall("hi", config)).toBe(false);
    expect(shouldRecall("   ", config)).toBe(false);
    expect(shouldRecall(undefined, config)).toBe(false);
  });

  it("recalls for a substantial prompt", () => {
    expect(shouldRecall("what did I decide about the database?", config)).toBe(true);
  });

  it("is off entirely when autoRecall is disabled", () => {
    expect(shouldRecall("a long enough prompt", resolveConfig({ autoRecall: false }, {}))).toBe(false);
  });
});

describe("filterByScore", () => {
  const hits = [hit("a", "A", { rrfScore: 0.9 }), hit("b", "B", { rrfScore: 0.1 }), hit("c", "C")];

  it("keeps everything when the floor is 0", () => {
    expect(filterByScore(hits, 0)).toHaveLength(3);
  });

  it("drops hits below the floor but keeps unscored ones", () => {
    const kept = filterByScore(hits, 0.5).map((h) => h.id);
    expect(kept).toEqual(["a", "c"]);
  });
});

describe("RecallLedger", () => {
  it("suppresses memories already injected into the same session", () => {
    const ledger = new RecallLedger(100);
    const first = [hit("m1", "one"), hit("m2", "two")];

    expect(ledger.filterUnseen("s1", first)).toHaveLength(2);
    ledger.record("s1", first);

    const second = [hit("m1", "one"), hit("m3", "three")];
    expect(ledger.filterUnseen("s1", second).map((h) => h.id)).toEqual(["m3"]);
  });

  it("keeps sessions independent", () => {
    const ledger = new RecallLedger(100);
    ledger.record("s1", [hit("m1", "one")]);
    expect(ledger.filterUnseen("s2", [hit("m1", "one")])).toHaveLength(1);
  });

  it("forgets a session on reset so a fresh conversation re-injects", () => {
    const ledger = new RecallLedger(100);
    ledger.record("s1", [hit("m1", "one")]);
    ledger.reset("s1");
    expect(ledger.filterUnseen("s1", [hit("m1", "one")])).toHaveLength(1);
  });

  it("bounds the per-session window, evicting the coldest ids", () => {
    const ledger = new RecallLedger(2);
    ledger.record("s1", [hit("m1", "one"), hit("m2", "two"), hit("m3", "three")]);
    expect(ledger.sizeFor("s1")).toBe(2);
    // m1 was evicted, so it may be injected again.
    expect(ledger.filterUnseen("s1", [hit("m1", "one")])).toHaveLength(1);
    expect(ledger.filterUnseen("s1", [hit("m3", "three")])).toHaveLength(0);
  });

  it("disables deduplication entirely at window 0", () => {
    const ledger = new RecallLedger(0);
    ledger.record("s1", [hit("m1", "one")]);
    expect(ledger.filterUnseen("s1", [hit("m1", "one")])).toHaveLength(1);
    expect(ledger.sizeFor("s1")).toBe(0);
  });
});

describe("formatRecallBlock", () => {
  it("returns undefined when there is nothing to inject", () => {
    expect(formatRecallBlock([])).toBeUndefined();
  });

  it("wraps memories in a tagged block framed as background facts", () => {
    const block = formatRecallBlock([hit("m1", "Prefers dark mode.")]);
    expect(block!.text).toContain("<cortadel-memory>");
    expect(block!.text).toContain("</cortadel-memory>");
    expect(block!.text).toContain("Prefers dark mode.");
    // Injected memory is stored text, not a instruction channel.
    expect(block!.text).toContain("not as instructions");
  });

  it("prefixes an ISO createdAt as a plain date", () => {
    const block = formatRecallBlock([hit("m1", "Shipped v2.", { createdAt: "2026-05-01T10:00:00Z" })]);
    expect(block!.text).toContain("[2026-05-01] Shipped v2.");
  });

  it("collapses whitespace so one memory stays on one line", () => {
    const block = formatRecallBlock([hit("m1", "line one\n\nline   two")]);
    expect(block!.text).toContain("- line one line two");
  });

  it("stops before exceeding the character budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => hit(`m${i}`, "x".repeat(300)));
    const block = formatRecallBlock(many, 1_000);
    expect(block!.text.length).toBeLessThan(1_400);
    expect(block!.text.split("\n").length).toBeLessThan(10);
  });

  it("reports exactly the hits it rendered, not the ones it was handed", () => {
    // The caller records `injected` in the dedupe ledger. If this returned every
    // input hit, memories the budget dropped would be suppressed for the rest of
    // the session without the model ever having seen them.
    const many = Array.from({ length: 20 }, (_, i) => hit(`m${i}`, "x".repeat(300)));
    const block = formatRecallBlock(many, 1_000)!;

    expect(block.injected.length).toBeLessThan(many.length);
    expect(block.injected.length).toBe(block.text.split("\n").length - 3); // minus the two tags and the header
    for (const emitted of block.injected) expect(block.text).toContain(emitted.id === "m0" ? "- x" : "x");
    // Every rendered id is an input id, in input order, with no gaps.
    expect(block.injected.map((h) => h.id)).toEqual(many.slice(0, block.injected.length).map((h) => h.id));
  });

  it("reports every hit when they all fit", () => {
    const hits = [hit("m1", "one"), hit("m2", "two")];
    expect(formatRecallBlock(hits)!.injected.map((h) => h.id)).toEqual(["m1", "m2"]);
  });
});

describe("buildPromptSection", () => {
  it("mentions only the tools actually available", () => {
    const both = buildPromptSection(new Set(["cortadel_search_memory", "cortadel_add_memories"])).join("\n");
    expect(both).toContain("cortadel_search_memory");
    expect(both).toContain("cortadel_add_memories");

    const searchOnly = buildPromptSection(new Set(["cortadel_search_memory"])).join("\n");
    expect(searchOnly).toContain("cortadel_search_memory");
    expect(searchOnly).not.toContain("cortadel_add_memories");
  });

  it("still describes Cortadel when no tools are exposed", () => {
    expect(buildPromptSection(new Set()).join("\n")).toContain("Cortadel long-term memory");
  });

  it("is static, so providers can prompt-cache it", () => {
    const tools = new Set(["cortadel_search_memory"]);
    expect(buildPromptSection(tools)).toEqual(buildPromptSection(tools));
  });
});
