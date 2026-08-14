/**
 * Cortadel long-term memory wired into the Claude Agent SDK's two native seams.
 *
 * There is one object, {@link CortadelMemory}, and it produces both halves of an
 * integration:
 *
 * * **Tools** — `search_memory` and `add_memories`, defined with the SDK's
 *   `tool()` helper and packaged by `createSdkMcpServer()` into an *in-process*
 *   MCP server (no subprocess, no IPC). Referenced as
 *   `mcp__<serverName>__<toolName>`: the key under `Options.mcpServers` becomes
 *   the `{server_name}` segment of each tool's fully qualified name.
 * * **Automatic memory** — two `HookCallback`s registered through
 *   `Options.hooks`: a `UserPromptSubmit` hook that searches Cortadel and
 *   injects the hits as `hookSpecificOutput.additionalContext`, and a `Stop`
 *   hook that persists the finished turn through `addConversation`.
 *
 * Design notes worth knowing before you read the code:
 *
 * * **A Cortadel client is bound to one user id at construction** — no Cortadel
 *   method takes a user id. So per-user scoping here means *one
 *   `CortadelMemory` per user*, not a user id threaded through hooks. This also
 *   matches the agent SDK, whose `BaseHookInput` carries `session_id`/`cwd` but
 *   no user identity at all. Session and project scoping *are* per-call, and
 *   are taken from the hook input (`session_id` → `ConversationOptions.sessionId`,
 *   basename of `cwd` → `project`).
 * * **Memory degrades, it never breaks the agent.** Every hook is total — a
 *   dead Cortadel server, a timeout, or a malformed response yields an empty
 *   hook result and the turn proceeds untouched. That is `throwOnError: false`,
 *   the default; flip it to `true` and a memory failure propagates out of the
 *   hook instead. Either way an `onError` callback, if you pass one, sees the
 *   error. Tool handlers surface failures to the model as `isError` results
 *   instead of throwing. Configuration errors are the deliberate exception: a
 *   bad `baseUrl` throws at construction, where you can see it, rather than
 *   silently disabling memory later.
 */

import { basename } from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  McpSdkServerConfigWithInstance,
  Options,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { CortadelClient, CortadelError } from "@cortadel/sdk";
import type { ChatMessage, ConversationOptions, SearchHit, SearchResults } from "@cortadel/sdk";
import { z } from "zod";

import { formatHits, truncate } from "./format.js";
import { lastExchange } from "./transcript.js";
import type { Exchange, TranscriptReaders } from "./transcript.js";
import {
  DEFAULT_APP_NAME,
  DEFAULT_SERVER_NAME,
  type CortadelMemoryClient,
  type CortadelMemoryClientOptions,
  type CortadelMemoryInit,
  type CortadelMemoryTuning,
} from "./types.js";

/**
 * Slack added to our own budget when setting `HookCallbackMatcher.timeout`, so
 * the CLI-side timeout never fires before ours does. That field is in
 * **seconds** ("Timeout in seconds for all hooks in this matcher").
 */
const HOOK_TIMEOUT_MARGIN_SECONDS = 5;

const MAX_TRACKED_SESSIONS = 32;
const MAX_SEEN_PER_SESSION = 512;

/** Longest prompt slice used as a search query. */
const MAX_QUERY_CHARS = 4000;

/**
 * What a tool handler hands back to the MCP layer; structurally a `CallToolResult`.
 *
 * The index signature is load-bearing: `CallToolResult` is a passthrough zod
 * object, so its inferred type carries `[x: string]: unknown` and a plain
 * closed interface is not assignable to it.
 */
interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * `isError` is **camelCase** on the TypeScript MCP surface (`CallToolResult` in
 * `@modelcontextprotocol/sdk/types.js`), unlike the Python SDK's `is_error`.
 */
