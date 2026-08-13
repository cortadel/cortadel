import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { latestUserText, messageText, messageType, toChatMessages } from "../src/index.js";

describe("messageType", () => {
  it("reads LangChain message types", () => {
    expect(messageType(new HumanMessage("hi"))).toBe("human");
    expect(messageType(new AIMessage("hi"))).toBe("ai");
    expect(messageType(new SystemMessage("hi"))).toBe("system");
  });

  it("maps plain role objects onto LangChain types", () => {
    expect(messageType({ role: "user", content: "hi" })).toBe("human");
    expect(messageType({ role: "assistant", content: "hi" })).toBe("ai");
    expect(messageType({ role: "tool", content: "hi" })).toBe("tool");
    expect(messageType(undefined)).toBeUndefined();
  });
});

describe("messageText", () => {
  it("reads the text getter", () => {
    expect(messageText(new HumanMessage("  hello  "))).toBe("hello");
  });

  it("uses LangChain's own text getter for a content-block message", () => {
    // LangChain 1.x concatenates the text blocks itself, with no separator.
    expect(
      messageText(
        new HumanMessage({
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: "https://example.invalid/a.png" } },
            { type: "text", text: "second" },
          ],
        }),
      ),
    ).toBe("firstsecond");
  });

  it("flattens content blocks itself when there is no text getter", () => {
    // A plain `{ role, content }` object handed straight to `agent.invoke({ messages })` has no
    // getter, so the block walk is what keeps it from persisting as "".
    expect(
      messageText({
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image_url", image_url: { url: "https://example.invalid/a.png" } },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
  });

  it("reads a plain object's content", () => {
    expect(messageText({ role: "user", content: "plain" })).toBe("plain");
    expect(messageText({ role: "user", content: 7 })).toBe("");
  });
});

describe("latestUserText", () => {
  it("returns the most recent human message", () => {
    expect(
      latestUserText([
        new HumanMessage("first"),
        new AIMessage("answer"),
        new HumanMessage("second"),
      ]),
    ).toBe("second");
  });

  it("skips empty human messages and returns undefined when there is none", () => {
    expect(latestUserText([new HumanMessage("real"), new HumanMessage("   ")])).toBe("real");
    expect(latestUserText([new AIMessage("only ai")])).toBeUndefined();
    expect(latestUserText(undefined)).toBeUndefined();
  });
});

describe("toChatMessages", () => {
  it("keeps the human/assistant dialogue and drops harness traffic", () => {
    const converted = toChatMessages([
      new SystemMessage("a multi-kilobyte harness prompt"),
      new HumanMessage("remember I ship on Fridays"),
      new AIMessage({ content: "", tool_calls: [{ id: "1", name: "ls", args: {} }] }),
      new ToolMessage({ content: "a.txt", tool_call_id: "1" }),
      new AIMessage("Noted."),
    ]);

    expect(converted).toEqual([
      { role: "user", content: "remember I ship on Fridays" },
      { role: "assistant", content: "Noted." },
    ]);
  });

  it("carries the message id through as the Cortadel uuid anchor", () => {
    const converted = toChatMessages([new HumanMessage({ id: "msg-1", content: "hello" })]);
    expect(converted).toEqual([{ role: "user", content: "hello", uuid: "msg-1" }]);
  });

  it("returns nothing for an empty or all-harness slice", () => {
    expect(toChatMessages([])).toEqual([]);
    expect(toChatMessages([new SystemMessage("only system")])).toEqual([]);
  });
});
