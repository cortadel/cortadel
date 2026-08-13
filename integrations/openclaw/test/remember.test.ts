// The persist-after-turn path.
import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
import { buildConversationOptions, buildTurnMessages, MAX_MESSAGE_CHARS, summarizeConversationResult } from "../src/remember.js";

describe("buildTurnMessages", () => {
  it("builds the user/assistant pair Cortadel extracts facts from", () => {
    expect(buildTurnMessages("I use Postgres.", ["Noted."])).toEqual([
      { role: "user", content: "I use Postgres." },
      { role: "assistant", content: "Noted." },
    ]);
  });

  it("joins a multi-part assistant reply", () => {
    const messages = buildTurnMessages("hello there", ["part one", "part two"]);
    expect(messages![1].content).toBe("part one\n\npart two");
  });

  it("drops half-turns rather than storing a fact with no context", () => {
    expect(buildTurnMessages(undefined, ["reply"])).toBeUndefined();
    expect(buildTurnMessages("   ", ["reply"])).toBeUndefined();
    expect(buildTurnMessages("prompt", [])).toBeUndefined();
    expect(buildTurnMessages("prompt", ["", "   "])).toBeUndefined();
  });

  it("truncates a pathologically long turn", () => {
    const messages = buildTurnMessages("x".repeat(MAX_MESSAGE_CHARS + 500), ["ok"]);
    expect(messages![0].content).toHaveLength(MAX_MESSAGE_CHARS);
    expect(messages![0].content.endsWith("…")).toBe(true);
  });
});

describe("buildConversationOptions", () => {
  it("scopes captured facts to the session, unlike recall", () => {
    // sessionId here groups the facts one conversation produced; on search it
    // would instead *restrict* what can be recalled.
    const options = buildConversationOptions(resolveConfig({}, {}), { sessionKey: "alpha:telegram:42" });
    expect(options.sessionId).toBe("alpha:telegram:42");
  });

  it("falls back to sessionId when no session key is present", () => {
    expect(buildConversationOptions(resolveConfig({}, {}), { sessionId: "uuid-1" }).sessionId).toBe("uuid-1");
  });

  it("extracts facts about the user, not the assistant", () => {
    expect(buildConversationOptions(resolveConfig({}, {}), {}).isAgentMemory).toBe(false);
  });

  it("carries tags and project when configured, and omits them when not", () => {
    const withScope = buildConversationOptions(resolveConfig({ tags: ["work"], project: "cortadel" }, {}), {});
    expect(withScope.tags).toEqual(["work"]);
    expect(withScope.project).toBe("cortadel");

    const bare = buildConversationOptions(resolveConfig({}, {}), {});
    expect(bare.tags).toBeUndefined();
    expect(bare.project).toBeUndefined();
  });
});

describe("summarizeConversationResult", () => {
  it("reports the no-facts branch", () => {
    expect(summarizeConversationResult({ noFactsExtracted: true })).toBe("no facts extracted");
  });

  it("handles a null results list without throwing", () => {
    // `results` and `noFactsExtracted` are mutually exclusive on the wire.
    expect(summarizeConversationResult({})).toBe("no facts extracted");
    expect(summarizeConversationResult({ results: [] })).toBe("no facts extracted");
  });

  it("counts pipeline events", () => {
    const summary = summarizeConversationResult({
      results: [{ id: "1", event: "ADD" }, { id: "2", event: "ADD" }, { id: "", event: "SKIP_DUPLICATE" }],
    });
    expect(summary).toContain("ADD=2");
    expect(summary).toContain("SKIP_DUPLICATE=1");
  });
});
