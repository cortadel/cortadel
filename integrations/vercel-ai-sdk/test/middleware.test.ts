import { describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { cortadelMemory } from "../src/index.js";
import {
  FakeCortadelClient,
  TEST_USER,
  hit,
  textResult,
  textStreamResult,
  toolCallResult,
} from "./harness.js";

/** Wraps a mock model with the memory middleware, exactly as a user would. */
function build(fake: FakeCortadelClient, options: Record<string, unknown> = {}) {
  const model = new MockLanguageModelV4({ doGenerate: textResult("ok"), ...(options.mock ?? {}) });
  const wrapped = wrapLanguageModel({
    model,
    middleware: cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      ...options,
    }),
  });
  return { model, wrapped };
}

describe("recall — searching and injecting", () => {
  it("injects recalled memories as a system message ahead of the conversation", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [
      hit({ id: "m1", content: "Prefers metric units.", createdAt: "2026-03-04T10:00:00Z" }),
      hit({ id: "m2", content: "Works in the Europe/Kyiv timezone." }),
    ];
    const { model, wrapped } = build(fake);

    await generateText({ model: wrapped, prompt: "What units should you use?" });

    // The query is the latest user message.
    expect(fake.searchCalls).toHaveLength(1);
    expect(fake.searchCalls[0]?.query).toBe("What units should you use?");

    // The model really received the injected block (asserted on what reached the model,
    // not on the middleware's return value).
    const sent = model.doGenerateCalls[0]!;
    expect(sent.prompt[0]?.role).toBe("system");
    const injected = sent.prompt[0]?.content as string;
    expect(injected).toContain("Prefers metric units.");
    expect(injected).toContain("Works in the Europe/Kyiv timezone.");
    // Dated, because Cortadel is a bi-temporal store and recency decides ties.
    expect(injected).toContain("(2026-03-04)");
    expect(sent.prompt[1]?.role).toBe("user");
  });

  it("keeps the caller's own system prompt in first position", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [hit({ id: "m1", content: "Prefers metric units." })];
    const { model, wrapped } = build(fake);

    await generateText({
      model: wrapped,
      system: "You are terse.",
      prompt: "What units should you use?",
    });

    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(prompt[0]).toEqual({ role: "system", content: "You are terse." });
    expect(prompt[1]?.role).toBe("system");
    expect(prompt[1]?.content).toContain("Prefers metric units.");
    expect(prompt[2]?.role).toBe("user");
  });

  it("leaves the prompt untouched when nothing is recalled", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [];
    const { model, wrapped } = build(fake);

    await generateText({ model: wrapped, prompt: "Hello" });

    expect(fake.searchCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]!.prompt.every((m) => m.role !== "system")).toBe(true);
  });

  it("passes the configured search options through to Cortadel", async () => {
    const fake = new FakeCortadelClient();
    const { wrapped } = build(fake, {
      topK: 3,
      mode: "vector",
      rerank: "cross_encoder",
      memoryType: "semantic",
      sessionId: "session-7",
    });

    await generateText({ model: wrapped, prompt: "Hello" });

    expect(fake.searchCalls[0]?.options).toEqual({
      topK: 3,
      mode: "vector",
      rerank: "cross_encoder",
      memoryType: "semantic",
      sessionId: "session-7",
    });
  });

  it("injects five memories by default", async () => {
    // Automatic injection pays for every hit in every prompt, so the default is deliberately
    // tighter than the SDK's own search default of 10.
    const fake = new FakeCortadelClient();
    const { wrapped } = build(fake);

    await generateText({ model: wrapped, prompt: "Hello" });

    expect(fake.searchCalls[0]?.options?.topK).toBe(5);
  });

  it("drops hits below minScore", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [
      hit({ id: "m1", content: "Strong hit.", rrfScore: 0.9 }),
      hit({ id: "m2", content: "Weak hit.", rrfScore: 0.1 }),
    ];
    const { model, wrapped } = build(fake, { minScore: 0.5 });

    await generateText({ model: wrapped, prompt: "Hello" });

    const injected = model.doGenerateCalls[0]!.prompt[0]?.content as string;
    expect(injected).toContain("Strong hit.");
    expect(injected).not.toContain("Weak hit.");
  });

  it("honours a custom formatter", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [hit({ id: "m1", content: "A fact." })];
    const { model, wrapped } = build(fake, {
      formatMemories: (hits: Array<{ content: string }>, ctx: { userId: string }) =>
        `KNOWN(${ctx.userId}): ${hits.map((h) => h.content).join(" | ")}`,
    });

    await generateText({ model: wrapped, prompt: "Hello" });

    expect(model.doGenerateCalls[0]!.prompt[0]?.content).toBe(
      `KNOWN(${TEST_USER}): A fact.`,
    );
  });
});

