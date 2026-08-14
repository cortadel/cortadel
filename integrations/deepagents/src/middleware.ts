/**
 * `createCortadelMemoryMiddleware` — automatic long-term memory for a deep agent.
 *
 * DeepAgents is assembled entirely out of middleware: `createDeepAgent` stacks its filesystem,
 * subagent, summarization and memory middleware, and `middleware: [...]`
 * (`CreateDeepAgentParams.middleware`, `deepagents/dist/agent-*.d.ts`) is the one seam it gives you
 * to add your own. Its *own* long-term memory feature — `createMemoryMiddleware` in
 * `deepagents/src/middleware/memory.ts` — is an `AgentMiddleware` that loads `AGENTS.md` files in
 * `beforeAgent` and injects them into the system message from `wrapModelCall`. This factory is the
 * same shape, with Cortadel's hybrid search standing in for a static file read, plus the write half
 * that a file-backed memory cannot do on its own.
 *
 * Lifecycle, mapped onto the three hooks LangChain's `AgentMiddleware`
 * (`langchain/dist/agents/middleware/types.d.ts`) actually gives us:
 *
 * | Hook             | Runs             | What we do                                             |
 * |------------------|------------------|--------------------------------------------------------|
 * | `beforeAgent`    | once per turn    | hybrid-search Cortadel for the new user message        |
 * | `wrapModelCall`  | every model call | inject the recalled block into the system message      |
 * | `afterAgent`     | once per turn    | `addConversation` the messages added during this turn  |
 *
 * Putting retrieval in `beforeAgent` (not `beforeModel`) is the point: a deep agent makes many
 * model calls per turn — planning, tool loops, subagent dispatch — and one search per *turn* is
 * correct, whereas one search per *model call* would multiply latency and cost by the length of
 * the loop for no new information. The recalled set lives in private state, and `wrapModelCall`
 * re-renders it into the system message on every call, so it is present for the whole loop without
 * being re-fetched, and without ever accumulating: the injection is applied to a per-call copy of
 * the `ModelRequest`, never written back into the conversation.
 */

import { createMiddleware } from "langchain";
import { z } from "zod";
import type { ConversationOptions, SearchOptions } from "@cortadel/sdk";

import {
  ClientProvider,
  toRunScope,
  type CortadelConnectionOptions,
  type CortadelMemoryClient,
  type RunScope,
} from "./client.js";
import { reportFailure } from "./errors.js";
import {
  CORTADEL_SYSTEM_PROMPT,
  appendToSystemMessage,
  fillSystemPrompt,
  hitToRecalled,
  recalledMemorySchema,
  validateSystemPrompt,
} from "./format.js";
import { latestUserText, toChatMessages } from "./messages.js";
import {
  createCortadelTools,
  type CortadelErrorOptions,
  type CortadelSearchOptions,
} from "./tools.js";

/**
 * State added by the middleware.
 *
 * Every key is `_`-prefixed, which is how LangChain marks middleware state private: `AgentMiddleware`'s
 * `FilterPrivateProps<T>` (`langchain/dist/agents/middleware/types.d.ts`) strips keys matching
 * `` `_${string}` `` out of the agent's inferred input/output state. The values are still
 * checkpointed — so they survive across turns on a thread — but they stay out of the agent's public
 * schema. This is the JS analogue of the Python leg's `PrivateStateAttr`.
 */
export const cortadelMemoryStateSchema = z.object({
  /** Memories recalled for the current turn, rendered into the system message. */
  _cortadelMemories: z.array(recalledMemorySchema).optional(),
  /**
   * The query the current `_cortadelMemories` were recalled for.
   *
   * Guards against re-searching on a resumed run: a deep agent that interrupts for human approval
   * re-enters `beforeAgent` with the same last human message, and repeating the search would cost
   * a round trip to return the same hits.
   */
  _cortadelRecallQuery: z.string().optional(),
  /**
   * How many messages have already been written to Cortadel.
   *
   * Only the suffix after this index is sent on the next `afterAgent`, so a long-lived thread
   * never re-ingests its own history.
   */
  _cortadelPersistedCount: z.number().optional(),
});

export type CortadelMemoryState = z.infer<typeof cortadelMemoryStateSchema>;

