// Shared offline fixtures. Nothing here opens a socket or reads a credential.
import type { ConversationResult, MemoryCreated, MemoryDetail, SearchHit, SearchResults } from "@cortadel/sdk";
import type { CortadelLogger, CortadelMemoryClient } from "../src/types.js";

/** Test user ids all carry the project-wide disposable `e2e-` prefix. */
export const TEST_USER = "e2e-openclaw-integration";

export function hit(id: string, content: string, extra: Partial<SearchHit> = {}): SearchHit {
  return { id, content, isGlobal: false, ...extra };
}

export function searchResults(query: string, hits: SearchHit[]): SearchResults {
  return { query, results: hits, total: hits.length };
}

export function detail(id: string, text: string, extra: Partial<MemoryDetail> = {}): MemoryDetail {
  // `createdAt` is Unix *seconds* on this schema, unlike SearchHit's ISO string.
  return { id, text, createdAt: 1_767_225_600, state: "active", categories: [], isGlobal: false, ...extra };
}

/** Records every call, returns canned values, and can be told to throw. */
export class FakeCortadelClient implements CortadelMemoryClient {
  readonly searches: Array<{ query: string; options?: unknown; userId: string }> = [];
  readonly conversations: Array<{ messages: unknown; options?: unknown; userId: string }> = [];
  readonly adds: Array<{ text: string; options?: unknown; userId: string }> = [];
  readonly gets: string[] = [];

  searchResult: SearchResults = { query: "", results: [], total: 0 };
  conversationResult: ConversationResult = { noFactsExtracted: true };
  addResult: MemoryCreated = { id: "mem-new", event: "ADD" };
  getResult: MemoryDetail | null = null;
  /** When set, every method rejects with it. */
  failure: unknown;

  constructor(readonly userId: string = TEST_USER) {}

  private guard(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  async search(query: string, options?: unknown): Promise<SearchResults> {
    this.searches.push({ query, options, userId: this.userId });
    this.guard();
    return this.searchResult;
  }

  async addConversation(messages: unknown, options?: unknown): Promise<ConversationResult> {
    this.conversations.push({ messages, options, userId: this.userId });
    this.guard();
    return this.conversationResult;
  }

  async add(text: string, options?: unknown): Promise<MemoryCreated> {
    this.adds.push({ text, options, userId: this.userId });
    this.guard();
    return this.addResult;
  }

  async get(memoryId: string): Promise<MemoryDetail | null> {
    this.gets.push(memoryId);
    this.guard();
    return this.getResult;
  }
}

/** Logger that captures lines so tests can assert on degradation warnings. */
export function recordingLogger(): CortadelLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: (m) => lines.push(`debug:${m}`),
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
  };
}

/** A `CortadelError`-shaped rejection, matching the SDK's `status`/`code`/`message`. */
export function cortadelError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "CortadelError", status, code });
}
