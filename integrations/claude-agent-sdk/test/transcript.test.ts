/** Reading the last user→assistant exchange back off a session transcript. */

import { describe, expect, it } from "vitest";

import {
  lastExchange,
  pair,
  readJsonl,
  textOf,
  type TranscriptEntry,
  type TranscriptReaders,
} from "../src/transcript.js";
import { assistantEntry, userEntry, writeTranscript } from "./helpers.js";

const USER_TEXT = "Should we index on user_id or created_at?";
const ASSISTANT_TEXT = "Index on user_id — every read is namespace-anchored.";

function entry(
  type: string,
  message: unknown,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return { type, message, isHuman: true, ...extra };
}

describe("textOf", () => {
  it("reads a plain-string user turn", () => {
    expect(textOf({ role: "user", content: "  hello  " })).toBe("hello");
  });

  it("joins only the text blocks of an assistant turn", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "first" },
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "text", text: "second" },
      ],
    };

    expect(textOf(message)).toBe("first\nsecond");
  });

  it("returns empty for a tool-only turn", () => {
    expect(textOf({ role: "assistant", content: [{ type: "tool_use", id: "t1" }] })).toBe("");
    expect(textOf(undefined)).toBe("");
    expect(textOf(42)).toBe("");
  });
});

describe("pair", () => {
  it("takes the last assistant turn with text and the user turn before it", () => {
    const exchange = pair([
      entry("user", { content: "older question" }, { uuid: "u-0" }),
      entry("assistant", { content: [{ type: "text", text: "older answer" }] }, { uuid: "a-0" }),
      entry("user", { content: USER_TEXT }, { uuid: "u-1" }),
      entry("assistant", { content: [{ type: "text", text: ASSISTANT_TEXT }] }, { uuid: "a-1" }),
    ]);

    expect(exchange).toEqual({
      user: { role: "user", text: USER_TEXT, uuid: "u-1" },
      assistant: { role: "assistant", text: ASSISTANT_TEXT, uuid: "a-1" },
    });
  });

  it("skips a trailing tool-only assistant turn", () => {
    const exchange = pair([
      entry("user", { content: USER_TEXT }),
      entry("assistant", { content: [{ type: "text", text: ASSISTANT_TEXT }] }),
      entry("assistant", { content: [{ type: "tool_use", id: "t1" }] }),
    ]);

    expect(exchange?.assistant.text).toBe(ASSISTANT_TEXT);
  });

  it("prefers a human user turn over a machine-authored one", () => {
    const exchange = pair([
      entry("user", { content: USER_TEXT }, { uuid: "human" }),
      entry("user", { content: "task notification" }, { uuid: "machine", isHuman: false }),
      entry("assistant", { content: [{ type: "text", text: ASSISTANT_TEXT }] }),
    ]);

    expect(exchange?.user.uuid).toBe("human");
  });

  it("falls back to a machine turn when there is no human one", () => {
    const exchange = pair([
      entry("user", { content: "task notification" }, { uuid: "machine", isHuman: false }),
      entry("assistant", { content: [{ type: "text", text: ASSISTANT_TEXT }] }),
    ]);

    expect(exchange?.user.uuid).toBe("machine");
  });

  it("returns undefined without an assistant turn", () => {
    expect(pair([entry("user", { content: USER_TEXT })])).toBeUndefined();
  });

  it("returns undefined without a user turn", () => {
    expect(
      pair([entry("assistant", { content: [{ type: "text", text: ASSISTANT_TEXT }] })]),
    ).toBeUndefined();
  });
});

describe("readJsonl", () => {
  it("parses a transcript and keeps the uuids", async () => {
    const path = await writeTranscript([
      userEntry(USER_TEXT, { uuid: "u-9" }),
      assistantEntry(ASSISTANT_TEXT, { uuid: "a-9" }),
    ]);

    const entries = await readJsonl(path);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "user", uuid: "u-9", isHuman: true });
    expect(entries[1]).toMatchObject({ type: "assistant", uuid: "a-9" });
  });

  it("skips meta, sidechain and non-message lines", async () => {
    const path = await writeTranscript([
      { type: "summary", summary: "ignored" },
      userEntry("meta", { isMeta: true }),
      userEntry("sidechain", { isSidechain: true }),
      userEntry(USER_TEXT),
      assistantEntry(ASSISTANT_TEXT),
    ]);

    const entries = await readJsonl(path);

    expect(entries).toHaveLength(2);
  });

  it("marks a non-human origin as machine-authored", async () => {
    const path = await writeTranscript([userEntry(USER_TEXT, { origin: { kind: "task" } })]);

    expect((await readJsonl(path))[0]!.isHuman).toBe(false);
  });

  it("survives a malformed line and keeps the rest", async () => {
    const path = await writeTranscript([userEntry(USER_TEXT), assistantEntry(ASSISTANT_TEXT)]);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "{not json\n", "utf8");

    expect(await readJsonl(path)).toHaveLength(2);
  });

  it("returns nothing when there is no path", async () => {
    expect(await readJsonl(undefined)).toEqual([]);
  });
});

describe("lastExchange", () => {
  const goodEntries: TranscriptEntry[] = [
    entry("user", { content: USER_TEXT }, { uuid: "u-1" }),
    entry("assistant", { content: [{ type: "text", text: ASSISTANT_TEXT }] }, { uuid: "a-1" }),
  ];

  it("prefers the SDK reader and never touches the fallback", async () => {
    let jsonlCalls = 0;
    const readers: TranscriptReaders = {
      sdk: async () => goodEntries,
      jsonl: async () => {
        jsonlCalls += 1;
        return [];
      },
    };

    const exchange = await lastExchange({ sessionId: "e2e-session" }, readers);

    expect(exchange?.user.text).toBe(USER_TEXT);
    expect(jsonlCalls).toBe(0);
  });

  it("falls back to the JSONL reader when the SDK reader is empty", async () => {
    const readers: TranscriptReaders = { sdk: async () => [], jsonl: async () => goodEntries };

    expect((await lastExchange({ sessionId: "e2e-session" }, readers))?.assistant.text).toBe(
      ASSISTANT_TEXT,
    );
  });

  it("falls back when the SDK reader throws", async () => {
    const readers: TranscriptReaders = {
      sdk: async () => {
        throw new Error("no session store");
      },
      jsonl: async () => goodEntries,
    };

    expect(await lastExchange({ sessionId: "e2e-session" }, readers)).toBeDefined();
  });

  it("returns undefined rather than throwing when both readers fail", async () => {
    const boom = async () => {
      throw new Error("unreadable");
    };
    const readers: TranscriptReaders = { sdk: boom, jsonl: boom };

    expect(await lastExchange({ sessionId: "e2e-session" }, readers)).toBeUndefined();
  });

  it("works end to end against a real transcript file", async () => {
    // The default readers: a non-UUID session id makes the SDK reader come back
    // empty, so this drives the JSONL fallback for real.
    const transcriptPath = await writeTranscript([
      userEntry(USER_TEXT),
      assistantEntry(ASSISTANT_TEXT),
    ]);

    const exchange = await lastExchange({ sessionId: "e2e-session-not-a-uuid", transcriptPath });

    expect(exchange?.user.text).toBe(USER_TEXT);
    expect(exchange?.assistant.text).toBe(ASSISTANT_TEXT);
  });

  it("returns undefined for a missing transcript file", async () => {
    expect(
      await lastExchange({ sessionId: "e2e-session-not-a-uuid", transcriptPath: "/nope/none.jsonl" }),
    ).toBeUndefined();
  });
});