function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** A message the model can act on. `CortadelError` carries a status and a machine code. */
function describe(error: unknown): string {
  if (error instanceof CortadelError) {
    return `${error.code} (HTTP ${error.status}): ${error.message}`;
  }
  // Read `name` without `instanceof`: an aborted fetch rejects with a
  // `DOMException`, which does not extend `Error` in every runtime.
  const name =
    typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : "";
  if (name === "TimeoutError") return "the request timed out";
  if (name === "AbortError") return "the request was aborted";
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Options for {@link CortadelMemory.apply}. */
export interface ApplyOptions {
  /** Wire the in-process MCP server and pre-approve its tools. @defaultValue `true` */
  tools?: boolean;
  /** Wire the `UserPromptSubmit` and `Stop` hooks. @defaultValue `true` */
  autoMemory?: boolean;
}

/**
 * Cortadel memory for one user, exposed as Claude Agent SDK tools and hooks.
 *
 * Typical use is one line of wiring:
 *
 * ```ts
 * const memory = new CortadelMemory({ baseUrl: "http://localhost:3001", userId: "e2e-alice" });
 * const options = memory.apply({ model: "claude-sonnet-4-5" });
 * ```
 *
 * {@link apply} merges the MCP server, the allowed-tool names and both hooks
 * into an existing `Options` object (it never mutates the one you pass — it
 * returns a copy). {@link mcpServer}, {@link allowedTools}, {@link tools} and
 * {@link hooks} are public if you would rather wire them yourself.
 */
export class CortadelMemory {
  private readonly client: CortadelMemoryClient;
  private readonly appName: string;
  private readonly serverName: string;
  private readonly project?: string;
  private readonly tags: string[];
  private readonly topK: number;
  private readonly rerank?: string;
  private readonly scopeRecallToSession: boolean;
  private readonly minPromptChars: number;
  private readonly maxContextChars: number;
  private readonly captureMaxChars: number;
  private readonly recallTimeoutMs: number;
  private readonly captureTimeoutMs: number;
  private readonly awaitPersist: boolean;
  private readonly dedupeInjections: boolean;
  private readonly isAgentMemory: boolean;
  private readonly throwOnError: boolean;
  private readonly onError?: (error: unknown) => void;

  /** Which memory ids each session has already been shown, oldest-first per session. */
  private readonly seen = new Map<string, Set<string>>();
  /** The last prompt each session submitted — the `Stop` hook's last-resort user turn. */
  private readonly lastPrompts = new Map<string, string>();
  /** In-flight fire-and-forget writes, drained by {@link flush}. */
  private readonly pending = new Set<Promise<void>>();

  /**
   * The two tool definitions, for adding to an MCP server of your own.
   *
   * Built once per instance, so the definitions are referentially stable and
   * {@link mcpServer} and a server you build yourself carry the same handlers.
   */
  readonly tools: SdkMcpToolDefinition<any>[] = this.buildTools();

  private server?: McpSdkServerConfigWithInstance;

  /**
   * How the `Stop` hook reads a transcript back.
   *
   * Left undefined in production, where {@link lastExchange} uses its two real
   * readers; tests substitute their own so no session store is touched.
   * @internal
   */
  transcriptReaders?: TranscriptReaders;

  /**
   * Wire Cortadel memory for one user.
   *
   * Pass `baseUrl`/`userId` to have a `CortadelClient` built for you, or
   * `client` to supply one you already own (shared, wrapped, or a test double).
   *
   * A client built here is built eagerly and not lazily: `CortadelClient`
   * validates `baseUrl`/`userId` in its constructor and throws. Because every
   * hook below fails open, deferring that validation would turn a typo'd URL
   * into memory that silently never works.
   */
  constructor(options: CortadelMemoryInit) {
    this.client =
      "client" in options
        ? options.client
        : new CortadelClient({
            baseUrl: options.baseUrl,
            userId: options.userId,
            apiKey: options.apiKey,
            appName: options.appName ?? DEFAULT_APP_NAME,
          });
    this.appName = options.appName ?? DEFAULT_APP_NAME;
    this.serverName = options.serverName ?? DEFAULT_SERVER_NAME;
    this.project = options.project;
    this.tags = [...(options.tags ?? ["claude-agent-sdk"])];
    this.topK = options.topK ?? 5;
    this.rerank = options.rerank;
    this.scopeRecallToSession = options.scopeRecallToSession ?? false;
    this.minPromptChars = options.minPromptChars ?? 10;
    this.maxContextChars = options.maxContextChars ?? 4000;
    this.captureMaxChars = options.captureMaxChars ?? 16000;
    this.recallTimeoutMs = options.recallTimeoutMs ?? 10_000;
    this.captureTimeoutMs = options.captureTimeoutMs ?? 60_000;
    this.awaitPersist = options.awaitPersist ?? true;
    this.dedupeInjections = options.dedupeInjections ?? true;
    this.isAgentMemory = options.isAgentMemory ?? false;
    this.throwOnError = options.throwOnError ?? false;
    this.onError = options.onError;
  }

  /**
   * Build on a Cortadel client you already own.
   *
   * Use this to share one client with the rest of your application, to wrap it
   * for retries or metrics, or to inject a fake in tests. Sugar for
   * `new CortadelMemory({ client, ...tuning })`.
   */
  static fromClient(client: CortadelMemoryClient, tuning: CortadelMemoryTuning = {}): CortadelMemory {
    const options: CortadelMemoryClientOptions = { ...tuning, client };
    return new CortadelMemory(options);
  }

  /**
   * Build from the same environment variables the `cortadel-memory` plugin reads.
   *
   * `CORTADEL_URL` and `CORTADEL_USER_ID` are required; `CORTADEL_API_KEY` and
   * `CORTADEL_CLIENT_NAME` (which becomes `appName`) are optional. Explicit
   * options win over the environment.
   */
  static fromEnv(tuning: CortadelMemoryTuning = {}, env: NodeJS.ProcessEnv = process.env): CortadelMemory {
    const baseUrl = (env.CORTADEL_URL ?? "").trim();
    const userId = (env.CORTADEL_USER_ID ?? "").trim();
    const missing = [
      ...(baseUrl ? [] : ["CORTADEL_URL"]),
      ...(userId ? [] : ["CORTADEL_USER_ID"]),
    ];
    if (missing.length > 0) {
      throw new Error(`CortadelMemory.fromEnv() needs ${missing.join(" and ")} to be set.`);
    }
    const clientName = (env.CORTADEL_CLIENT_NAME ?? "").trim();
    return new CortadelMemory({
      appName: clientName || undefined,
      ...tuning,
      baseUrl,
      userId,
      apiKey: env.CORTADEL_API_KEY || undefined,
    });
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /** The in-process MCP server carrying the memory tools. Built once, then cached. */
  get mcpServer(): McpSdkServerConfigWithInstance {
    this.server ??= createSdkMcpServer({
      name: this.serverName,
      version: "0.1.0",
      tools: this.tools,
    });
    return this.server;
  }

  /** Fully qualified tool names to pre-approve, e.g. `["mcp__cortadel__search_memory", …]`. */
  get allowedTools(): string[] {
    return [`mcp__${this.serverName}__search_memory`, `mcp__${this.serverName}__add_memories`];
  }

  /**
   * The automatic-memory hooks, shaped for `Options.hooks`.
   *
   * `matcher` is left unset on both: it filters by *tool name*, which is
   * meaningless for `UserPromptSubmit`/`Stop`. Each matcher's `timeout` (in
   * seconds) is set a little above our own budget so the CLI-side timeout never
   * pre-empts our own graceful give-up.
   */
  hooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
      UserPromptSubmit: [
        {
          hooks: [this.onUserPromptSubmit],
          timeout: this.recallTimeoutMs / 1000 + HOOK_TIMEOUT_MARGIN_SECONDS,
        },
      ],
      Stop: [
        {
          hooks: [this.onStop],
          timeout: this.captureTimeoutMs / 1000 + HOOK_TIMEOUT_MARGIN_SECONDS,
        },
      ],
    };
  }

  /**
   * Return a copy of `options` with Cortadel wired in.
   *
   * Merges rather than overwrites: your own MCP servers, allowed tools and
   * hooks are all kept. Pass `{ tools: false }` for hooks-only (memory the
   * agent never has to think about) or `{ autoMemory: false }` for tools-only
   * (the agent decides when to remember).
   */
  apply(options: Options = {}, { tools = true, autoMemory = true }: ApplyOptions = {}): Options {
    const next: Options = { ...options };

    if (tools) {
      next.mcpServers = { ...options.mcpServers, [this.serverName]: this.mcpServer };
      const allowed = [...(options.allowedTools ?? [])];
      for (const name of this.allowedTools) {
        if (!allowed.includes(name)) allowed.push(name);
      }
      next.allowedTools = allowed;
    }

    if (autoMemory) {
      const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
      for (const [event, matchers] of Object.entries(options.hooks ?? {})) {
        merged[event as HookEvent] = [...(matchers ?? [])];
      }
      for (const [event, matchers] of Object.entries(this.hooks())) {
        merged[event as HookEvent] = [...(merged[event as HookEvent] ?? []), ...(matchers ?? [])];
      }
      next.hooks = merged;
    }

    return next;
  }

  /**
   * Wait for any fire-and-forget write to land.
   *
   * This is what makes `awaitPersist: false` safe to use: it is the one point
   * where a background `addConversation` is guaranteed to have finished. The
   * Cortadel TypeScript client holds no long-lived resource and has no
   * `close()`, so there is nothing else to release.
   */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      const inFlight = [...this.pending];
      await Promise.allSettled(inFlight);
      // Drop them here rather than trusting the `finally` handler to have run,
      // so a write enqueued *during* the drain cannot spin this loop forever.
      for (const write of inFlight) this.pending.delete(write);
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  private buildTools(): SdkMcpToolDefinition<any>[] {
    const search = tool(
      "search_memory",
      "Search this user's long-term Cortadel memory for facts relevant to a question. " +
        "Use it whenever the answer might depend on something established earlier, in this " +
        "session or a previous one.",
      {
        query: z.string().min(1).describe("What to recall, in natural language."),
        // Optional on purpose, so the model can lean on the configured default.
        top_k: z
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many memories to return, 1-50. Optional; defaults to the configured topK."),
      },
      async (args) => this.toolSearch(args),
      { annotations: { readOnlyHint: true } },
    );

    const add = tool(
      "add_memories",
      "Store a durable fact about this user in Cortadel so it is available in future " +
        "sessions. Store preferences, decisions and stable context — not transient chatter.",
      {
        text: z.string().min(1).describe("The fact to remember, written as a standalone statement."),
        memory_type: z
          .enum(["episodic", "semantic", "procedural"])
          .optional()
          .describe("Optional cognitive type. Omit to let Cortadel classify it."),
      },
      async (args) => this.toolAdd(args),
    );

    return [search, add];
  }

  /** @internal Exposed for tests that drive the handler without the MCP layer. */
  async toolSearch(args: { query?: string; top_k?: number }): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return toolError("search_memory needs a non-empty 'query'.");

    let results: SearchResults;
    try {
      results = await this.search(query, typeof args.top_k === "number" ? args.top_k : this.topK);
    } catch (error) {
      this.notify(error);
      return toolError(`Cortadel search failed: ${describe(error)}`);
    }

    const hits = results.results ?? [];
    if (hits.length === 0) return toolText(`No memories found for ${JSON.stringify(query)}.`);
    return toolText(formatHits(hits, this.maxContextChars).text);
  }

  /** @internal Exposed for tests that drive the handler without the MCP layer. */
  async toolAdd(args: { text?: string; memory_type?: string }): Promise<ToolResult> {
    const text = String(args.text ?? "").trim();
    if (!text) return toolError("add_memories needs non-empty 'text'.");

    try {
      const created = await this.client.add(text, {
        app: this.appName,
        memoryType: args.memory_type,
      });
      // A 2xx does not mean a new memory was written — `event` says what the
      // store pipeline actually did (ADD, SKIP_DUPLICATE, SUPERSEDE, …), and
      // the model should see that.
      return toolText(`Stored memory ${created.id} (event: ${created.event ?? "ADD"}).`);
    } catch (error) {
      this.notify(error);
      return toolError(`Cortadel write failed: ${describe(error)}`);
    }
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────

  /**
   * `UserPromptSubmit` hook: recall relevant memories and inject them into the turn.
   *
   * Returns `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
   * additionalContext: … } }`. `additionalContext` **must** be nested under
   * `hookSpecificOutput` — a top-level key is silently ignored
   * (`UserPromptSubmitHookSpecificOutput` in `sdk.d.ts`).
   *
   * Fails open: a recall failure yields `{}` and the prompt goes through
   * untouched, unless `throwOnError` is set.
   */
  readonly onUserPromptSubmit: HookCallback = async (input, _toolUseId, options) => {
    try {
      if (input.hook_event_name !== "UserPromptSubmit") return {};
      const sessionId = input.session_id ?? "";
      const prompt = (input.prompt ?? "").trim();

      // Recorded before the skip checks so the `Stop` hook's last-resort
      // pairing has a user turn even for prompts recall itself ignored.
      if (prompt) this.rememberPrompt(sessionId, prompt);

      if (prompt.length < this.minPromptChars) return {};
      // Slash commands and shell passthrough are not memory-worthy queries.
      if (prompt.startsWith("/") || prompt.startsWith("!")) return {};

      const results = await this.search(
        prompt.slice(0, MAX_QUERY_CHARS),
        this.topK,
        this.scopeRecallToSession ? sessionId : undefined,
        options?.signal,
      );

      const unseen = (results.results ?? []).filter((hit) => !this.alreadyInjected(sessionId, hit.id));
      if (unseen.length === 0) return {};

      const block = formatHits(unseen, this.maxContextChars);
      if (block.injected.length === 0) return {};
      this.markInjected(sessionId, block.injected);

      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `## Relevant Cortadel memories\n${block.text}`,
        },
        suppressOutput: true,
      };
    } catch (error) {
      this.fail(error, "recall"); // memory degrades; it never blocks a prompt
      return {};
    }
  };

  /**
   * `Stop` hook: persist the finished turn through `addConversation`.
   *
   * Cortadel distils durable facts from the exchange server-side, so the whole
   * turn is handed over rather than something pre-summarised here. Returns an
   * empty result in every case — this hook exists for its side effect and must
   * never block the end of a turn.
   *
   * The write is awaited by default (`awaitPersist: true`); see
   * {@link CortadelMemoryTuning.awaitPersist} for why fire-and-forget is not the
   * default at `Stop`.
   */
  readonly onStop: HookCallback = async (input) => {
    try {
      if (input.hook_event_name !== "Stop") return {};
      // Recursion guard: we are only here because a Stop hook already ran.
      if (input.stop_hook_active) return {};

      const sessionId = input.session_id ?? "";
      const cwd = input.cwd || undefined;
      const transcriptPath = input.transcript_path || undefined;

      const exchange =
        (await lastExchange({ sessionId, cwd, transcriptPath }, this.transcriptReaders)) ??
        this.exchangeFromHookInput(sessionId, input.last_assistant_message);
      if (!exchange) return {};

      const messages = this.toChatMessages(exchange);
      if (!messages) return {};

      const conversationOptions: ConversationOptions = {
        isAgentMemory: this.isAgentMemory,
        tags: this.tags.length > 0 ? [...this.tags] : undefined,
        project: this.project ?? (cwd ? basename(cwd) : undefined),
        sessionId: sessionId || undefined,
        transcriptPath,
      };

      if (this.awaitPersist) {
        await this.persist(messages, conversationOptions);
      } else {
        this.spawn(this.persist(messages, conversationOptions));
      }
    } catch (error) {
      this.fail(error, "capture"); // a failed capture must not break the turn
    }
    return {};
  };

  // ── Internals ─────────────────────────────────────────────────────────────

  private async search(
    query: string,
    topK: number,
    sessionId?: string,
    hookSignal?: AbortSignal,
  ): Promise<SearchResults> {
    const timeout = AbortSignal.timeout(this.recallTimeoutMs);
    // Composed with the hook's own signal: if the turn is cancelled the recall
    // it was for is worthless, so it should stop too.
    const signal = hookSignal ? AbortSignal.any([timeout, hookSignal]) : timeout;
    return this.client.search(
      query,
      {
        topK: Math.max(1, Math.min(50, Math.trunc(topK))),
        mode: "hybrid",
        rerank: this.rerank,
        sessionId,
      },
      signal,
    );
  }

  private async persist(messages: ChatMessage[], options: ConversationOptions): Promise<void> {
    // Deliberately *not* composed with the hook's signal, unlike recall: `Stop`
    // fires as the turn winds down, and letting a closing query cancel this
    // write is exactly the memory loss `awaitPersist` exists to prevent.
    await this.client.addConversation(messages, options, AbortSignal.timeout(this.captureTimeoutMs));
  }

  /** Run a write in the background, holding a reference until it settles. */
  private spawn(write: Promise<void>): void {
    // `.catch` first: a background write's failure can only be observed, never
    // rethrown — the hook that started it returned long ago, so `throwOnError`
    // has nowhere to throw into.
    const tracked = write.catch((error: unknown) => {
      this.report(error, "background capture");
    });
    this.pending.add(tracked);
    void tracked.finally(() => {
      this.pending.delete(tracked);
    });
  }

  /** Route a hook failure: observe it, then swallow or rethrow per `throwOnError`. */
  private fail(error: unknown, what: string): void {
    if (!this.throwOnError) {
      this.report(error, what);
      return;
    }
    this.notify(error);
    throw error;
  }

  /** Hand the error to `onError`, if there is one. Never throws. */
  private notify(error: unknown): void {
    if (!this.onError) return;
    try {
      this.onError(error);
    } catch (callbackError) {
      // An observer must not break what it observes.
      console.warn("Cortadel onError callback threw:", callbackError);
    }
  }

  /** A swallowed failure: the callback sees it, or the console does. */
  private report(error: unknown, what: string): void {
    if (this.onError) {
      this.notify(error);
    } else {
      console.warn(`Cortadel ${what} failed: ${describe(error)}`);
    }
  }

  /**
   * Last-resort exchange, when neither transcript reader produced one.
   *
   * `StopHookInput.last_assistant_message` is documented as avoiding the
   * transcript read for the assistant side; pairing it with the prompt this
   * session last submitted keeps capture working when the transcript is
   * unreadable or lives in a remote session store. No uuids are available on
   * this path, so the stored facts carry no pointer anchor.
   */
  private exchangeFromHookInput(sessionId: string, lastAssistantMessage?: string): Exchange | undefined {
    const assistantText = (lastAssistantMessage ?? "").trim();
    const userText = (this.lastPrompts.get(sessionId) ?? "").trim();
    if (!assistantText || !userText) return undefined;
    return {
      user: { role: "user", text: userText },
      assistant: { role: "assistant", text: assistantText },
    };
  }

  /** The exchange as Cortadel chat messages, or `undefined` if it is too thin to store. */
  private toChatMessages(exchange: Exchange): ChatMessage[] | undefined {
    const userBudget = Math.min(4000, this.captureMaxChars);
    const userText = truncate(exchange.user.text, userBudget);
    const assistantText = truncate(exchange.assistant.text, Math.max(0, this.captureMaxChars - userBudget));
    // Tool-only or one-word exchanges yield no durable facts.
    if (!userText || !assistantText || userText.length + assistantText.length < 80) return undefined;
    return [
      { role: "user", content: userText, uuid: exchange.user.uuid },
      { role: "assistant", content: assistantText, uuid: exchange.assistant.uuid },
    ];
  }

  private rememberPrompt(sessionId: string, prompt: string): void {
    this.lastPrompts.delete(sessionId);
    this.lastPrompts.set(sessionId, prompt.slice(0, this.captureMaxChars));
    while (this.lastPrompts.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.lastPrompts.keys().next();
      if (oldest.done) break;
      this.lastPrompts.delete(oldest.value);
    }
  }

  private alreadyInjected(sessionId: string, memoryId: string): boolean {
    if (!this.dedupeInjections) return false;
    return this.seen.get(sessionId)?.has(memoryId) ?? false;
  }

  /**
   * Record what this session has already been shown, under a bounded budget.
   *
   * Both the session table and each session's id set are capped and evict
   * oldest-first, so a long-lived process cannot grow this without limit.
   */
  private markInjected(sessionId: string, hits: readonly SearchHit[]): void {
    if (!this.dedupeInjections) return;
    let seen = this.seen.get(sessionId);
    if (seen) {
      this.seen.delete(sessionId); // refresh this session's LRU position
    } else {
      seen = new Set<string>();
    }
    this.seen.set(sessionId, seen);

    for (const hit of hits) {
      seen.delete(hit.id); // re-inserting moves a hot id to the end
      seen.add(hit.id);
    }
    while (seen.size > MAX_SEEN_PER_SESSION) {
      const oldest = seen.values().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
    while (this.seen.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}
