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

/**
 * Message types that name an inherited `Object.prototype` member.
 *
 * A message's `type` / `role` / `getType()` is data, not a vetted enum — it arrives from LangGraph
 * state, from a plain `{ role, content }` object a caller passed to `agent.invoke`, or from a tool
 * result. A plain-object role table answers `"constructor"` with `Object`, `"toString"` with a
 * function and `"__proto__"` with `Object.prototype`: all truthy, so an `if (!role) continue` guard
 * lets them through and a non-string role reaches Cortadel as a conversation role.
 */
const INHERITED_KEYS = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
];

describe("toChatMessages / inherited Object.prototype keys", () => {
  it.each(INHERITED_KEYS)('skips a message whose type is "%s"', (key) => {
    expect(toChatMessages([{ type: key, content: "poison" }])).toEqual([]);
    expect(toChatMessages([{ role: key, content: "poison" }])).toEqual([]);
    expect(toChatMessages([{ getType: () => key, content: "poison" }])).toEqual([]);
  });

  it("skips them exactly like any other unknown type", () => {
    const inherited = toChatMessages(INHERITED_KEYS.map((key) => ({ type: key, content: "x" })));
    const unknown = toChatMessages([
      { type: "system", content: "x" },
      { type: "tool", content: "x" },
      { type: "nonsense", content: "x" },
    ]);
    expect(inherited).toEqual(unknown);
    expect(inherited).toEqual([]);
  });

  it("never emits a role that is not a string", () => {
    for (const key of INHERITED_KEYS) {
      for (const role of toChatMessages([{ type: key, content: "poison" }]).map((m) => m.role)) {
        expect(typeof role).toBe("string");
      }
    }
  });

  it("drops them from a transcript without disturbing the real dialogue", () => {
    const converted = toChatMessages([
      new HumanMessage("remember I ship on Fridays"),
      { type: "constructor", content: "poison" },
      { role: "toString", content: "poison" },
      new AIMessage("Noted."),
    ]);

    expect(converted).toEqual([
      { role: "user", content: "remember I ship on Fridays" },
      { role: "assistant", content: "Noted." },
    ]);
  });

  it("still reports the type verbatim — the guard belongs at the role mapping", () => {
    // `messageType` is a reporter, not a filter: narrowing it here would mask, rather than fix,
    // the lookup that actually mishandles these strings.
    expect(messageType({ type: "constructor", content: "x" })).toBe("constructor");
    expect(messageType({ role: "toString", content: "x" })).toBe("toString");
  });
});
