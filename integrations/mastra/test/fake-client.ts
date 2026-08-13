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

import type { CortadelClientLike } from "../src/index.js";

export interface SearchCall {
  query: string;
  options?: SearchOptions;
  signal?: AbortSignal;
}

export interface AddCall {
  text: string;
  options?: AddOptions;
}

export interface ConversationCall {
  messages: ChatMessage[];
  options?: ConversationOptions;
}

/** Build a `SearchHit` with only the fields a test cares about. */
export function hit(id: string, content: string, extra: Partial<SearchHit> = {}): SearchHit {
  return { id, content, isGlobal: false, ...extra };
}

/** A promise a test settles by hand — used to hold a write in flight. */
export interface Gate {
  promise: Promise<void>;
  open: () => void;
}

/**
 * Create a {@link Gate}. `Promise.withResolvers` would do this, but the
 * package's `lib` is ES2022 and does not declare it.
 */
export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * An in-memory stand-in for `CortadelClient`, scoped to one user id exactly the
 * way the real client is. No network, no keys.
 */
export class FakeCortadelClient implements CortadelClientLike {
  readonly searchCalls: SearchCall[] = [];
  readonly addCalls: AddCall[] = [];
  readonly conversationCalls: ConversationCall[] = [];

  hits: SearchHit[] = [];
  searchError: unknown;
  addError: unknown;
  conversationError: unknown;
  addEvent = "ADD";
  /**
   * When set, `addConversation` records the call and then blocks on this until
   * the test opens it — which is how a test observes a write *while it is still
   * in flight*.
   */
  conversationGate: Promise<void> | undefined;

  constructor(readonly userId: string) {}

  async search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults> {
    this.searchCalls.push({ query, options, signal });
    if (this.searchError) throw this.searchError;
    return { query, results: this.hits, total: this.hits.length };
  }

  async add(text: string, options?: AddOptions): Promise<MemoryCreated> {
    this.addCalls.push({ text, options });
    if (this.addError) throw this.addError;
    return { id: `mem-${this.addCalls.length}`, content: text, event: this.addEvent };
  }

  async addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
  ): Promise<ConversationResult> {
    this.conversationCalls.push({ messages, options });
    if (this.conversationGate) await this.conversationGate;
    if (this.conversationError) throw this.conversationError;
    return { results: [{ id: "fact-1", memory: "a distilled fact", event: "ADD" }] };
  }
}

/** A `createClient` factory that records which user ids were asked for. */
export function fakeClientFactory(): {
  createClient: (userId: string) => CortadelClientLike;
  clients: Map<string, FakeCortadelClient>;
  requested: string[];
  for: (userId: string) => FakeCortadelClient;
} {
  const clients = new Map<string, FakeCortadelClient>();
  const requested: string[] = [];

  const factory = {
    clients,
    requested,
    createClient(userId: string): CortadelClientLike {
      requested.push(userId);
      const existing = clients.get(userId);
      if (existing) return existing;
      const created = new FakeCortadelClient(userId);
      clients.set(userId, created);
      return created;
    },
    for(userId: string): FakeCortadelClient {
      const client = clients.get(userId);
      if (!client) throw new Error(`no fake client was created for "${userId}"`);
      return client;
    },
  };
  return factory;
}