/**
 * Build the middleware's `contextSchema` — the declaration that makes `runtime.context[userIdKey]`
 * exist at all.
 *
 * This is the one place where LangChain JS diverges hard from LangGraph Python, and it is easy to
 * port straight past. In Python, `Runtime.context` **is** the run's context object, so reading
 * `runtime.context.user_id` needs no declaration. In JS, `MiddlewareNode.invokeMiddleware`
 * (`langchain/dist/agents/nodes/middleware.js`) builds a *fresh* object per hook call:
 *
 * ```js
 * let filteredContext = {};
 * if (this.middleware.contextSchema && isInteropZodObject(this.middleware.contextSchema)) {
 *   const schemaShape = getInteropZodObjectShape(this.middleware.contextSchema);
 *   const invokeContext = config?.context || {};
 *   for (const key of Object.keys(schemaShape)) if (key in invokeContext) relevantContext[key] = ...
 * }
 * ```
 *
 * A middleware with no `contextSchema` therefore gets a frozen **empty** `runtime.context` on every
 * `beforeAgent`/`afterAgent` — so `agent.invoke(input, { context: { user_id } })` silently resolved
 * no user and disabled automatic memory, while the tools (which go through `ToolNode`, where the raw
 * run config survives) kept working. Declaring the key opts this middleware into receiving it.
 *
 * Two deliberate choices:
 *
 * - **The key is the caller's `userIdKey`**, read off the provider (a shared `provider` carries its
 *   own key, and that is the key `ClientProvider.forRun` will look up). A hardcoded `"user_id"`
 *   would leave every custom-key deployment broken in exactly the same way.
 * - **The value is `z.unknown().optional()`, not `z.string().optional()`.** The schema is parsed on
 *   every hook call — and again in `AgentNode` for `wrapModelCall` — so a stricter schema turns a
 *   host that passes, say, a numeric `user_id` into a thrown `ZodError` from inside the agent graph.
 *   Memory is an enhancement, never a dependency: a bad id must degrade to "no memory this run"
 *   (which `ClientProvider` already does, since `resolveUserId` accepts only a non-empty string),
 *   never take the agent down. `unknown` also cannot collide with a host agent that declares the
 *   same key in its own `contextSchema`: `InferAgentContext` intersects the agent's context with its
 *   middlewares', and `T & unknown` is `T` for every `T`, whereas `number & string` would be `never`.
 */
function userIdContextSchema(userIdKey: string) {
  return z.object({ [userIdKey]: z.unknown().optional() });
}

export interface CortadelMemoryMiddlewareOptions
  extends CortadelConnectionOptions,
    CortadelSearchOptions,
    CortadelErrorOptions {
  /**
   * Memories recalled automatically per turn (Cortadel accepts 1–50). The `search_memory` tool
   * carries its own `topK`, defaulting to 10.
   *
   * @default 5
   */
  topK?: number;
  /**
   * Pass the LangGraph `thread_id` as Cortadel's `sessionId` on *search*, restricting recall to
   * memories from this thread (a LangGraph thread is the session here). Off by default: the point
   * of long-term memory is that it crosses threads.
   *
   * @default false
   */
  scopeRecallToSession?: boolean;
  /**
   * Persist each turn with `addConversation` in `afterAgent`. Set `false` for a read-only agent.
   *
   * @default true
   */
  writeMemories?: boolean;
  /**
   * Await the write before the hook returns.
   *
   * Defaults to `true`, against the house default of fire-and-forget, because `afterAgent` is the
   * last node of the run: a detached write can be cut off when the run (or the process) ends, and
   * the persisted-count cursor could not then be advanced honestly. Set `false` to trade that
   * guarantee for latency — a detached write cannot be retried, and `throwOnError` cannot apply to
   * it (there is no caller left to throw to), though `onError` still observes it.
   *
   * @default true
   */
  awaitPersist?: boolean;
  /**
   * Extract facts about the *assistant* rather than the user. Use for an agent that should
   * accumulate its own operating knowledge.
   *
   * @default false
   */
  isAgentMemory?: boolean;
  /** Tags applied to every fact extracted from this agent's conversations. */
  tags?: string[];
  /** Cortadel project scope for extracted facts (e.g. a repo name). */
  project?: string;
  /**
   * Also register the `search_memory` / `add_memories` tools on this middleware, so the agent can
   * query and write memory itself.
   *
   * @default true
   */
  exposeTools?: boolean;
  /**
   * Prompt fragment injected into the system message. Must contain the `{cortadelMemories}` slot.
   * Pass `null` to recall into state without injecting (useful if you render the block yourself).
   *
   * @default CORTADEL_SYSTEM_PROMPT
   */
  systemPrompt?: string | null;
  /**
   * An existing {@link ClientProvider} to share with separately-created tools, so both reuse one
   * per-user client cache. When given, the connection options above are ignored.
   */
  provider?: ClientProvider;
}

/**
 * Give a deep agent Cortadel long-term memory: automatic recall, automatic persistence, tools.
 *
 * ```ts
 * import { createDeepAgent } from "deepagents";
 * import { createCortadelMemoryMiddleware } from "@cortadel/deepagents";
 *
 * const agent = createDeepAgent({
 *   model: "anthropic:claude-sonnet-4-5",
 *   middleware: [
 *     createCortadelMemoryMiddleware({
 *       baseUrl: "http://localhost:3001",
 *       userId: "e2e-demo-user",
 *     }),
 *   ],
 * });
 * ```
 *
 * Cortadel clients are bound to one user id at construction, so multi-user agents resolve the id
 * per run from `runtime.context.user_id` or `runtime.configurable.user_id` and get a cached client
 * per user. See the README's "Per-user scoping" section.
 *
 * @throws `TypeError` when `systemPrompt` is neither a string nor `null`.
 * @throws `Error` when `systemPrompt` is a string missing the `{cortadelMemories}` slot.
 */
