import { describe, expect, it } from "vitest";

import { ClientResolver, DEFAULT_APP_NAME } from "../src/connection.js";
import { formatMemories } from "../src/format.js";
import { assistantText, injectSystemMemories, lastUserText } from "../src/prompt.js";
import type { LanguageModelPrompt } from "../src/types.js";
import { FakeCortadelClient, TEST_USER, hit } from "./harness.js";

describe("client-per-user scoping", () => {
  // A Cortadel client is bound to one user id at construction — there is no per-call user
  // parameter — so this cache is the whole of the integration's multi-tenancy story.
  const connection = { baseUrl: "http://localhost:3001", userId: `${TEST_USER}-alice` };

  it("builds a distinct client per user id", () => {
    const resolver = new ClientResolver(connection);

    const alice = resolver.resolve(`${TEST_USER}-alice`);
    const bob = resolver.resolve(`${TEST_USER}-bob`);

    expect(alice).not.toBe(bob);
  });

  it("reuses the client for a repeated user id", () => {
    const resolver = new ClientResolver(connection);

    expect(resolver.resolve(`${TEST_USER}-alice`)).toBe(resolver.resolve(`${TEST_USER}-alice`));
  });

  it("evicts the oldest client when the cache is full", () => {
    const resolver = new ClientResolver({ ...connection, clientCacheSize: 1 });

    const first = resolver.resolve(`${TEST_USER}-alice`);
    resolver.resolve(`${TEST_USER}-bob`);

    expect(resolver.resolve(`${TEST_USER}-alice`)).not.toBe(first);
  });

  it("prefers a per-request user id over the configured default", () => {
    const resolver = new ClientResolver(connection);

    expect(resolver.resolveUserId(`${TEST_USER}-bob`)).toBe(`${TEST_USER}-bob`);
    expect(resolver.resolveUserId(undefined)).toBe(`${TEST_USER}-alice`);
    expect(resolver.supportsPerRequestUserId).toBe(true);
  });

  it("pins to the supplied client's own user when one is given", () => {
    const client = new FakeCortadelClient();
    const resolver = new ClientResolver({ client, userId: TEST_USER });

    // A caller-supplied client carries a user id it does not expose, so a per-request override
    // cannot be honoured and is deliberately ignored rather than silently misrouted.
    expect(resolver.supportsPerRequestUserId).toBe(false);
    expect(resolver.resolveUserId(`${TEST_USER}-bob`)).toBe(TEST_USER);
    expect(resolver.resolve(`${TEST_USER}-bob`)).toBe(client);
  });

  it("names itself for Cortadel's access log, using its own published package name", () => {
    // The npm name with its scope flattened: @cortadel/vercel-ai-provider.
    expect(DEFAULT_APP_NAME).toBe("cortadel-vercel-ai-provider");
  });
});

describe("reading the prompt", () => {
  it("uses the last user message as the recall query", () => {
    const prompt = [
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "First." }] },
      { role: "assistant", content: [{ type: "text", text: "Reply." }] },
      { role: "user", content: [{ type: "text", text: "Second." }] },
    ] as LanguageModelPrompt;

    expect(lastUserText(prompt)).toBe("Second.");
  });

  it("joins multiple text parts and ignores non-text parts", () => {
    const prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this." },
          { type: "file", mediaType: "image/png", data: "…" },
          { type: "text", text: "What is it?" },
        ],
      },
    ] as unknown as LanguageModelPrompt;

    expect(lastUserText(prompt)).toBe("Look at this.\nWhat is it?");
  });

  it("returns nothing for a prompt with no user text", () => {
    expect(lastUserText([] as unknown as LanguageModelPrompt)).toBe("");
    expect(
      lastUserText([
        { role: "user", content: [{ type: "file", mediaType: "image/png", data: "…" }] },
      ] as unknown as LanguageModelPrompt),
    ).toBe("");
  });

  it("collects only the text of a generation", () => {
    const content = [
      { type: "reasoning", text: "thinking…" },
      { type: "text", text: "Hello" },
      { type: "tool-call", toolCallId: "1", toolName: "x", input: "{}" },
      { type: "text", text: ", world." },
    ];

    expect(assistantText(content as never)).toBe("Hello, world.");
  });
});

describe("injecting memories into the prompt", () => {
  it("goes after the caller's system messages and before the conversation", () => {
    const prompt = [
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "Hi." }] },
    ] as LanguageModelPrompt;

    const next = injectSystemMemories(prompt, "MEMORIES");

    expect(next.map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(next[1]).toEqual({ role: "system", content: "MEMORIES" });
  });

  it("goes first when the caller supplied no system message", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "Hi." }] },
    ] as LanguageModelPrompt;

    expect(injectSystemMemories(prompt, "MEMORIES")[0]).toEqual({
      role: "system",
      content: "MEMORIES",
    });
  });

  it("does not mutate the prompt it was given", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "Hi." }] },
    ] as LanguageModelPrompt;

    injectSystemMemories(prompt, "MEMORIES");

    expect(prompt).toHaveLength(1);
  });
});

describe("the default memory block", () => {
  it("lists dated facts and warns the model not to treat them as gospel", () => {
    const text = formatMemories(
      [
        hit({ id: "m1", content: "A dated fact.", createdAt: "2026-03-04T10:00:00Z" }),
        hit({ id: "m2", content: "An undated fact." }),
      ],
      { query: "what do you know?", userId: TEST_USER },
    );

    expect(text).toContain("- (2026-03-04) A dated fact.");
    expect(text).toContain("- An undated fact.");
    expect(text).toContain("what do you know?");
    expect(text).toContain("the conversation wins");
  });

  it("ignores an unparsable timestamp rather than printing garbage", () => {
    const text = formatMemories([hit({ id: "m1", content: "A fact.", createdAt: "not-a-date" })], {
      query: "q",
      userId: TEST_USER,
    });

    expect(text).toContain("- A fact.");
    expect(text).not.toContain("Invalid");
  });
});
