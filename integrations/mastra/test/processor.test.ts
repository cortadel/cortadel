import { CortadelError } from "@cortadel/sdk";
import { MessageList } from "@mastra/core/agent/message-list";
import type { CoreMessageV4, MastraDBMessage } from "@mastra/core/agent/message-list";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { ProcessInputArgs, ProcessOutputResultArgs } from "@mastra/core/processors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CortadelMemoryProcessor, DEFAULT_MEMORY_HEADER } from "../src/index.js";
import type { CortadelErrorContext } from "../src/index.js";
import { fakeClientFactory, gate, hit } from "./fake-client.js";

interface Turn {
  userText: string;
  /** `null` means "explicitly no thread" — see the scoping test that relies on it. */
  threadId?: string | null;
  resourceId?: string;
  systemMessages?: CoreMessageV4[];
  requestContext?: RequestContext;
}

/**
 * Build a real Mastra MessageList for one user turn.
 *
 * A `MessageList` only stamps `resourceId` onto its messages when it also has a
 * `threadId` (its `memoryInfo` is `{ threadId, resourceId? }`), which is how
 * real callers use it: `agent.generate(text, { memory: { resource, thread } })`.
 * So a turn with a resource gets a thread unless the test says otherwise.
 */
function messageListFor(turn: Turn): MessageList {
  const threadId = turn.threadId === null ? undefined : (turn.threadId ?? (turn.resourceId ? "t-default" : undefined));
  const list = new MessageList({
    ...(threadId ? { threadId } : {}),
    ...(turn.resourceId ? { resourceId: turn.resourceId } : {}),
  });
  if (turn.userText) list.add({ role: "user", content: turn.userText }, "input");
  return list;
}

function inputArgs(turn: Turn): ProcessInputArgs {
  const messageList = messageListFor(turn);
  return {
    messages: messageList.get.all.db(),
    messageList,
    systemMessages: turn.systemMessages ?? [],
    state: {},
    retryCount: 0,
    abort: () => {
      throw new Error("abort() must not be called by the memory processor");
    },
    ...(turn.requestContext ? { requestContext: turn.requestContext } : {}),
  } as unknown as ProcessInputArgs;
}

function outputArgs(turn: Turn, assistantText: string): ProcessOutputResultArgs {
  const messageList = messageListFor(turn);
  return {
    messages: messageList.get.all.db(),
    messageList,
    state: {},
    retryCount: 0,
    result: { text: assistantText, usage: {}, finishReason: "stop", steps: [] },
    abort: () => {
      throw new Error("abort() must not be called by the memory processor");
    },
    ...(turn.requestContext ? { requestContext: turn.requestContext } : {}),
  } as unknown as ProcessOutputResultArgs;
}

function injectedSystemText(result: unknown): string | undefined {
  const systemMessages = (result as { systemMessages?: CoreMessageV4[] }).systemMessages;
  const last = systemMessages?.at(-1);
  return typeof last?.content === "string" ? last.content : undefined;
}

const ALICE = "e2e-mastra-alice";

