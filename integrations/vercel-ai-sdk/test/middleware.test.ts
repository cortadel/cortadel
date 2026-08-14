import { describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import type { LanguageModelMiddleware } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { cortadelMemory } from "../src/index.js";
import {
  FakeCortadelClient,
  TEST_USER,
  emptyUsage,
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

/*
 * The tests below drive the middleware hooks directly instead of going through `generateText` /
 * `streamText`, because they feed in payloads no conforming provider produces. Routed through the
 * SDK, the SDK itself would reject them downstream — which would prove nothing about the
 * middleware, the thing under test. The casts are the point: they stand in for the misbehaving
 * provider.
 *
 * They do run the hooks in the order `wrapLanguageModel` runs them, though — `transformParams`
 * first, then the wrapper, fed the params `transformParams` returned. Driving a wrapper on its own
 * is what let a crash hide here once already: the same malformed prompt these stream tests use
 * aborts the run one hook earlier, in recall, and a test that skips that hook never sees it.
 */
type TransformParamsArgs = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0];
type WrapGenerateArgs = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0];
type WrapStreamArgs = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];

/** The params a hook was called with, in the only shape these tests assert on. */
type CallParams = { prompt: unknown; providerOptions?: unknown };

/** A well-formed single-turn prompt. */
const goodPrompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];

/** A prompt whose latest user message has no `content` array to read text out of. */
const malformedPrompt = [{ role: "user", content: undefined }];

/** A well-formed turn that simply carries no text: an image-only question. */
const imageOnlyPrompt = [
  { role: "user", content: [{ type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" }] },
];

/** A finished generation with no `content` array — the shape that broke the safety net. */
const malformedResult = { content: undefined, finishReason: "stop", usage: {} };

/** The parts of a complete, well-behaved text stream. */
function streamParts(text: string): unknown[] {
  return [
    { type: "text-delta", id: "t1", delta: text },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: emptyUsage },
  ];
}

/** Calls `transformParams` — the recall hook, and the first thing every model call runs. */
async function callTransform(
  middleware: LanguageModelMiddleware,
  prompt: unknown,
  providerOptions?: unknown,
  type: "generate" | "stream" = "generate",
): Promise<CallParams> {
  const params = await middleware.transformParams!({
    type,
    params: { prompt, providerOptions },
    model: {},
  } as unknown as TransformParamsArgs);
  return params as unknown as CallParams;
}

/** Runs the chain for a non-streaming call: `transformParams`, then `wrapGenerate`. */
async function callGenerate(
  middleware: LanguageModelMiddleware,
  prompt: unknown,
  result: unknown,
  providerOptions?: unknown,
): Promise<{ result: unknown; params: CallParams; modelCalled: boolean }> {
  const params = await callTransform(middleware, prompt, providerOptions);
  let modelCalled = false;
  const out = await middleware.wrapGenerate!({
    doGenerate: async () => {
      modelCalled = true;
      return result;
    },
    doStream: async () => ({ stream: new ReadableStream() }),
    params,
    model: {},
  } as unknown as WrapGenerateArgs);
  return { result: out, params, modelCalled };
}

/** Runs the chain for a streaming call and drains it, returning the parts that came through. */
async function callStream(
  middleware: LanguageModelMiddleware,
  prompt: unknown,
  parts: unknown[],
  providerOptions?: unknown,
): Promise<{ seen: unknown[]; params: CallParams }> {
  const params = await callTransform(middleware, prompt, providerOptions, "stream");
  const { stream } = await middleware.wrapStream!({
    doGenerate: async () => ({ content: [], finishReason: "stop", usage: emptyUsage }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    }),
    params,
    model: {},
  } as unknown as WrapStreamArgs);

  const reader = (stream as ReadableStream<unknown>).getReader();
  const seen: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { seen, params };
    }
    seen.push(value);
  }
}