export function createCortadelMemoryMiddleware(options: CortadelMemoryMiddlewareOptions = {}) {
  const {
    topK = 5,
    searchMode = "hybrid",
    rerank = false,
    memoryType,
    scopeRecallToSession = false,
    writeMemories = true,
    awaitPersist = true,
    isAgentMemory = false,
    tags,
    project,
    exposeTools = true,
    throwOnError,
    onError,
  } = options;

  const systemPrompt = validateSystemPrompt(
    options.systemPrompt === undefined ? CORTADEL_SYSTEM_PROMPT : options.systemPrompt,
  );
  const provider = options.provider ?? new ClientProvider(options);
  const tools = exposeTools
    ? createCortadelTools({ provider, searchMode, rerank, memoryType, throwOnError, onError })
    : [];

  const searchOptions = (threadId: string | undefined): SearchOptions => ({
    topK,
    mode: searchMode,
    ...(rerank ? { rerank: "cross_encoder" } : {}),
    ...(memoryType ? { memoryType } : {}),
    // A LangGraph thread is the session Cortadel scopes to.
    ...(scopeRecallToSession && threadId ? { sessionId: threadId } : {}),
  });

  const conversationOptions = (threadId: string | undefined): ConversationOptions => ({
    isAgentMemory,
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(project ? { project } : {}),
    ...(threadId ? { sessionId: threadId } : {}),
  });

  const clientFor = (
    runtime: unknown,
  ): { client: CortadelMemoryClient; scope: RunScope } | undefined => {
    const scope = toRunScope(runtime);
    const client = provider.forRun(scope);
    return client ? { client, scope } : undefined;
  };

  return createMiddleware({
    name: "CortadelMemoryMiddleware",
    stateSchema: cortadelMemoryStateSchema,
    // Without this the hooks below never see `runtime.context[userIdKey]`. See
    // `userIdContextSchema` for why, and why the value is `unknown`.
    contextSchema: userIdContextSchema(provider.userIdKey),
    tools,

    /** Recall memories relevant to this turn's user message. */
    async beforeAgent(state, runtime) {
      const query = latestUserText(state.messages);
      if (!query) return;
      // Already recalled for this exact message (e.g. a run resumed after an interrupt).
      if (state._cortadelRecallQuery === query) return;

      const resolved = clientFor(runtime);
      if (!resolved) return;

      try {
        const results = await resolved.client.search(
          query,
          searchOptions(resolved.scope.configurable?.thread_id as string | undefined),
          resolved.scope.signal,
        );
        return {
          _cortadelMemories: results.results.map(hitToRecalled),
          _cortadelRecallQuery: query,
        };
      } catch (error) {
        reportFailure("recall", error, { throwOnError, onError });
        return;
      }
    },

    /** Inject the recalled memories into the system message for this model call. */
    wrapModelCall(request, handler) {
      if (!systemPrompt) return handler(request);
      const block = fillSystemPrompt(systemPrompt, request.state?._cortadelMemories);
      return handler({
        ...request,
        systemMessage: appendToSystemMessage(request.systemMessage, block),
      });
    },

    /** Persist the messages added during this turn via `addConversation`. */
    async afterAgent(state, runtime) {
      if (!writeMemories) return;

      const messages = state.messages ?? [];
      const already = state._cortadelPersistedCount ?? 0;
      if (already >= messages.length) return;

      const pending = toChatMessages(messages.slice(already));
      if (pending.length === 0) {
        // Nothing storable in the new suffix (tool traffic only). The cursor stays put, which is
        // harmless: those messages are non-storable and will be skipped again next turn, while any
        // genuinely new dialogue after them is still picked up.
        return;
      }

      const resolved = clientFor(runtime);
      if (!resolved) return;

      const threadId = resolved.scope.configurable?.thread_id as string | undefined;

      if (!awaitPersist) {
        // Deliberately no `signal`: a detached write must not be cancelled by the run tearing down
        // around it. `throwOnError` cannot apply here — there is no caller left to throw to.
        void resolved.client
          .addConversation(pending, conversationOptions(threadId))
          .catch((error: unknown) => {
            try {
              reportFailure("persist", error, { onError });
            } catch {
              // An observer's own bug must not surface as an unhandled rejection.
            }
          });
        return { _cortadelPersistedCount: messages.length };
      }

      try {
        await resolved.client.addConversation(
          pending,
          conversationOptions(threadId),
          resolved.scope.signal,
        );
      } catch (error) {
        reportFailure("persist", error, { throwOnError, onError });
        // The cursor is deliberately NOT advanced: a failed write should be retried with the next
        // turn's suffix rather than silently dropped.
        return;
      }

      return { _cortadelPersistedCount: messages.length };
    },
  });
}
