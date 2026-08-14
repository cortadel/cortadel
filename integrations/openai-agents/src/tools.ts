/**
 * Cortadel memory as Agents SDK function tools.
 *
 * These are for agents that should decide *when* to remember — "look that up in your memory",
 * "remember this for next time". For memory that just happens, without the agent asking, use
 * {@link CortadelSession} instead; the two compose fine.
 *
 * Built with the SDK's own tool primitive, `tool()` (`@openai/agents-core/dist/tool.d.ts`, line
 * 850), so the JSON schema is derived from the Zod object and the result is a real `FunctionTool`
 * — nothing to hand-wire. Zod v4 is what `@openai/agents@0.15.0` itself peer-requires
 * (`peerDependencies: { zod: "^4.0.0" }`), and `tool()` throws `UserError('Strict mode is
 * required for Zod parameters')` unless `strict` stays on, so these tools are strict.
 *
 * Both tools are bound to one user id, because a Cortadel client is: no method on the SDK takes a
 * user id. Build one toolset per user.
 */

import { tool, type Tool } from '@openai/agents';
import type { CortadelClient } from '@cortadel/sdk';
import { z } from 'zod';

import {
  DEFAULT_APP_NAME,
  buildClient,
  callSafely,
  filterHits,
  formatHitLines,
  type CortadelConnectionOptions,
  type ErrorOptions,
  type RecallOptions,
} from './memory.js';

const NO_RESULTS = 'No relevant memories found.';
const SEARCH_UNAVAILABLE = 'Memory is currently unavailable. Answer without it.';
const ADD_UNAVAILABLE = 'Memory is currently unavailable; nothing was stored.';

/** Options for {@link cortadelMemoryTools}. */
export interface CortadelMemoryToolsOptions
  extends CortadelConnectionOptions,
    RecallOptions,
    ErrorOptions {
  /** Memory namespace owner. Required unless `client` is given. */
  userId?: string;
  /**
   * A pre-built client, already scoped to the intended user. Mutually exclusive with `userId`;
   * the caller owns its lifecycle.
   */
  client?: CortadelClient;
  /**
   * Number of hits `search_memory` returns. Defaults to `10` — the Cortadel SDK's own
   * `SearchOptions` default. An agent that asked for memory deliberately can spend more context
   * on it than an automatic per-turn injection can.
   */
  topK?: number;
  /**
   * Restrict `search_memory` to facts from one conversation. Omit to search everything the user
   * has. {@link CortadelSession.tools} sets this when the session was built with
   * `scopeRecallToSession: true`.
   */
  sessionId?: string;
}

const searchMemoryParameters = z.object({
  query: z.string().describe('What to look for, phrased in natural language.'),
});

const addMemoriesParameters = z.object({
  text: z.string().describe('The fact to remember, as a single self-contained sentence.'),
});

/**
 * Build the `search_memory` and `add_memories` tools for one user.
 *
 * ```ts
 * const agent = new Agent({
 *   name: 'Assistant',
 *   instructions: 'Search your memory before answering personal questions.',
 *   tools: cortadelMemoryTools({ userId: 'e2e-alice', baseUrl: 'http://localhost:3001' }),
 * });
 * ```
 *
 * @returns `[search_memory, add_memories]` as real `FunctionTool`s.
 */
export function cortadelMemoryTools(options: CortadelMemoryToolsOptions = {}): Tool[] {
  const {
    userId,
    client,
    baseUrl,
    apiKey,
    appName = DEFAULT_APP_NAME,
    topK = 10,
    searchMode = 'hybrid',
    rerank,
    minScore,
    sessionId,
    throwOnError = false,
    onError,
  } = options;

  if (client && userId) {
    throw new Error(
      'Pass either userId or client, not both — a Cortadel client is already scoped to a user.',
    );
  }
  if (!client && !userId) {
    throw new Error('Pass either userId or a pre-built client.');
  }

  const bound =
    client ??
    buildClient(userId as string, {
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      appName,
    });

  // `tool()` installs a default `errorFunction` that converts any throw in the tool body into a
  // model-visible string. Passing `null` explicitly disables it, so the error propagates and
  // fails the run — which is what `throwOnError: true` asks for. Verified in
  // `@openai/agents-core/dist/tool.mjs`: `resolveToolFailure` does `if (!toolErrorFunction)
  // { throw error; }`, and the option is only defaulted when it is `undefined`.
  const errorFunction = throwOnError ? null : undefined;

  const searchMemory = tool({
    name: 'search_memory',
    description:
      "Search the user's long-term memory for facts relevant to a question. Use this before " +
      'answering anything that depends on who the user is, what they prefer, or what was ' +
      'decided in an earlier conversation.',
    parameters: searchMemoryParameters,
    errorFunction,
    execute: async ({ query }): Promise<string> => {
      const results = await callSafely(
        () =>
          bound.search(query, {
            topK,
            mode: searchMode,
            ...(rerank ? { rerank } : {}),
            ...(sessionId ? { sessionId } : {}),
          }),
        {
          description: 'search',
          throwOnError,
          fallback: undefined,
          ...(onError ? { onError } : {}),
        },
      );
      if (results === undefined) {
        return SEARCH_UNAVAILABLE;
      }
      return formatHitLines(filterHits(results.results, minScore)) || NO_RESULTS;
    },
  });

  const addMemories = tool({
    name: 'add_memories',
    description:
      'Store a durable fact about the user in long-term memory. Use this for stable ' +
      'preferences, decisions, and details worth recalling in a future conversation — not for ' +
      'passing chatter.',
    parameters: addMemoriesParameters,
    errorFunction,
    execute: async ({ text }): Promise<string> => {
      const created = await callSafely(() => bound.add(text, { app: appName }), {
        description: 'add',
        throwOnError,
        fallback: undefined,
        ...(onError ? { onError } : {}),
      });
      if (created === undefined) {
        return ADD_UNAVAILABLE;
      }

      // A successful call does not always mean a new memory: the write pipeline may have
      // deduplicated, superseded, or invalidated instead. Report what actually happened.
      if (created.event === 'SKIP_DUPLICATE') {
        return 'Already remembered; nothing new stored.';
      }
      if (created.event && created.event !== 'ADD') {
        return `Stored (event: ${created.event}).`;
      }
      return 'Stored.';
    },
  });

  return [searchMemory, addMemories];
}
