import { Type, type TSchema } from "typebox";
import type { AddOptions } from "@cortadel/sdk";
import type { CortadelGateway } from "./gateway.js";
import type { TurnIdentity } from "./types.js";
import { memoryPath } from "./corpus.js";

/**
 * Cortadel's two explicit agent tools.
 *
 * These complement — rather than duplicate — the corpus supplement in
 * `corpus.ts`. The supplement makes Cortadel reachable through OpenClaw's own
 * `memory_search`/`memory_get`; these named tools give the model an unambiguous
 * way to reach *Cortadel specifically*, and a write path, which the read-only
 * corpus seam has no equivalent for.
 *
 * Shapes match `AnyAgentTool` from the OpenClaw SDK: `parameters` is a TypeBox
 * schema, `label` is required, and `execute` resolves to `{ content, details }`.
 * `params` arrives type-erased at the `registerTool` boundary, so every field is
 * read defensively.
 */

/** Text content block, matching OpenClaw's `TextContent`. */
interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Structural mirror of the `AnyAgentTool` fields we set.
 *
 * Assignable to OpenClaw's `AnyAgentTool`: `parameters` is a real TypeBox
 * `TSchema`, `label` is present, and the result carries both `content` and the
 * required `details`.
 */
export interface CortadelAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<{ content: TextBlock[]; details: unknown }>;
}

const MEMORY_TYPES = ["episodic", "semantic", "procedural"] as const;

function text(body: string): TextBlock[] {
  return [{ type: "text", text: body }];
}

function record(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function readString(params: unknown, key: string): string | undefined {
  const value = record(params)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(params: unknown, key: string): number | undefined {
  const value = record(params)[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/**
 * Build both tools for one turn's identity.
 *
 * Registered through `registerTool`'s **factory** form rather than as static
 * objects. The factory is invoked with an `OpenClawPluginToolContext` carrying
 * that turn's `sessionKey`, `agentId`, and trusted `requesterSenderId`, which is
 * what lets non-`fixed` user scopes resolve correctly. A static tool would have
 * had to read the current turn from module state — unsafe in OpenClaw, which
 * runs many sessions concurrently and could route one user's memory write into
 * another user's namespace.
 */
export function createTools(gateway: CortadelGateway, identity: TurnIdentity): CortadelAgentTool[] {
  const searchMemory: CortadelAgentTool = {
    name: "cortadel_search_memory",
    label: "Search Cortadel memory",
    description:
      "Search Cortadel long-term memory for durable facts about the user, across every past conversation. " +
      "Use this when you need something you were not told in the current conversation.",
    parameters: Type.Object({
      query: Type.String({ description: "What to look for, phrased as a question or topic." }),
      // `topK`, not `limit`: Cortadel's own MCP `search_memory` names its result
      // cap `topK` and uses `limit` for something else entirely (browse page
      // size), so `limit` here would have meant the opposite of what a model
      // that has seen Cortadel's MCP surface expects.
      topK: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "Maximum memories to return. Omit to use the configured default." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const query = readString(params, "query");
      // Input faults throw, per the OpenClaw tool contract.
      if (!query) throw new Error("cortadel_search_memory requires a non-empty `query`.");

      const requestedTopK = readInt(params, "topK");
      const topK = Math.min(50, Math.max(1, requestedTopK ?? gateway.config.topK));
      const userId = gateway.userIdFor(identity);

      const outcome = await gateway.call(userId, "search_memory tool", (client, signal) =>
        client.search(query, { topK, mode: "hybrid", ...(gateway.config.rerank ? { rerank: "cross_encoder" } : {}) }, signal),
      );

      // An unreachable memory server is an expected degraded state, not a tool
      // fault, so it is reported in-band: the model can then answer without
      // memory instead of treating the turn as broken.
      if (!outcome.ok) {
        return {
          content: text(`Cortadel memory is unavailable right now (${outcome.message}). Answer without long-term memory.`),
          details: { ok: false, reason: outcome.reason, message: outcome.message, results: [] },
        };
      }

      const hits = outcome.value.results;
      if (hits.length === 0) {
        return { content: text(`No Cortadel memories matched "${query}".`), details: { ok: true, query, results: [] } };
      }

      const lines = hits.map((hit, i) => `${i + 1}. ${hit.content.replace(/\s+/g, " ").trim()}`);
      return {
        content: text(`Found ${hits.length} Cortadel ${hits.length === 1 ? "memory" : "memories"}:\n${lines.join("\n")}`),
        details: {
          ok: true,
          query,
          results: hits.map((hit) => ({
            id: hit.id,
            path: memoryPath(hit.id),
            content: hit.content,
            score: hit.rrfScore ?? null,
            memoryType: hit.memoryType ?? null,
            createdAt: hit.createdAt ?? null,
          })),
        },
      };
    },
  };

  // `cortadel_add_memories` — plural stem, matching Cortadel's own MCP tool
  // `add_memories`, with the `cortadel_` prefix OpenClaw requires of plugin
  // tools. One call can yield several stored facts, so the plural is also
  // literally true: the store pipeline may split, dedupe, or supersede.
  const addMemories: CortadelAgentTool = {
    name: "cortadel_add_memories",
    label: "Save to Cortadel memory",
    description:
      "Save a durable fact to Cortadel long-term memory so it is available in future conversations. " +
      "Use this for stable preferences, decisions, and facts about the user — not for transient chatter.",
    parameters: Type.Object({
      text: Type.String({ description: "The fact to remember, written as a standalone statement." }),
      memory_type: Type.Optional(
        Type.Union(
          MEMORY_TYPES.map((t) => Type.Literal(t)),
          { description: "Optional cognitive type. Omit to let Cortadel classify it." },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const body = readString(params, "text");
      if (!body) throw new Error("cortadel_add_memories requires non-empty `text`.");

      const options: AddOptions = { app: gateway.config.appName };
      const memoryType = readString(params, "memory_type");
      if (memoryType && (MEMORY_TYPES as readonly string[]).includes(memoryType)) options.memoryType = memoryType;

      const userId = gateway.userIdFor(identity);
      const outcome = await gateway.call(userId, "add_memories tool", (client, signal) => client.add(body, options, signal));

      if (!outcome.ok) {
        return {
          content: text(`Could not save to Cortadel memory (${outcome.message}).`),
          details: { ok: false, reason: outcome.reason, message: outcome.message },
        };
      }

      // A 200 does not mean a new memory was written — the store pipeline may
      // have deduplicated, superseded, or merged it. Report what actually happened.
      const event = outcome.value.event ?? "ADD";
      const summary = event === "SKIP_DUPLICATE" ? "Already known to Cortadel; nothing new stored." : `Saved to Cortadel memory (${event}).`;
      return { content: text(summary), details: { ok: true, id: outcome.value.id, event } };
    },
  };

  return [searchMemory, addMemories];
}
