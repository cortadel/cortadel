import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_HEADER,
  extractMessageText,
  formatMemoryBlock,
  latestTextByRole,
} from "../src/index.js";
import { hit } from "./fake-client.js";

describe("extractMessageText", () => {
  it("joins the text parts of a MastraMessageContentV2 body", () => {
    const message = {
      role: "user",
      content: {
        format: 2,
        parts: [{ type: "step-start" }, { type: "text", text: "ship on " }, { type: "text", text: "Fridays" }],
      },
    };
    expect(extractMessageText(message)).toBe("ship on \nFridays");
  });

  it("ignores non-text parts", () => {
    const message = {
      role: "assistant",
      content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: {} }] },
    };
    expect(extractMessageText(message)).toBe("");
  });

  it("falls back to the legacy content string", () => {
    const message = { role: "user", content: { format: 2, parts: [], content: "  legacy  " } };
    expect(extractMessageText(message)).toBe("legacy");
  });

  it("accepts a plain string body", () => {
    expect(extractMessageText({ role: "user", content: "hi" })).toBe("hi");
  });

  it("never throws on junk", () => {
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText(42)).toBe("");
    expect(extractMessageText({ role: "user" })).toBe("");
  });
});

describe("latestTextByRole", () => {
  const messages = [
    { role: "user", content: { format: 2, parts: [{ type: "text", text: "first" }] } },
    { role: "assistant", content: { format: 2, parts: [{ type: "text", text: "reply" }] } },
    { role: "user", content: { format: 2, parts: [{ type: "text", text: "second" }] } },
  ];

  it("returns the newest matching message", () => {
    expect(latestTextByRole(messages, "user")).toBe("second");
    expect(latestTextByRole(messages, "assistant")).toBe("reply");
  });

  it("returns an empty string when no message matches", () => {
    expect(latestTextByRole(messages, "system")).toBe("");
    expect(latestTextByRole(undefined, "user")).toBe("");
  });
});

describe("formatMemoryBlock", () => {
  it("renders one bullet per hit under the default header", () => {
    const block = formatMemoryBlock([hit("a", "Prefers dark mode"), hit("b", "Ships on Fridays")]);
    expect(block.startsWith(DEFAULT_MEMORY_HEADER)).toBe(true);
    expect(block).toContain("- Prefers dark mode");
    expect(block).toContain("- Ships on Fridays");
  });

  it("prefers the server-computed gist over the raw content", () => {
    const block = formatMemoryBlock([hit("a", "long raw text", { gist: "short gist" })]);
    expect(block).toContain("- short gist");
    expect(block).not.toContain("long raw text");
  });

  it("appends the ISO timestamp when the hit carries one", () => {
    const block = formatMemoryBlock([hit("a", "Prefers dark mode", { createdAt: "2026-01-02T03:04:05Z" })]);
    expect(block).toContain("(recorded 2026-01-02T03:04:05Z)");
  });

  it("honours a custom header", () => {
    expect(formatMemoryBlock([hit("a", "x")], "CUSTOM")).toBe("CUSTOM\n\n- x");
  });

  it("returns an empty string when there is nothing worth injecting", () => {
    expect(formatMemoryBlock([])).toBe("");
    expect(formatMemoryBlock([hit("a", "   ")])).toBe("");
  });
});
