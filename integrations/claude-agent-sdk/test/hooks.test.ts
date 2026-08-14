/** The automatic-memory hooks: retrieve-and-inject on UserPromptSubmit, persist on Stop. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { CortadelError } from "@cortadel/sdk";

import { CortadelMemory } from "../src/index.js";
import {
  BASE_URL,
  FakeCortadel,
  GatedCortadel,
  HangingCortadel,
  SESSION_ID,
  USER_ID,
  assistantEntry,
  hit,
  hookContext,
  promptInput,
  stopInput,
  userEntry,
  writeTranscript,
} from "./helpers.js";

const LONG_USER = "Should we index the memory table on user_id or on created_at for this workload?";
const LONG_ASSISTANT =
  "Index on user_id first — every read is namespace-anchored, so it is the selective column.";

/** `additionalContext` lives under `hookSpecificOutput`; a top-level key is ignored. */
function additionalContext(output: HookJSONOutput): string | undefined {
  const specific = (output as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput;
  return specific?.additionalContext;
}

function transcriptOf(user = LONG_USER, assistant = LONG_ASSISTANT): Promise<string> {
  return writeTranscript([userEntry(user), assistantEntry(assistant)]);
}

let fake: FakeCortadel;
let memory: CortadelMemory;

beforeEach(() => {
  fake = new FakeCortadel();
  fake.searchResults = [hit("mem-a", "Alice ships on Fridays.")];
  memory = CortadelMemory.fromClient(fake);
});

describe("UserPromptSubmit: retrieve and inject", () => {
  it("injects memories as hookSpecificOutput.additionalContext", async () => {
    const output = await memory.onUserPromptSubmit(
      promptInput("when does alice ship?"),
      undefined,
      hookContext(),
    );

    const specific = (output as { hookSpecificOutput?: { hookEventName?: string } })
      .hookSpecificOutput;
    expect(specific?.hookEventName).toBe("UserPromptSubmit");
    expect(additionalContext(output)).toMatch(/^## Relevant Cortadel memories\n/);
    expect(additionalContext(output)).toContain("[id mem-a] Alice ships on Fridays.");
    expect((output as { suppressOutput?: boolean }).suppressOutput).toBe(true);
  });

  it("searches with the submitted prompt", async () => {
    await memory.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());

    expect(fake.searches[0]![0]).toBe("when does alice ship?");
  });

  it("does not restrict recall to the current session", async () => {
    // The whole point of long-term memory is recalling across sessions, so
    // sessionId is not a search filter here even though the hook knows it.
    await memory.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());

    expect(fake.searches[0]![1]?.sessionId).toBeUndefined();
  });

  it("filters recall by the hook session id under scopeRecallToSession", async () => {
    const scoped = CortadelMemory.fromClient(fake, { scopeRecallToSession: true });

    await scoped.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());

    expect(fake.searches[0]![1]?.sessionId).toBe(SESSION_ID);
  });

  it("passes an abort signal down to the client", async () => {
    await memory.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());

    expect(fake.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("skips prompts below the minimum length", async () => {
    expect(await memory.onUserPromptSubmit(promptInput("hi"), undefined, hookContext())).toEqual({});
    expect(fake.searches).toEqual([]);
  });

  it.each(["/compact the session", "!git status --porcelain"])(
    "skips %s",
    async (prompt) => {
      expect(await memory.onUserPromptSubmit(promptInput(prompt), undefined, hookContext())).toEqual(
        {},
      );
      expect(fake.searches).toEqual([]);
    },
  );

  it("injects nothing when there are no hits", async () => {
    const empty = CortadelMemory.fromClient(new FakeCortadel());

    expect(
      await empty.onUserPromptSubmit(promptInput("anything at all"), undefined, hookContext()),
    ).toEqual({});
  });
});

describe("UserPromptSubmit: not re-injecting the same memories every turn", () => {
  it("does not re-inject a memory within a session", async () => {
    const first = await memory.onUserPromptSubmit(
      promptInput("when does alice ship?"),
      undefined,
      hookContext(),
    );
    const second = await memory.onUserPromptSubmit(
      promptInput("and what about deploys?"),
      undefined,
      hookContext(),
    );

    expect(additionalContext(first)).toContain("mem-a");
    expect(second).toEqual({});
  });

  it("injects only the memories not yet seen", async () => {
    await memory.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());
    fake.searchResults = [
      hit("mem-a", "Alice ships on Fridays."),
      hit("mem-b", "Alice prefers dark mode."),
    ];

    const second = await memory.onUserPromptSubmit(
      promptInput("and what about deploys?"),
      undefined,
      hookContext(),
    );

    expect(additionalContext(second)).toContain("mem-b");
    expect(additionalContext(second)).not.toContain("mem-a");
  });

  it("scopes dedupe to one session", async () => {
    await memory.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());

    const other = await memory.onUserPromptSubmit(
      promptInput("when does alice ship?", "e2e-other-session"),
      undefined,
      hookContext(),
    );

    expect(additionalContext(other)).toContain("mem-a");
  });

  it("can turn dedupe off", async () => {
    const noisy = CortadelMemory.fromClient(fake, { dedupeInjections: false });

    await noisy.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());
    const second = await noisy.onUserPromptSubmit(
      promptInput("and what about deploys?"),
      undefined,
      hookContext(),
    );

    expect(additionalContext(second)).toContain("mem-a");
  });

  it("respects the character budget, and only marks what it actually injected", async () => {
    fake.searchResults = Array.from({ length: 20 }, (_, index) => hit(`mem-${index}`, "x".repeat(250)));
    const budgeted = CortadelMemory.fromClient(fake, { topK: 20, maxContextChars: 600 });

    const first = await budgeted.onUserPromptSubmit(
      promptInput("anything at all"),
      undefined,
      hookContext(),
    );
    const second = await budgeted.onUserPromptSubmit(
      promptInput("something else entirely"),
      undefined,
      hookContext(),
    );

    expect(additionalContext(first)!.length).toBeLessThan(800);
    // Budget-dropped hits were never shown, so they must still be injectable.
    expect(additionalContext(second)).toBeTruthy();
  });
});