describe("persistence — storing the finished turn", () => {
  it("hands the completed exchange to addConversation", async () => {
    const fake = new FakeCortadelClient();
    const { wrapped } = build(fake, {
      mock: { doGenerate: textResult("Metric, always.") },
      sessionId: "session-7",
      tags: ["chat"],
      project: "demo",
    });

    await generateText({ model: wrapped, prompt: "What units should you use?" });

    expect(fake.conversationCalls).toHaveLength(1);
    expect(fake.conversationCalls[0]?.messages).toEqual([
      { role: "user", content: "What units should you use?" },
      { role: "assistant", content: "Metric, always." },
    ]);
    expect(fake.conversationCalls[0]?.options).toEqual({
      sessionId: "session-7",
      isAgentMemory: undefined,
      tags: ["chat"],
      project: "demo",
    });
  });

  it("persists a streamed turn once the stream completes", async () => {
    const fake = new FakeCortadelClient();
    const model = new MockLanguageModelV4({ doStream: textStreamResult("Streamed reply.") });
    const wrapped = wrapLanguageModel({
      model,
      middleware: cortadelMemory({ client: fake, userId: TEST_USER, awaitPersist: true }),
    });

    const result = streamText({ model: wrapped, prompt: "Say something." });

    let seen = "";
    for await (const chunk of result.textStream) {
      seen += chunk;
    }
    await result.consumeStream();

    // The stream is passed through untouched.
    expect(seen).toBe("Streamed reply.");
    expect(fake.conversationCalls).toHaveLength(1);
    expect(fake.conversationCalls[0]?.messages).toEqual([
      { role: "user", content: "Say something." },
      { role: "assistant", content: "Streamed reply." },
    ]);
  });

  it("does not persist a turn that is still mid tool-call, and searches once per turn", async () => {
    const fake = new FakeCortadelClient();
    fake.hits = [hit({ id: "m1", content: "A fact." })];

    // A two-step agentic loop: the model calls a tool, then answers.
    const model = new MockLanguageModelV4({
      doGenerate: [toolCallResult("ping", { value: 1 }), textResult("Pong is 1.")],
    });
    const wrapped = wrapLanguageModel({
      model,
      middleware: cortadelMemory({ client: fake, userId: TEST_USER, awaitPersist: true }),
    });

    await generateText({
      model: wrapped,
      tools: {
        ping: tool({
          description: "Echo a number.",
          inputSchema: z.object({ value: z.number() }),
          execute: async ({ value }: { value: number }) => ({ value }),
        }),
      },
      stopWhen: stepCountIs(5),
      prompt: "Ping with 1.",
    });

    // Two model calls...
    expect(model.doGenerateCalls).toHaveLength(2);
    // ...but only one search (the cache collapses per-step recall into per-turn recall)...
    expect(fake.searchCalls).toHaveLength(1);
    // ...and exactly one write, for the finished turn only.
    expect(fake.conversationCalls).toHaveLength(1);
    expect(fake.conversationCalls[0]?.messages[1]).toEqual({
      role: "assistant",
      content: "Pong is 1.",
    });
  });

  it("does not write the same turn twice", async () => {
    const fake = new FakeCortadelClient();
    const middleware = cortadelMemory({ client: fake, userId: TEST_USER, awaitPersist: true });
    const build2 = () =>
      wrapLanguageModel({
        model: new MockLanguageModelV4({ doGenerate: textResult("Same answer.") }),
        middleware,
      });

    await generateText({ model: build2(), prompt: "Same question." });
    await generateText({ model: build2(), prompt: "Same question." });

    expect(fake.conversationCalls).toHaveLength(1);
  });

  it("skips the write when the model produced no text", async () => {
    const fake = new FakeCortadelClient();
    const { wrapped } = build(fake, { mock: { doGenerate: textResult("") } });

    await generateText({ model: wrapped, prompt: "Hello" });

    expect(fake.conversationCalls).toHaveLength(0);
  });
});