/** Let every already-queued microtask and macrotask callback run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("processInput — recall and inject", () => {
  let factory: ReturnType<typeof fakeClientFactory>;

  beforeEach(() => {
    factory = fakeClientFactory();
  });

  it("searches with the latest user message and appends one system message", async () => {
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    factory.createClient(ALICE);
    factory.for(ALICE).hits = [hit("m1", "Alice deploys only on Tuesdays")];

    const result = await processor.processInput(
      inputArgs({ userText: "What did I say about deploys?", resourceId: ALICE, threadId: "thread-1" }),
    );

    expect(factory.for(ALICE).searchCalls[0]).toMatchObject({
      query: "What did I say about deploys?",
      options: { topK: 5, mode: "hybrid" },
    });
    const injected = injectedSystemText(result);
    expect(injected).toContain(DEFAULT_MEMORY_HEADER);
    expect(injected).toContain("- Alice deploys only on Tuesdays");
  });

  it("preserves system messages that were already there", async () => {
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    factory.createClient(ALICE);
    factory.for(ALICE).hits = [hit("m1", "A memory")];

    const result = (await processor.processInput(
      inputArgs({
        userText: "hello there",
        resourceId: ALICE,
        systemMessages: [{ role: "system", content: "You are terse." }],
      }),
    )) as { systemMessages: CoreMessageV4[] };

    expect(result.systemMessages).toHaveLength(2);
    expect(result.systemMessages[0]!.content).toBe("You are terse.");
  });

  it("leaves the turn untouched when nothing is recalled", async () => {
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    const args = inputArgs({ userText: "hello there", resourceId: ALICE });

    const result = await processor.processInput(args);

    expect(result).toBe(args.messages);
  });

  it("does not search on a trivially short message", async () => {
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    const args = inputArgs({ userText: "ok", resourceId: ALICE });

    expect(await processor.processInput(args)).toBe(args.messages);
    expect(factory.requested).toEqual([]);
  });

  it("can be configured recall-off", async () => {
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, recall: false });
    const args = inputArgs({ userText: "What did I say about deploys?", resourceId: ALICE });

    expect(await processor.processInput(args)).toBe(args.messages);
    expect(factory.requested).toEqual([]);
  });

  it("passes rerank, memoryType and topK through to the search", async () => {
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      topK: 3,
      rerank: true,
      memoryType: "semantic",
      searchMode: "text",
    });

    await processor.processInput(inputArgs({ userText: "anything at all", resourceId: ALICE }));

    expect(factory.for(ALICE).searchCalls[0]!.options).toEqual({
      topK: 3,
      mode: "text",
      rerank: "cross_encoder",
      memoryType: "semantic",
    });
  });

  it("does not scope recall to the thread — long-term memory spans conversations", async () => {
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });

    await processor.processInput(inputArgs({ userText: "anything at all", resourceId: ALICE, threadId: "t-1" }));

    expect(factory.for(ALICE).searchCalls[0]!.options).not.toHaveProperty("sessionId");
  });

  it("scopes recall to the thread when scopeRecallToSession is set", async () => {
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      scopeRecallToSession: true,
    });

    await processor.processInput(inputArgs({ userText: "anything at all", resourceId: ALICE, threadId: "t-1" }));

    expect(factory.for(ALICE).searchCalls[0]!.options).toMatchObject({ sessionId: "t-1" });
  });

  it("omits the session filter when scoping is on but the run has no thread", async () => {
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      scopeRecallToSession: true,
      userId: ALICE,
    });

    await processor.processInput(inputArgs({ userText: "anything at all", threadId: null }));

    expect(factory.for(ALICE).searchCalls[0]!.options).not.toHaveProperty("sessionId");
  });
});

describe("processInput — not re-injecting the same memories", () => {
  it("injects a memory once per thread, then stops", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    factory.createClient(ALICE);
    factory.for(ALICE).hits = [hit("m1", "Alice deploys only on Tuesdays")];

    const first = await processor.processInput(
      inputArgs({ userText: "first question here", resourceId: ALICE, threadId: "t-1" }),
    );
    const second = await processor.processInput(
      inputArgs({ userText: "second question here", resourceId: ALICE, threadId: "t-1" }),
    );

    expect(injectedSystemText(first)).toContain("Alice deploys only on Tuesdays");
    expect(injectedSystemText(second)).toBeUndefined();
  });

  it("still injects a memory that is new to a different thread", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    factory.createClient(ALICE);
    factory.for(ALICE).hits = [hit("m1", "Alice deploys only on Tuesdays")];

    await processor.processInput(inputArgs({ userText: "first question here", resourceId: ALICE, threadId: "t-1" }));
    const other = await processor.processInput(
      inputArgs({ userText: "first question here", resourceId: ALICE, threadId: "t-2" }),
    );

    expect(injectedSystemText(other)).toContain("Alice deploys only on Tuesdays");
  });

  it("only filters the memories already seen, keeping the new ones", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    factory.createClient(ALICE);
    factory.for(ALICE).hits = [hit("m1", "Old memory")];
    await processor.processInput(inputArgs({ userText: "first question here", resourceId: ALICE, threadId: "t-1" }));

    factory.for(ALICE).hits = [hit("m1", "Old memory"), hit("m2", "New memory")];
    const second = await processor.processInput(
      inputArgs({ userText: "second question here", resourceId: ALICE, threadId: "t-1" }),
    );

    const injected = injectedSystemText(second);
    expect(injected).toContain("New memory");
    expect(injected).not.toContain("Old memory");
  });

  it("can be turned off", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      dedupeAcrossTurns: false,
    });
    factory.createClient(ALICE);
    factory.for(ALICE).hits = [hit("m1", "Alice deploys only on Tuesdays")];

    await processor.processInput(inputArgs({ userText: "first question here", resourceId: ALICE, threadId: "t-1" }));
    const second = await processor.processInput(
      inputArgs({ userText: "second question here", resourceId: ALICE, threadId: "t-1" }),
    );

    expect(injectedSystemText(second)).toContain("Alice deploys only on Tuesdays");
  });
});

describe("processOutputResult — persist the finished turn", () => {
  it("writes the user and assistant turn with the thread as the Cortadel session", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      project: "cortadel",
      tags: ["mastra"],
    });

    const args = outputArgs(
      { userText: "I only deploy on Tuesdays.", resourceId: ALICE, threadId: "t-1" },
      "Noted — Tuesdays only.",
    );
    const result = await processor.processOutputResult(args);

    expect(result).toBe(args.messages);
    expect(factory.for(ALICE).conversationCalls).toEqual([
      {
        messages: [
          { role: "user", content: "I only deploy on Tuesdays." },
          { role: "assistant", content: "Noted — Tuesdays only." },
        ],
        options: { sessionId: "t-1", project: "cortadel", tags: ["mastra"] },
      },
    ]);
  });

  it("skips an identical repeat of the turn it just wrote", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    const turn: Turn = { userText: "I only deploy on Tuesdays.", resourceId: ALICE, threadId: "t-1" };

    await processor.processOutputResult(outputArgs(turn, "Noted."));
    await processor.processOutputResult(outputArgs(turn, "Noted."));

    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);
  });

  it("writes the user turn alone when the model produced no text", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });

    await processor.processOutputResult(
      outputArgs({ userText: "I only deploy on Tuesdays.", resourceId: ALICE }, ""),
    );

    expect(factory.for(ALICE).conversationCalls[0]!.messages).toEqual([
      { role: "user", content: "I only deploy on Tuesdays." },
    ]);
  });

  it("writes nothing when there is no text at all", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });

    await processor.processOutputResult(outputArgs({ userText: "", resourceId: ALICE }, ""));

    expect(factory.requested).toEqual([]);
  });

  it("can be configured persist-off", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, persist: false });

    await processor.processOutputResult(outputArgs({ userText: "A fact.", resourceId: ALICE }, "Noted."));

    expect(factory.requested).toEqual([]);
  });

  it("marks the conversation as agent memory when asked", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      isAgentMemory: true,
    });

    await processor.processOutputResult(outputArgs({ userText: "A fact.", resourceId: ALICE }, "Noted."));

    expect(factory.for(ALICE).conversationCalls[0]!.options).toMatchObject({ isAgentMemory: true });
  });
});

describe("the duplicate-turn latch — a lost write must stay retryable", () => {
  const TURN: Turn = { userText: "I only deploy on Tuesdays.", resourceId: ALICE, threadId: "t-1" };

  it("re-attempts an identical turn after an awaited persist failed", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, onError });
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new CortadelError(500, "http_error", "boom");

    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);
    expect(onError).toHaveBeenCalledOnce();

    // The caller retries the same turn. It must be written, not mistaken for a
    // duplicate of the write that never landed.
    factory.for(ALICE).conversationError = undefined;
    await processor.processOutputResult(outputArgs(TURN, "Noted."));

    expect(factory.for(ALICE).conversationCalls).toHaveLength(2);
  });

  it("re-attempts an identical turn after the retry throwOnError invited", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      throwOnError: true,
      onError: () => {},
    });
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new CortadelError(500, "http_error", "boom");

    await expect(processor.processOutputResult(outputArgs(TURN, "Noted."))).rejects.toThrow("boom");

    factory.for(ALICE).conversationError = undefined;
    await expect(processor.processOutputResult(outputArgs(TURN, "Noted."))).resolves.toBeDefined();

    expect(factory.for(ALICE).conversationCalls).toHaveLength(2);
  });

  it("still skips an identical turn once the persist has actually succeeded", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });

    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await processor.processOutputResult(outputArgs(TURN, "Noted."));

    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);
  });

  it("stops re-attempting once the retry lands", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      onError: () => {},
    });
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new Error("down");

    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    factory.for(ALICE).conversationError = undefined;
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await processor.processOutputResult(outputArgs(TURN, "Noted."));

    // Failed, retried, then deduped again — not a write per repeat.
    expect(factory.for(ALICE).conversationCalls).toHaveLength(2);
  });

  it("joins the write already in flight instead of issuing a second one", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    factory.createClient(ALICE);
    const held = gate();
    factory.for(ALICE).conversationGate = held.promise;

    const first = processor.processOutputResult(outputArgs(TURN, "Noted."));
    const second = processor.processOutputResult(outputArgs(TURN, "Noted."));
    await tick();
    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);

    held.open();
    await Promise.all([first, second]);

    // Both callers awaited the one write, and neither returned before it landed.
    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);
  });

  it("tells both callers of a joined write that it failed, and stays retryable", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, onError });
    factory.createClient(ALICE);
    const held = gate();
    factory.for(ALICE).conversationGate = held.promise;
    factory.for(ALICE).conversationError = new Error("down");

    const first = processor.processOutputResult(outputArgs(TURN, "Noted."));
    const second = processor.processOutputResult(outputArgs(TURN, "Noted."));
    held.open();
    await Promise.all([first, second]);

    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1]![1]).toMatchObject({ operation: "persist" });

    factory.for(ALICE).conversationGate = undefined;
    factory.for(ALICE).conversationError = undefined;
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    expect(factory.for(ALICE).conversationCalls).toHaveLength(2);
  });

  it("does not let one turn's failure clear a newer turn's latch", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      awaitPersist: false,
      onError: () => {},
    });
    factory.createClient(ALICE);
    const held = gate();
    factory.for(ALICE).conversationGate = held.promise;

    // Turn A goes out and hangs.
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    // Turn B — same thread, different text — goes out behind it and succeeds.
    factory.for(ALICE).conversationGate = undefined;
    await processor.processOutputResult(outputArgs({ ...TURN, userText: "And never on a Friday." }, "Noted."));
    await tick();

    // Now A fails. Its latch is already gone from the map, replaced by B's.
    factory.for(ALICE).conversationError = new Error("down");
    held.open();
    await tick();

    // B is still latched…
    await processor.processOutputResult(outputArgs({ ...TURN, userText: "And never on a Friday." }, "Noted."));
    expect(factory.for(ALICE).conversationCalls).toHaveLength(2);

    // …and A, which failed, is retryable.
    factory.for(ALICE).conversationError = undefined;
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    expect(factory.for(ALICE).conversationCalls).toHaveLength(3);
  });
});

describe("the duplicate-turn latch — fire-and-forget semantics", () => {
  const TURN: Turn = { userText: "I only deploy on Tuesdays.", resourceId: ALICE, threadId: "t-1" };

  function fireAndForget(factory: ReturnType<typeof fakeClientFactory>): CortadelMemoryProcessor {
    return new CortadelMemoryProcessor({
      createClient: factory.createClient,
      awaitPersist: false,
      onError: () => {},
    });
  }

  it("skips an identical turn once the write has landed", async () => {
    const factory = fakeClientFactory();
    const processor = fireAndForget(factory);

    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await tick();
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await tick();

    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);
  });

  it("re-attempts an identical turn after the write failed", async () => {
    const factory = fakeClientFactory();
    const processor = fireAndForget(factory);
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new Error("down");

    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await tick();
    factory.for(ALICE).conversationError = undefined;
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await tick();

    expect(factory.for(ALICE).conversationCalls).toHaveLength(2);
  });

  it("drops an identical turn that arrives while the write is still in flight", async () => {
    const factory = fakeClientFactory();
    const processor = fireAndForget(factory);
    factory.createClient(ALICE);
    const held = gate();
    factory.for(ALICE).conversationGate = held.promise;

    // No caller is waiting on the first write, so a repeat cannot join it — the
    // deliberate trade is to drop the repeat rather than double-write.
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    await processor.processOutputResult(outputArgs(TURN, "Noted."));
    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);

    held.open();
    await tick();
    expect(factory.for(ALICE).conversationCalls).toHaveLength(1);
  });

  it("re-attempts at most once per turn — a failure is not a retry loop", async () => {
    const factory = fakeClientFactory();
    const processor = fireAndForget(factory);
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new Error("down");

    for (let i = 0; i < 4; i += 1) {
      await processor.processOutputResult(outputArgs(TURN, "Noted."));
      await tick();
    }

    // One attempt per call, never more: releasing the latch re-opens the turn,
    // it does not schedule anything of its own.
    expect(factory.for(ALICE).conversationCalls).toHaveLength(4);
  });
});

describe("user-id scoping", () => {
  it("uses one client per Mastra resourceId", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });

    await processor.processInput(inputArgs({ userText: "a question here", resourceId: "e2e-mastra-alice" }));
    await processor.processInput(inputArgs({ userText: "a question here", resourceId: "e2e-mastra-bob" }));

    expect(factory.requested).toEqual(["e2e-mastra-alice", "e2e-mastra-bob"]);
  });

  it("lets a pinned userId override the resourceId", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      userId: "e2e-mastra-pinned",
    });

    await processor.processInput(inputArgs({ userText: "a question here", resourceId: "e2e-mastra-alice" }));

    expect(factory.requested).toEqual(["e2e-mastra-pinned"]);
  });

  it("lets resolveUserId namespace a tenant", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      resolveUserId: (scope) => (scope.resourceId ? `e2e-mastra-acme:${scope.resourceId}` : undefined),
    });

    await processor.processInput(inputArgs({ userText: "a question here", resourceId: "e2e-alice" }));

    expect(factory.requested).toEqual(["e2e-mastra-acme:e2e-alice"]);
  });

  it("cannot see a resourceId that arrived without a thread — pin userId for that case", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, onError: () => {} });

    // Mastra only propagates resourceId onto messages alongside a threadId, so
    // a thread-less run has nothing to scope to. This is the documented reason
    // single-shot scripts must pass `userId`.
    await processor.processInput(
      inputArgs({ userText: "a question here", resourceId: "e2e-mastra-alice", threadId: null }),
    );
    expect(factory.requested).toEqual([]);

    const pinned = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      userId: "e2e-mastra-alice",
    });
    await pinned.processInput(
      inputArgs({ userText: "a question here", resourceId: "e2e-mastra-alice", threadId: null }),
    );
    expect(factory.requested).toEqual(["e2e-mastra-alice"]);
  });

  it("picks the resourceId up from the request context", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "e2e-mastra-from-context");

    await processor.processInput(inputArgs({ userText: "a question here", requestContext }));

    expect(factory.requested).toEqual(["e2e-mastra-from-context"]);
  });

  it("does nothing but warn once when no user id can be resolved", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn<(error: unknown, context: CortadelErrorContext) => void>();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, onError });

    const args = inputArgs({ userText: "a question here" });
    expect(await processor.processInput(args)).toBe(args.messages);
    await processor.processInput(inputArgs({ userText: "another question here" }));

    expect(factory.requested).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![1]).toMatchObject({ operation: "resolve-user-id" });
  });
});

describe("graceful degradation", () => {
  it("a failed recall leaves the turn exactly as it was", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn<(error: unknown, context: CortadelErrorContext) => void>();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, onError });
    factory.createClient(ALICE);
    factory.for(ALICE).searchError = new CortadelError(0, "transport_error", "connect ECONNREFUSED");

    const args = inputArgs({ userText: "a question here", resourceId: ALICE, threadId: "t-1" });
    const result = await processor.processInput(args);

    expect(result).toBe(args.messages);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(CortadelError);
    expect(onError.mock.calls[0]![1]).toEqual({ operation: "recall", userId: ALICE, threadId: "t-1" });
  });

  it("a failed persist never throws into the agent", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn<(error: unknown, context: CortadelErrorContext) => void>();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, onError });
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new CortadelError(500, "http_error", "boom");

    const args = outputArgs({ userText: "A fact.", resourceId: ALICE }, "Noted.");
    const result = await processor.processOutputResult(args);

    expect(result).toBe(args.messages);
    expect(onError.mock.calls[0]![1]).toMatchObject({ operation: "persist" });
  });

  it("an exploding onError handler cannot break the run either", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      onError: () => {
        throw new Error("the reporter itself is broken");
      },
    });
    factory.createClient(ALICE);
    factory.for(ALICE).searchError = new Error("down");

    const args = inputArgs({ userText: "a question here", resourceId: ALICE });
    await expect(processor.processInput(args)).resolves.toBe(args.messages);
  });

  it("fire-and-forget persist resolves immediately and swallows its failure", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      awaitPersist: false,
      onError,
    });
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new Error("down");

    await expect(
      processor.processOutputResult(outputArgs({ userText: "A fact.", resourceId: ALICE }, "Noted.")),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledOnce();
  });

  it("passes an abort signal so a slow memory server cannot stall the turn", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, recallTimeoutMs: 25 });

    await processor.processInput(inputArgs({ userText: "a question here", resourceId: ALICE }));

    expect(factory.for(ALICE).searchCalls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits the signal entirely when the timeout is disabled", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient, recallTimeoutMs: 0 });

    await processor.processInput(inputArgs({ userText: "a question here", resourceId: ALICE }));

    expect(factory.for(ALICE).searchCalls[0]!.signal).toBeUndefined();
  });
});

describe("throwOnError — memory as a hard dependency", () => {
  it("rethrows a failed recall after reporting it", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn<(error: unknown, context: CortadelErrorContext) => void>();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      throwOnError: true,
      onError,
    });
    factory.createClient(ALICE);
    factory.for(ALICE).searchError = new CortadelError(0, "transport_error", "connect ECONNREFUSED");

    await expect(
      processor.processInput(inputArgs({ userText: "a question here", resourceId: ALICE })),
    ).rejects.toThrow("connect ECONNREFUSED");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("rethrows a failed persist while it is awaited", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      throwOnError: true,
      onError: () => {},
    });
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new CortadelError(500, "http_error", "boom");

    await expect(
      processor.processOutputResult(outputArgs({ userText: "A fact.", resourceId: ALICE }, "Noted.")),
    ).rejects.toThrow("boom");
  });

  it("cannot rethrow a fire-and-forget persist — onError stays the only signal", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      throwOnError: true,
      awaitPersist: false,
      onError,
    });
    factory.createClient(ALICE);
    factory.for(ALICE).conversationError = new Error("down");

    await expect(
      processor.processOutputResult(outputArgs({ userText: "A fact.", resourceId: ALICE }, "Noted.")),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps throwing on a missing user id after the warn-once has fired", async () => {
    const factory = fakeClientFactory();
    const onError = vi.fn();
    const processor = new CortadelMemoryProcessor({
      createClient: factory.createClient,
      throwOnError: true,
      onError,
    });

    await expect(processor.processInput(inputArgs({ userText: "a question here" }))).rejects.toThrow(
      /no Cortadel user id/,
    );
    await expect(processor.processInput(inputArgs({ userText: "another question here" }))).rejects.toThrow(
      /no Cortadel user id/,
    );
    // Reported once, thrown every time.
    expect(onError).toHaveBeenCalledOnce();
    expect(factory.requested).toEqual([]);
  });
});

describe("processor identity", () => {
  it("has a stable default id and an overridable one", () => {
    expect(new CortadelMemoryProcessor().id).toBe("cortadel-memory");
    expect(new CortadelMemoryProcessor({ id: "my-memory" }).id).toBe("my-memory");
  });

  it("returns MastraDBMessage[] from processOutputResult", async () => {
    const factory = fakeClientFactory();
    const processor = new CortadelMemoryProcessor({ createClient: factory.createClient });
    const args = outputArgs({ userText: "A fact.", resourceId: ALICE }, "Noted.");

    const result: MastraDBMessage[] = await processor.processOutputResult(args);

    expect(Array.isArray(result)).toBe(true);
  });
});
