import type {
  AddOptions,
  ChatMessage,
  ConversationOptions,
  ConversationResult,
  MemoryCreated,
  SearchHit,
  SearchOptions,
  SearchResults,
} from "@cortadel/sdk";

import type { CortadelMemoryClient } from "../src/types.js";

/**
 * Every test user id carries the repo-wide `e2e-` prefix marking data as disposable, even though
 * nothing here reaches a server.
 */
export const TEST_USER = "e2e-vercel-ai-sdk";

/**
 * An in-memory stand-in for `CortadelClient`, recording every call.
 *
 * The integration is typed against the narrow {@link CortadelMemoryClient} interface rather than
 * the concrete class, which is what lets this exist and keeps the suite fully offline: no server,
 * no network, no keys.
 */
export class FakeCortadelClient implements CortadelMemoryClient {
  searchCalls: Array<{ query: string; options?: SearchOptions }> = [];
  conversationCalls: Array<{ messages: ChatMessage[]; options?: ConversationOptions }> = [];
  addCalls: Array<{ text: string; options?: AddOptions }> = [];

  /** Hits the next `search` will return. */
  hits: SearchHit[] = [];
  /** When set, `search` rejects with it. */
  searchError?: Error;
  /** When set, `addConversation` rejects with it. */
  conversationError?: Error;
  /** When set, `add` rejects with it. */
  addError?: Error;
  /** Ids `add` hands back, in order. Falls back to a generated id. */
  addEvents: Array<{ id: string; event: string }> = [];

  async search(query: string, options?: SearchOptions): Promise<SearchResults> {
    this.searchCalls.push({ query, options });
    if (this.searchError != null) {
      throw this.searchError;
    }
    return { query, results: this.hits, total: this.hits.length };
  }

  async addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
  ): Promise<ConversationResult> {
    this.conversationCalls.push({ messages, options });
    if (this.conversationError != null) {
      throw this.conversationError;
    }
    return { results: messages.map((m, i) => ({ id: `fact-${i}`, memory: m.content, event: "ADD" })) };
  }

  async add(text: string, options?: AddOptions): Promise<MemoryCreated> {
    this.addCalls.push({ text, options });
    if (this.addError != null) {
      throw this.addError;
    }
    const canned = this.addEvents[this.addCalls.length - 1];
    return {
      id: canned?.id ?? `mem-${this.addCalls.length}`,
      content: text,
      event: canned?.event ?? "ADD",
    };
  }
}

/** Builds a `SearchHit` with only the fields a test cares about. */
export function hit(partial: Partial<SearchHit> & { id: string; content: string }): SearchHit {
  return { isGlobal: false, ...partial };
}

/** A zero-filled usage record in the shape `LanguageModelV4Usage` requires. */
export const emptyUsage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A completed non-streaming generation returning `text`. */
export function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: emptyUsage,
    warnings: [],
  };
}

/** A generation that stops to call a tool — i.e. an unfinished turn. */
export function toolCallResult(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "call-1",
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    usage: emptyUsage,
    warnings: [],
  };
}

/** A stream that emits `text` as a single delta and then finishes. */
export function textStreamResult(text: string) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t1" });
        controller.enqueue({ type: "text-delta", id: "t1", delta: text });
        controller.enqueue({ type: "text-end", id: "t1" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: emptyUsage,
        });
        controller.close();
      },
    }),
  };
}
