/**
 * Shared test helpers. Nothing here touches the network, a Cortadel server, or
 * the Claude Code CLI.
 *
 * The Cortadel boundary is stubbed with {@link FakeCortadel}, a plain object
 * implementing the three methods this package calls. The Claude Agent SDK side
 * is **not** stubbed: tools are driven through the real in-process MCP server
 * built by `createSdkMcpServer`, over an in-memory transport, so the tests
 * exercise the SDK's own schema validation and result marshalling rather than
 * our idea of it.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StopHookInput, UserPromptSubmitHookInput } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

import type { CortadelMemory } from "../src/index.js";
import type { CortadelMemoryClient } from "../src/index.js";

export const BASE_URL = "http://localhost:3001";
export const USER_ID = "e2e-claude-agent-sdk";

/**
 * Not a UUID on purpose: `getSessionMessages` rejects non-UUID session ids and
 * returns `[]` (verified: it comes back empty in under a millisecond, touching
 * nothing), which forces `lastExchange` down its transcript-path fallback — the
 * branch these tests can drive hermetically, without planting files under
 * `~/.claude/projects/`.
 */
export const SESSION_ID = "e2e-session-not-a-uuid";

export const CWD = "/work/demo-project";

/** Records every call and returns pre-programmed results. Set a `*Error` to make one fail. */
export class FakeCortadel implements CortadelMemoryClient {
  searchResults: SearchHit[] = [];
  created: MemoryCreated = { id: "mem-1", event: "ADD" };
  conversation: ConversationResult = { noFactsExtracted: true };

  searchError?: unknown;
  addError?: unknown;
  conversationError?: unknown;

  readonly searches: [string, SearchOptions | undefined][] = [];
  readonly adds: [string, AddOptions | undefined][] = [];
  readonly conversations: [ChatMessage[], ConversationOptions | undefined][] = [];
  /** The `AbortSignal` each call was handed, so signal wiring is assertable. */
  readonly signals: (AbortSignal | undefined)[] = [];

  async search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResults> {
    this.searches.push([query, options]);
    this.signals.push(signal);
    if (this.searchError) throw this.searchError;
    return { query, results: [...this.searchResults], total: this.searchResults.length };
  }

  async add(text: string, options?: AddOptions, signal?: AbortSignal): Promise<MemoryCreated> {
    this.adds.push([text, options]);
    this.signals.push(signal);
    if (this.addError) throw this.addError;
    return this.created;
  }

  async addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
    signal?: AbortSignal,
  ): Promise<ConversationResult> {
    this.conversations.push([[...messages], options]);
    this.signals.push(signal);
    if (this.conversationError) throw this.conversationError;
    return this.conversation;
  }
}

/** A fake whose `search` never resolves on its own — only the signal ends it. */
export class HangingCortadel extends FakeCortadel {
  override async search(
    query: string,
    options?: SearchOptions,
    signal?: AbortSignal,
  ): Promise<SearchResults> {
    this.searches.push([query, options]);
    this.signals.push(signal);
    return new Promise<SearchResults>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(signal.reason);
      });
    });
  }
}

/**
 * A fake whose `addConversation` blocks until released, so a fire-and-forget
 * write is observably still in flight when the hook returns.
 */
export class GatedCortadel extends FakeCortadel {
  private resolveGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.resolveGate = resolve;
  });

  release(): void {
    this.resolveGate();
  }

  override async addConversation(
    messages: ChatMessage[],
    options?: ConversationOptions,
    signal?: AbortSignal,
  ): Promise<ConversationResult> {
    await this.gate;
    return super.addConversation(messages, options, signal);
  }
}

export function hit(id: string, content: string, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    id,
    content,
    isGlobal: false,
    rrfScore: 0.5,
    createdAt: "2026-08-13T09:00:00Z",
    ...extra,
  };
}

// ── Driving the real in-process MCP server ──────────────────────────────────

interface McpTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: {
    type: string;
    required?: string[];
    properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
  };
}

/** Connect an in-memory MCP client to the memory's own SDK server. */
export async function connect(memory: CortadelMemory): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cortadel-tests", version: "0.0.0" }, { capabilities: {} });
  await memory.mcpServer.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** The tool list the SDK MCP server actually advertises. */
export async function listTools(memory: CortadelMemory): Promise<McpTool[]> {
  const client = await connect(memory);
  try {
    const listed = await client.listTools();
    return listed.tools as unknown as McpTool[];
  } finally {
    await client.close();
  }
}

export interface ToolCallResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** Invoke a tool through the server, so JSON Schema validation and error marshalling run. */
export async function callTool(
  memory: CortadelMemory,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const client = await connect(memory);
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
  } finally {
    await client.close();
  }
}

export function toolText(result: ToolCallResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

// ── Hook inputs and transcripts ─────────────────────────────────────────────

/** The third argument every `HookCallback` receives. */
export function hookContext(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

export function promptInput(prompt: string, sessionId: string = SESSION_ID): UserPromptSubmitHookInput {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    transcript_path: join(tmpdir(), "cortadel-does-not-exist.jsonl"),
    cwd: CWD,
    prompt,
  };
}

/**
 * A `StopHookInput`. Note it carries no user message — that is why the `Stop`
 * hook has to read the transcript back.
 */
export function stopInput(
  transcriptPath: string,
  extra: Partial<StopHookInput> = {},
): StopHookInput {
  return {
    hook_event_name: "Stop",
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
    cwd: CWD,
    stop_hook_active: false,
    ...extra,
  };
}

let transcriptCounter = 0;

/** Write a JSONL transcript into a fresh temp directory and return its path. */
export async function writeTranscript(entries: Record<string, unknown>[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cortadel-cas-"));
  const path = join(directory, `session-${(transcriptCounter += 1)}.jsonl`);
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
}

export function userEntry(
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "user", uuid: "u-1", message: { role: "user", content: text }, ...extra };
}

export function assistantEntry(
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: "a-1",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  };
}
