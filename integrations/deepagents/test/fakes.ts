/**
 * Offline test doubles. Nothing here touches the network, a Cortadel server, or an LLM.
 *
 * `FakeCortadelClient` implements {@link CortadelMemoryClient} — the three-method slice of the SDK
 * this package uses — so it can be injected through `client` / `clientFactory` exactly the way a
 * real `CortadelClient` is.
 */

import { CortadelError } from "@cortadel/sdk";
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

import type { CortadelMemoryClient } from "../src/client.js";

export interface SearchCall {
  query: string;
  options?: SearchOptions;
  signal?: AbortSignal;
}

export interface AddCall {
  text: string;
  options?: AddOptions;
  signal?: AbortSignal;
}

export interface ConversationCall {
  messages: ChatMessage[];
  options?: ConversationOptions;
  signal?: AbortSignal;
}

export function hit(id: string, content: string, extra: Partial<SearchHit> = {}): SearchHit {
  return { id, content, isGlobal: false, ...extra };
}

export class FakeCortadelClient implements CortadelMemoryClient {
  readonly searchCalls: SearchCall[] = [];
  readonly addCalls: AddCall[] = [];
  readonly conversationCalls: ConversationCall[] = [];

  hits: SearchHit[] = [];
  searchError: unknown;
  addError: unknown;
  conversationError: unknown;
  /** When set, `addConversation` blocks on this until `flush()` releases it. */
  #gate: Promise<void> | undefined;
  #openGate: (() => void) | undefined;

  constructor(readonly userId = "e2e-deepagents-user") {}

  async search(
    query: string,
    options?: SearchOptions,
    signal?: AbortSignal,
  ): Promise<SearchResults> {
    this.searchCalls.push({ query, options, signal });
    if (this.searchError) throw this.searchError;
    return { query, results: this.hits, total: this.hits.length };
  }

  async add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated> {
    this.addCalls.push({ text, options, signal });
    if (this.addError) throw this.addError;
    return { id: `mem-${this.addCalls.length}`, content: text, event: "ADD" };
  }

  async addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
    signal?: AbortSignal,
  ): Promise<ConversationResult> {
    this.conversationCalls.push({ messages, options, signal });
    if (this.#gate) await this.#gate;
    if (this.conversationError) throw this.conversationError;
    return {
      results: messages.map((message, index) => ({
        id: `c-${index}`,
        memory: message.content,
        event: "ADD",
      })),
    };
  }

  /** Make `addConversation` hang until {@link flush} is called. */
  blockConversation(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#openGate = resolve;
    });
  }

  flush(): void {
    this.#openGate?.();
    this.#gate = undefined;
    this.#openGate = undefined;
  }
}

export function cortadelError(status = 503, code = "http_error", message = "server down"): CortadelError {
  return new CortadelError(status, code, message);
}