describe("degrading gracefully", () => {
  it("still answers when recall fails, and reports the failure", async () => {
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("connect ECONNREFUSED 127.0.0.1:3001");
    const errors: Array<{ phase: string; userId: string }> = [];
    const { model, wrapped } = build(fake, {
      onError: (_error: unknown, context: { phase: string; userId: string }) =>
        errors.push(context),
    });

    const result = await generateText({ model: wrapped, prompt: "Hello" });

    expect(result.text).toBe("ok");
    expect(errors).toEqual([{ phase: "recall", userId: TEST_USER }]);
    // The prompt reached the model unmodified.
    expect(model.doGenerateCalls[0]!.prompt.every((m) => m.role !== "system")).toBe(true);
  });

  it("still answers when persistence fails, and reports the failure", async () => {
    const fake = new FakeCortadelClient();
    fake.conversationError = new Error("503 degraded");
    const errors: Array<{ phase: string; userId: string }> = [];
    const { wrapped } = build(fake, {
      onError: (_error: unknown, context: { phase: string; userId: string }) =>
        errors.push(context),
    });

    const result = await generateText({ model: wrapped, prompt: "Hello" });

    expect(result.text).toBe("ok");
    expect(errors).toEqual([{ phase: "persist", userId: TEST_USER }]);
  });

  it("retries a turn whose write failed rather than suppressing it forever", async () => {
    const fake = new FakeCortadelClient();
    fake.conversationError = new Error("503 degraded");
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      onError: () => {},
    });
    const build2 = () =>
      wrapLanguageModel({
        model: new MockLanguageModelV4({ doGenerate: textResult("Same answer.") }),
        middleware,
      });

    await generateText({ model: build2(), prompt: "Same question." });
    fake.conversationError = undefined;
    await generateText({ model: build2(), prompt: "Same question." });

    expect(fake.conversationCalls).toHaveLength(2);
  });

  it("warns through the console when nothing else is watching", async () => {
    // Fail-open plus a no-op default would make an outage invisible: the agent quietly answers
    // from nothing. With no onError callback the failure has to reach *some* log.
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("connect ECONNREFUSED 127.0.0.1:3001");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wrapped } = build(fake);

    try {
      const result = await generateText({ model: wrapped, prompt: "Hello" });

      expect(result.text).toBe("ok");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("recall failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent on the console when an onError callback is watching", async () => {
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("down");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wrapped } = build(fake, { onError: () => {} });

    try {
      await generateText({ model: wrapped, prompt: "Hello" });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("propagates a recall failure when throwOnError is set", async () => {
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("connect ECONNREFUSED 127.0.0.1:3001");
    const { wrapped } = build(fake, { throwOnError: true, onError: () => {} });

    await expect(generateText({ model: wrapped, prompt: "Hello" })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("propagates a persistence failure when throwOnError and awaitPersist are both set", async () => {
    const fake = new FakeCortadelClient();
    fake.conversationError = new Error("503 degraded");
    const { wrapped } = build(fake, { throwOnError: true, onError: () => {} });

    await expect(generateText({ model: wrapped, prompt: "Hello" })).rejects.toThrow(/503/);
  });

  it("cannot propagate a fire-and-forget write failure, so it reports it instead", async () => {
    // The call has already returned by the time the write fails, so throwOnError has nothing to
    // throw into — and an unhandled rejection would kill the process. It must degrade to a report.
    const fake = new FakeCortadelClient();
    fake.conversationError = new Error("503 degraded");
    const errors: Array<{ phase: string; userId: string }> = [];
    const { wrapped } = build(fake, {
      awaitPersist: false,
      throwOnError: true,
      onError: (_error: unknown, context: { phase: string; userId: string }) =>
        errors.push(context),
    });

    const result = await generateText({ model: wrapped, prompt: "Hello" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.text).toBe("ok");
    expect(errors).toEqual([{ phase: "persist", userId: TEST_USER }]);
  });

  it("survives an onError handler that itself throws", async () => {
    const fake = new FakeCortadelClient();
    fake.searchError = new Error("down");
    const { wrapped } = build(fake, {
      onError: () => {
        throw new Error("logger exploded");
      },
    });

    await expect(generateText({ model: wrapped, prompt: "Hello" })).resolves.toMatchObject({
      text: "ok",
    });
  });
});

describe("per-request control via providerOptions", () => {
  it("skips recall when asked to", async () => {
    const fake = new FakeCortadelClient();
    const { wrapped } = build(fake);

    await generateText({
      model: wrapped,
      prompt: "Hello",
      providerOptions: { cortadel: { recall: false } },
    });

    expect(fake.searchCalls).toHaveLength(0);
    expect(fake.conversationCalls).toHaveLength(1);
  });

  it("skips persistence when asked to", async () => {
    const fake = new FakeCortadelClient();
    const { wrapped } = build(fake);

    await generateText({
      model: wrapped,
      prompt: "Hello",
      providerOptions: { cortadel: { persist: false } },
    });

    expect(fake.searchCalls).toHaveLength(1);
    expect(fake.conversationCalls).toHaveLength(0);
  });

  it("scopes the call to a per-request user id", async () => {
    // No client is supplied, so the middleware builds one client per user id. `fetch` is stubbed
    // to fail immediately, which keeps the test offline while still proving which user id was
    // routed: it comes back through onError's context.
    const seen: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      baseUrl: "http://localhost:3001",
      userId: `${TEST_USER}-default`,
      persist: false,
      fetch: async () => {
        throw new Error("network disabled in tests");
      },
      onError: (_error, context) => seen.push(context),
    });
    const wrapped = wrapLanguageModel({
      model: new MockLanguageModelV4({ doGenerate: textResult("ok") }),
      middleware,
    });

    await generateText({
      model: wrapped,
      prompt: "Hello",
      providerOptions: { cortadel: { userId: `${TEST_USER}-bob` } },
    });

    expect(seen).toEqual([{ phase: "recall", userId: `${TEST_USER}-bob` }]);
  });

  it("uses a per-request session id for both halves", async () => {
    const fake = new FakeCortadelClient();
    const { wrapped } = build(fake, { sessionId: "configured" });

    await generateText({
      model: wrapped,
      prompt: "Hello",
      providerOptions: { cortadel: { sessionId: "per-request" } },
    });

    expect(fake.searchCalls[0]?.options?.sessionId).toBe("per-request");
    expect(fake.conversationCalls[0]?.options?.sessionId).toBe("per-request");
  });
});

describe("configuration errors surface immediately", () => {
  it("rejects a middleware with no connection details", () => {
    expect(() => cortadelMemory({} as never)).toThrow(/provide either `client` or `baseUrl`/);
  });

  it("rejects both a client and a baseUrl", () => {
    expect(() =>
      cortadelMemory({ client: new FakeCortadelClient(), baseUrl: "http://localhost:3001" }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a baseUrl with no user id", () => {
    expect(() => cortadelMemory({ baseUrl: "http://localhost:3001" })).toThrow(
      /`userId` is required/,
    );
  });
});