describe("UserPromptSubmit: graceful degradation", () => {
  it("lets the prompt through when the server is dead", async () => {
    fake.searchError = new CortadelError(0, "transport_error", "connection refused");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      await memory.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext()),
    ).toEqual({});
    warn.mockRestore();
  });

  it("lets the prompt through when recall times out", async () => {
    const hanging = CortadelMemory.fromClient(new HangingCortadel(), { recallTimeoutMs: 10 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      await hanging.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext()),
    ).toEqual({});
    expect(warn.mock.calls.flat().join(" ")).toContain("timed out");
    warn.mockRestore();
  });
});

describe("Stop: persist the turn", () => {
  it("persists the last exchange, uuids included", async () => {
    const transcript = await writeTranscript([
      userEntry(LONG_USER, { uuid: "u-7" }),
      assistantEntry(LONG_ASSISTANT, { uuid: "a-7" }),
    ]);

    expect(await memory.onStop(stopInput(transcript), undefined, hookContext())).toEqual({});

    const [messages, options] = fake.conversations[0]!;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]).toMatchObject({ content: LONG_USER, uuid: "u-7" });
    expect(messages[1]).toMatchObject({ content: LONG_ASSISTANT, uuid: "a-7" });
    expect(options).toBeDefined();
  });

  it("scopes the capture by session, project and transcript", async () => {
    const transcript = await transcriptOf();

    await memory.onStop(stopInput(transcript), undefined, hookContext());

    const options = fake.conversations[0]![1]!;
    expect(options.sessionId).toBe(SESSION_ID);
    expect(options.project).toBe("demo-project"); // basename of cwd
    expect(options.transcriptPath).toBe(transcript);
    expect(options.tags).toEqual(["claude-agent-sdk"]);
    expect(options.isAgentMemory).toBe(false);
  });

  it("lets an explicit project override the cwd basename", async () => {
    const scoped = CortadelMemory.fromClient(fake, { project: "cortadel" });

    await scoped.onStop(stopInput(await transcriptOf()), undefined, hookContext());

    expect(fake.conversations[0]![1]?.project).toBe("cortadel");
  });

  it("passes agent-memory mode through", async () => {
    const agent = CortadelMemory.fromClient(fake, { isAgentMemory: true });

    await agent.onStop(stopInput(await transcriptOf()), undefined, hookContext());

    expect(fake.conversations[0]![1]?.isAgentMemory).toBe(true);
  });

  it("guards against recursion via stop_hook_active", async () => {
    const transcript = await transcriptOf();

    await memory.onStop(stopInput(transcript, { stop_hook_active: true }), undefined, hookContext());

    expect(fake.conversations).toEqual([]);
  });

  it("skips a trivial exchange", async () => {
    const transcript = await writeTranscript([userEntry("ok"), assistantEntry("done")]);

    await memory.onStop(stopInput(transcript), undefined, hookContext());

    expect(fake.conversations).toEqual([]);
  });

  it("skips a session with no readable transcript", async () => {
    await memory.onStop(stopInput("/nope/missing.jsonl"), undefined, hookContext());

    expect(fake.conversations).toEqual([]);
  });

  it("truncates an oversized exchange", async () => {
    const big = CortadelMemory.fromClient(fake, { captureMaxChars: 8000 });
    const transcript = await writeTranscript([
      userEntry("u".repeat(20_000)),
      assistantEntry("a".repeat(20_000)),
    ]);

    await big.onStop(stopInput(transcript), undefined, hookContext());

    const [messages] = fake.conversations[0]!;
    expect(messages[0]!.content).toHaveLength(4000);
    expect(messages[1]!.content).toHaveLength(4000);
  });

  it("does not break the turn when the server is dead", async () => {
    fake.conversationError = new CortadelError(0, "transport_error", "connection refused");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await memory.onStop(stopInput(await transcriptOf()), undefined, hookContext())).toEqual({});
    warn.mockRestore();
  });

  it("falls back to last_assistant_message plus the recorded prompt", async () => {
    // No transcript on disk at all: the SDK reader returns [] for this
    // non-UUID session and the JSONL path does not exist.
    await memory.onUserPromptSubmit(promptInput(LONG_USER), undefined, hookContext());

    await memory.onStop(
      stopInput("/nope/missing.jsonl", { last_assistant_message: LONG_ASSISTANT }),
      undefined,
      hookContext(),
    );

    const [messages] = fake.conversations[0]!;
    expect(messages[0]!.content).toBe(LONG_USER);
    expect(messages[1]!.content).toBe(LONG_ASSISTANT);
    expect(messages[0]!.uuid).toBeUndefined(); // no transcript, so no pointer anchor
  });

  it("does not fall back without a recorded prompt for that session", async () => {
    await memory.onStop(
      stopInput("/nope/missing.jsonl", { last_assistant_message: LONG_ASSISTANT }),
      undefined,
      hookContext(),
    );

    expect(fake.conversations).toEqual([]);
  });

  it("reads through injected transcript readers, for a remote session store", async () => {
    const custom = CortadelMemory.fromClient(fake);
    custom.transcriptReaders = {
      sdk: async () => [
        { type: "user", message: { content: LONG_USER }, uuid: "u-remote", isHuman: true },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: LONG_ASSISTANT }] },
          uuid: "a-remote",
          isHuman: true,
        },
      ],
      jsonl: async () => [],
    };

    await custom.onStop(stopInput("/nope/missing.jsonl"), undefined, hookContext());

    expect(fake.conversations[0]![0][0]).toMatchObject({ content: LONG_USER, uuid: "u-remote" });
  });

  it("prefers the transcript, so pointer anchors survive", async () => {
    await memory.onUserPromptSubmit(promptInput(LONG_USER), undefined, hookContext());
    const transcript = await writeTranscript([
      userEntry(LONG_USER, { uuid: "u-7" }),
      assistantEntry(LONG_ASSISTANT, { uuid: "a-7" }),
    ]);

    await memory.onStop(
      stopInput(transcript, { last_assistant_message: "something else" }),
      undefined,
      hookContext(),
    );

    expect(fake.conversations[0]![0][1]).toMatchObject({ content: LONG_ASSISTANT, uuid: "a-7" });
  });
});

