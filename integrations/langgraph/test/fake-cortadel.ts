/**
 * Offline test doubles.
 *
 * Every test in this suite runs with no network, no Cortadel server and no API keys. The seam is
 * the Cortadel client itself: {@link FakeBackend} records the calls a store makes and hands back
 * real `@cortadel/sdk` DTO shapes, and the store is pointed at it through its `clientFactory`
 * option — so nothing has to be module-patched.
 *
 * User ids here always use the project-wide `e2e-*` prefix for disposable test data.
 */
import {
  CortadelError,
  type AddOptions,
  type ChatMessage,
  type ConversationOptions,
  type ConversationResult,
  type HealthResult,
  type ListOptions,
  type MemoryCreated,
  type MemoryDetail,
  type MemoryList,
  type MemoryListItem,
  type SearchHit,
  type SearchOptions,
  type SearchResults,
} from "@cortadel/sdk";

import type { CortadelMemoryClient } from "../src/index.js";

export const USER = "e2e-langgraph-integration";
export const OTHER_USER = "e2e-langgraph-other";
export const NAMESPACE = ["memories", USER];

export interface RecordedCall {
  userId: string;
  method: string;
  args: unknown[];
}

/** Shared state behind every fake client a store builds. */
export class FakeBackend {
  readonly calls: RecordedCall[] = [];
  readonly constructed: string[] = [];
  private nextId = 0;

  /** Canned responses, overridable per test. */
  searchHits: SearchHit[] = [];
  listItems: MemoryListItem[] = [];
  detail: MemoryDetail | null = null;
  conversation: ConversationResult = {
    results: [{ id: "m-conv", memory: "a fact", event: "ADD" }],
  };
  healthResult: HealthResult = { status: "ok", checkedAt: "2026-08-13T00:00:00Z" };
  /** When set, the named method throws this error instead of answering. */
  failures = new Map<string, CortadelError>();

  /** The `clientFactory` to hand a `CortadelStore`. */
  readonly factory = (userId: string): CortadelMemoryClient => {
    this.constructed.push(userId);
    return new FakeCortadelClient(this, userId);
  };

  record(userId: string, method: string, ...args: unknown[]): void {
    this.calls.push({ userId, method, args });
  }

  maybeFail(method: string): void {
    const error = this.failures.get(method);
    if (error !== undefined) throw error;
  }

  mintId(): string {
    this.nextId += 1;
    return `cortadel-${this.nextId}`;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  users(): string[] {
    return this.calls.map((call) => call.userId);
  }

  first(method: string): unknown[] {
    const call = this.calls.find((entry) => entry.method === method);
    if (call === undefined) {
      throw new Error(`no ${method} call was recorded; got ${this.methods().join(", ")}`);
    }
    return call.args;
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

/** Stands in for `CortadelClient`, recording everything into a shared {@link FakeBackend}. */
export class FakeCortadelClient implements CortadelMemoryClient {
  constructor(
    private readonly backend: FakeBackend,
    private readonly userId: string,
  ) {}

  async add(text: string, options?: AddOptions): Promise<MemoryCreated> {
    this.backend.record(this.userId, "add", text, options);
    this.backend.maybeFail("add");
    return { id: this.backend.mintId(), content: text, event: "ADD" };
  }

  async addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
  ): Promise<ConversationResult> {
    this.backend.record(this.userId, "addConversation", [...messages], options);
    this.backend.maybeFail("addConversation");
    return this.backend.conversation;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResults> {
    this.backend.record(this.userId, "search", query, options);
    this.backend.maybeFail("search");
    const results = [...this.backend.searchHits];
    return { query, results, total: results.length };
  }

  async list(options?: ListOptions): Promise<MemoryList> {
    this.backend.record(this.userId, "list", options);
    this.backend.maybeFail("list");
    const items = [...this.backend.listItems];
    return { items, total: items.length, page: 1, size: items.length, pages: 1 };
  }

  async get(memoryId: string): Promise<MemoryDetail | null> {
    this.backend.record(this.userId, "get", memoryId);
    this.backend.maybeFail("get");
    return this.backend.detail;
  }

  async delete(memoryIds: string[]): Promise<string> {
    this.backend.record(this.userId, "delete", [...memoryIds]);
    this.backend.maybeFail("delete");
    return `deleted ${memoryIds.length}`;
  }

  async health(): Promise<HealthResult> {
    this.backend.record(this.userId, "health");
    this.backend.maybeFail("health");
    return this.backend.healthResult;
  }
}

/** A logger that records instead of printing, so tests can assert on warnings. */
export class RecordingLogger {
  readonly warnings: string[] = [];
  warn(message: string, ...args: unknown[]): void {
    // `String` takes a single argument, so `map`'s extra `(index, array)` arguments are ignored.
    this.warnings.push([message, ...args.map(String)].join(" "));
  }
}

export function hit(id: string, content: string, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    content,
    rrfScore: 0.5,
    createdAt: "2026-08-01T12:00:00Z",
    isGlobal: false,
    ...extra,
  };
}

export function listItem(
  id: string,
  content: string,
  extra: Partial<MemoryListItem> = {},
): MemoryListItem {
  return {
    id,
    content,
    createdAt: 1_754_049_600,
    state: "active",
    categories: [],
    isGlobal: false,
    ...extra,
  };
}

export function detail(id: string, text: string, extra: Partial<MemoryDetail> = {}): MemoryDetail {
  return {
    id,
    text,
    createdAt: 1_754_049_600,
    state: "active",
    categories: [],
    isGlobal: false,
    ...extra,
  };
}

export function serverError(message = "boom"): CortadelError {
  return new CortadelError(503, "transport_error", message);
}
