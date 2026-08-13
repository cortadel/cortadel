/**
 * Shared offline test doubles.
 *
 * Nothing here touches a network, a Cortadel server, or an LLM. The Cortadel boundary is stubbed
 * with {@link FakeCortadelClient}, which implements exactly the seven public SDK methods and
 * returns the SDK's real DTO shapes — so a field renamed upstream breaks these tests rather than
 * silently passing.
 */

import type {
  AddOptions,
  ChatMessage,
  ConversationOptions,
  ConversationResult,
  CortadelClient,
  HealthResult,
  ListOptions,
  MemoryCreated,
  MemoryDetail,
  MemoryList,
  SearchHit,
  SearchOptions,
  SearchResults,
} from '@cortadel/sdk';
import { CortadelError } from '@cortadel/sdk';
import type { AgentInputItem } from '@openai/agents';

export const BASE_URL = 'http://localhost:3001';
export const USER_ID = 'e2e-openai-agents-user';
export const SESSION_ID = 'e2e-openai-agents-session';

export function hit(content: string, score: number | null = 0.9, id = 'mem-1'): SearchHit {
  return { id, content, rrfScore: score, isGlobal: false };
}

export interface FakeOptions {
  hits?: SearchHit[];
  /** When set, every method rejects with it. Models "the Cortadel server is unreachable". */
  failWith?: unknown;
  addEvent?: string;
}

/**
 * Stands in for `CortadelClient` — the full public surface (seven methods), nothing more.
 * Every call is recorded so tests can assert on the exact options object that was built.
 */
export class FakeCortadelClient {
  hits: SearchHit[];
  failWith: unknown;
  addEvent: string;

  searches: Array<{ query: string; options?: SearchOptions }> = [];
  conversations: Array<{ messages: ChatMessage[]; options?: ConversationOptions }> = [];
  adds: Array<{ text: string; options?: AddOptions }> = [];
  deletes: string[][] = [];

  constructor(options: FakeOptions = {}) {
    this.hits = options.hits ?? [];
    this.failWith = options.failWith;
    this.addEvent = options.addEvent ?? 'ADD';
  }

  private maybeFail(): void {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
  }

  async add(text: string, options?: AddOptions): Promise<MemoryCreated> {
    this.adds.push({ text, ...(options ? { options } : {}) });
    this.maybeFail();
    return { id: 'mem-new', content: text, event: this.addEvent };
  }

  async addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
  ): Promise<ConversationResult> {
    this.conversations.push({ messages: [...messages], ...(options ? { options } : {}) });
    this.maybeFail();
    return { results: [{ id: 'mem-new', memory: 'a fact', event: 'ADD' }] };
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResults> {
    this.searches.push({ query, ...(options ? { options } : {}) });
    this.maybeFail();
    return { query, results: [...this.hits], total: this.hits.length };
  }

  async list(_options?: ListOptions): Promise<MemoryList> {
    this.maybeFail();
    return { items: [], total: 0, page: 1, size: 20, pages: 0 };
  }

  async get(_memoryId: string): Promise<MemoryDetail | null> {
    this.maybeFail();
    return null;
  }

  async delete(memoryIds: string[]): Promise<string> {
    this.deletes.push([...memoryIds]);
    this.maybeFail();
    return 'deleted';
  }

  async health(): Promise<HealthResult> {
    this.maybeFail();
    return { status: 'ok' };
  }
}

/**
 * The fake satisfies the public surface, but `CortadelClient` is a class with private state, so
 * TypeScript will not accept it structurally. Tests pass it through this cast deliberately.
 */
export function asClient(fake: FakeCortadelClient): CortadelClient {
  return fake as unknown as CortadelClient;
}

export function unreachable(): FakeCortadelClient {
  return new FakeCortadelClient({
    failWith: new CortadelError(0, 'transport_error', 'Connection refused'),
  });
}

/** A user message item in the shorthand shape the runner accepts. */
export function userMessage(text: string): AgentInputItem {
  return { role: 'user', content: text };
}

/** An assistant message item in the fully expanded Responses shape. */
export function assistantMessage(text: string): AgentInputItem {
  return {
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}