describe("awaitPersist: whether the write blocks the end of the turn", () => {
  it("awaits the capture by default", async () => {
    await memory.onStop(stopInput(await transcriptOf()), undefined, hookContext());

    expect(fake.conversations).toHaveLength(1);
  });

  it("returns before the write lands when fire-and-forget", async () => {
    const gated = new GatedCortadel();
    const background = CortadelMemory.fromClient(gated, { awaitPersist: false });

    expect(await background.onStop(stopInput(await transcriptOf()), undefined, hookContext())).toEqual(
      {},
    );
    expect(gated.conversations).toEqual([]); // still in flight

    gated.release();
    await background.flush(); // flush() drains what is still pending

    expect(gated.conversations).toHaveLength(1);
  });

  it("routes a background capture failure to onError", async () => {
    const gated = new GatedCortadel();
    gated.conversationError = new CortadelError(0, "transport_error", "connection refused");
    const seen: unknown[] = [];
    const background = CortadelMemory.fromClient(gated, {
      awaitPersist: false,
      onError: (error) => seen.push(error),
    });

    await background.onStop(stopInput(await transcriptOf()), undefined, hookContext());
    gated.release();
    await background.flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(CortadelError);
  });

  it("cannot apply throwOnError to a background write", async () => {
    // The hook that started it returned long ago, so there is nowhere to throw into.
    const gated = new GatedCortadel();
    gated.conversationError = new CortadelError(0, "transport_error", "connection refused");
    const background = CortadelMemory.fromClient(gated, { awaitPersist: false, throwOnError: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await background.onStop(stopInput(await transcriptOf()), undefined, hookContext())).toEqual(
      {},
    );
    gated.release();
    await expect(background.flush()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("throwOnError and onError", () => {
  it("observes a swallowed recall failure", async () => {
    fake.searchError = new CortadelError(0, "transport_error", "connection refused");
    const seen: unknown[] = [];
    const observed = CortadelMemory.fromClient(fake, { onError: (error) => seen.push(error) });

    expect(
      await observed.onUserPromptSubmit(
        promptInput("when does alice ship?"),
        undefined,
        hookContext(),
      ),
    ).toEqual({});
    expect(seen[0]).toBeInstanceOf(CortadelError);
  });

  it("observes a swallowed capture failure", async () => {
    fake.conversationError = new CortadelError(0, "transport_error", "connection refused");
    const seen: unknown[] = [];
    const observed = CortadelMemory.fromClient(fake, { onError: (error) => seen.push(error) });

    expect(await observed.onStop(stopInput(await transcriptOf()), undefined, hookContext())).toEqual(
      {},
    );
    expect(seen[0]).toBeInstanceOf(CortadelError);
  });

  it("warns when a failure is swallowed and there is no callback", async () => {
    fake.searchError = new CortadelError(0, "transport_error", "connection refused");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await memory.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext());

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("recall failed");
    expect(logged).toContain("connection refused");
    warn.mockRestore();
  });

  it("propagates a recall failure under throwOnError", async () => {
    fake.searchError = new CortadelError(0, "transport_error", "connection refused");
    const strict = CortadelMemory.fromClient(fake, { throwOnError: true });

    await expect(
      strict.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext()),
    ).rejects.toBeInstanceOf(CortadelError);
  });

  it("propagates a capture failure under throwOnError", async () => {
    fake.conversationError = new CortadelError(0, "transport_error", "connection refused");
    const strict = CortadelMemory.fromClient(fake, { throwOnError: true });

    await expect(
      strict.onStop(stopInput(await transcriptOf()), undefined, hookContext()),
    ).rejects.toBeInstanceOf(CortadelError);
  });

  it("still fires onError when the failure is rethrown", async () => {
    fake.searchError = new CortadelError(0, "transport_error", "connection refused");
    const seen: unknown[] = [];
    const strict = CortadelMemory.fromClient(fake, {
      throwOnError: true,
      onError: (error) => seen.push(error),
    });

    await expect(
      strict.onUserPromptSubmit(promptInput("when does alice ship?"), undefined, hookContext()),
    ).rejects.toBeInstanceOf(CortadelError);
    expect(seen).toHaveLength(1);
  });

  it("cannot let a throwing onError callback break the turn", async () => {
    fake.searchError = new CortadelError(0, "transport_error", "connection refused");
    const exploding = CortadelMemory.fromClient(fake, {
      onError: () => {
        throw new Error("observer exploded");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const output = await exploding.onUserPromptSubmit(
      promptInput("when does alice ship?"),
      undefined,
      hookContext(),
    );

    expect(output).toEqual({});
    expect(warn.mock.calls.flat().join(" ")).toContain("onError callback threw");
    warn.mockRestore();
  });
});

describe("user scoping and configuration", () => {
  it("binds the user id at construction, not per call", () => {
    // No Cortadel method takes a user id, so per-user scoping means one memory
    // object per user. `CortadelMemory` therefore takes it once, up front.
    const scoped = new CortadelMemory({ baseUrl: BASE_URL, userId: USER_ID });

    expect(scoped.allowedTools).toEqual(memory.allowedTools);
    expect(fake.searches).toEqual([]);
  });

  it("fails loudly on a bad configuration", () => {
    // Everything else fails open, so misconfiguration must not: it would be invisible.
    expect(() => new CortadelMemory({ baseUrl: BASE_URL, userId: "" })).toThrow(/userId/i);
    expect(() => new CortadelMemory({ baseUrl: "not a url", userId: USER_ID })).toThrow(/baseUrl/i);
  });

  it("omits the project when the session has no cwd", async () => {
    const transcript = await transcriptOf();

    await memory.onStop(stopInput(transcript, { cwd: "" }), undefined, hookContext());

    expect(fake.conversations[0]![1]?.project).toBeUndefined();
  });
});