describe("malformed input degrades like any other memory failure", () => {
  // Every read of provider-shaped data has to happen *inside* a guard — the prompt on the way in,
  // the result on the way out. As bare expressions those reads sit outside every catch in the
  // middleware, so `content: undefined` throws straight out of the hook: the model call aborts,
  // `onError` never fires and `throwOnError: false` is bypassed — the exact failure this package
  // promises cannot happen. Every other test here uses a well-behaved mock, so nothing else can
  // catch it, and it has to be pinned at *both* hooks: recall reads the prompt one call earlier
  // than persistence ever runs, so a crash there aborts the run before the persist net exists.

  it("still calls the model, with untouched params, when the prompt cannot be read", async () => {
    const fake = new FakeCortadelClient();
    const errors: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      onError: (_error, context) => errors.push(context),
    });

    // Persistence off, so the one report can only have come from recall.
    const { result, params, modelCalled } = await callGenerate(
      middleware,
      malformedPrompt,
      textResult("ok"),
      { cortadel: { persist: false } },
    );

    // The call reached the model at all — recall used to abort the run before this point.
    expect(modelCalled).toBe(true);
    expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    // ...and reached it with the caller's own prompt: no injected block, no copy.
    expect(params.prompt).toBe(malformedPrompt);
    // Reported once, as the recall failure it is. Nothing was searched.
    expect(errors).toEqual([{ phase: "recall", userId: TEST_USER }]);
    expect(fake.searchCalls).toHaveLength(0);
  });

  it("propagates an unreadable prompt when throwOnError is set, like any recall failure", async () => {
    const fake = new FakeCortadelClient();
    const errors: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      throwOnError: true,
      onError: (_error, context) => errors.push(context),
    });

    await expect(callTransform(middleware, malformedPrompt)).rejects.toThrow(TypeError);
    expect(errors).toEqual([{ phase: "recall", userId: TEST_USER }]);
  });

  it("hands back a malformed generation untouched and reports the failure", async () => {
    const fake = new FakeCortadelClient();
    const errors: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      onError: (_error, context) => errors.push(context),
    });

    const { result } = await callGenerate(middleware, goodPrompt, malformedResult);

    // The run survived, and the caller still holds exactly what the provider produced.
    expect(result).toBe(malformedResult);
    // Reported once — a single failure reaching onError twice is its own bug.
    expect(errors).toEqual([{ phase: "persist", userId: TEST_USER }]);
    expect(fake.conversationCalls).toHaveLength(0);
  });

  it("propagates a malformed generation when throwOnError is set, like any persist failure", async () => {
    const fake = new FakeCortadelClient();
    const errors: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      throwOnError: true,
      onError: (_error, context) => errors.push(context),
    });

    await expect(callGenerate(middleware, goodPrompt, malformedResult)).rejects.toThrow(TypeError);
    expect(errors).toEqual([{ phase: "persist", userId: TEST_USER }]);
  });

  it("lets a streamed turn finish when the prompt cannot be read, and reports both halves", async () => {
    // One unreadable prompt, read twice: by recall on the way in and by persistence on the way
    // out. Both degrade, both report, and the consumer still gets every part of the stream.
    const fake = new FakeCortadelClient();
    const errors: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      onError: (_error, context) => errors.push(context),
    });

    const { seen } = await callStream(middleware, malformedPrompt, streamParts("Streamed reply."));

    // Every part reached the consumer; the stream closed rather than erroring.
    expect(seen).toHaveLength(2);
    expect(errors).toEqual([
      { phase: "recall", userId: TEST_USER },
      { phase: "persist", userId: TEST_USER },
    ]);
    expect(fake.searchCalls).toHaveLength(0);
    expect(fake.conversationCalls).toHaveLength(0);
  });

  it("errors the stream when throwOnError is set", async () => {
    // Recall is switched off for this one so the unreadable prompt reaches the *stream's* flush.
    // With it on, the chain rightly rejects a hook earlier (the test above this pair) and the
    // stream — the thing under test here — would never be built at all.
    const fake = new FakeCortadelClient();
    const errors: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      throwOnError: true,
      onError: (_error, context) => errors.push(context),
    });

    await expect(
      callStream(middleware, malformedPrompt, streamParts("Streamed reply."), {
        cortadel: { recall: false },
      }),
    ).rejects.toThrow(TypeError);
    expect(errors).toEqual([{ phase: "persist", userId: TEST_USER }]);
  });

  it("keeps a stream flowing through a null part", async () => {
    // A stream part is provider-shaped data too, and the capture tap reads `part.type` outside any
    // catch — inside a TransformStream, where a throw errors the stream the consumer is already
    // reading. Nothing to report here: the part is passed through for the SDK to reject downstream.
    const fake = new FakeCortadelClient();
    const errors: Array<{ phase: string; userId: string }> = [];
    const middleware = cortadelMemory({
      client: fake,
      userId: TEST_USER,
      awaitPersist: true,
      onError: (_error, context) => errors.push(context),
    });

    const { seen } = await callStream(middleware, goodPrompt, [
      null,
      ...streamParts("Streamed reply."),
    ]);

    expect(seen).toEqual([null, ...streamParts("Streamed reply.")]);
    expect(errors).toEqual([]);
    // The rest of the stream was still captured and remembered.
    expect(fake.conversationCalls[0]?.messages[1]).toEqual({
      role: "assistant",
      content: "Streamed reply.",
    });
  });
});

describe("a turn with nothing to search for is not a failure", () => {
  it("skips the search silently and leaves the prompt alone", async () => {
    // An image-only question is well-formed; there is just no text to query Cortadel with. Its
    // early return now lives inside the same `try` that catches an unreadable prompt, so this
    // pins the difference between the two: nothing to search is silent, unable to read is
    // reported. No onError here on purpose — `console.warn` is the fallback report channel, so a
    // silent skip has to trip neither.
    const fake = new FakeCortadelClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const middleware = cortadelMemory({ client: fake, userId: TEST_USER, awaitPersist: true });

    try {
      const params = await callTransform(middleware, imageOnlyPrompt);

      expect(params.prompt).toBe(imageOnlyPrompt);
      expect(fake.searchCalls).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
