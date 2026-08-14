/**
 * LangChain tools that let an agent read and write Cortadel memory on its own initiative.
 *
 * These are built with `tool()` from `@langchain/core/tools` (`src/tools/index.ts`) — the tool
 * primitive every LangGraph agent already speaks (`createReactAgent({ tools })`, `new ToolNode()`)
 * — with a zod schema, the shape `tool()`'s `ToolWrapperParams.schema` documents.
 *
 * They operate through LangGraph's `BaseStore`, not through a Cortadel client directly. That is
 * deliberate: omitting `store` makes a tool read the store off the `LangGraphRunnableConfig` it is
 * called with, so `createReactAgent({ store: new CortadelStore(...) })` wires the tools up with no
 * further plumbing — and the same tools keep working against an `InMemoryStore` in a unit test.
 *
 * **JS-specific note on where the store comes from.** `tool()` invokes its callback as
 * `func(input, childConfig)` where `childConfig = patchConfig(config, …)`
 * (`@langchain/core/dist/tools/index.js`), so argument two is the runnable config — which inside a
 * graph is a `LangGraphRunnableConfig` carrying `.store`. It is *not* a `ToolRuntime`; that type
 * belongs to `createAgent` in the `langchain` package, and its `store` field is typed as
 * `@langchain/core`'s own key-value `BaseStore<string, unknown>` (the `mset`/`mget` one), which is
 * a different class from LangGraph's. Reading `config.store` — which is exactly what
 * `getStore(config)` does — avoids that trap entirely.
 */
import { tool, type ToolRunnableConfig } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BaseStore, SearchItem } from "@langchain/langgraph-checkpoint";
import { z } from "zod";

import { DEFAULT_NAMESPACE, resolveNamespace, type NamespaceLike } from "./namespace.js";
import { ambientStore } from "./runtime.js";

const SEARCH_DESCRIPTION =
  "Search the user's long-term memory for facts relevant to a question. Call this before " +
  "answering anything that depends on who the user is, what they have told you before, their " +
  "preferences, decisions, projects, or past events. Returns the most relevant stored facts, " +
  "or a note that nothing was found.";

const ADD_DESCRIPTION =
  "Save durable facts to the user's long-term memory so they are available in future " +
  "conversations. Store standalone, self-contained statements — each one should still make " +
  "sense read on its own months from now. Do not store transient chatter, and do not store a " +
  "fact you already retrieved from memory.";

/**
 * 10 matches the Cortadel SDK's own `SearchOptions.topK` default. An explicit search tool is asked
 * for on purpose, so it can afford a wider net than the automatic injection in `CortadelMemory`
 * (which defaults to 5 because every turn pays for it).
 */
export const DEFAULT_TOOL_TOP_K = 10;

/** Options shared by both tool factories. */
export interface MemoryToolOptions {
  /**
   * Store to use. Omit to read the store off the `LangGraphRunnableConfig` the tool is called
   * with, which requires the graph to have been compiled with `store`.
   */
  store?: BaseStore;
  /**
   * Namespace to use, possibly templated (`["memories", "{userId}"]`). Placeholders are filled
   * from `config.configurable` on each call.
   */
  namespace?: NamespaceLike;
  /** Tool name exposed to the model. */
  name?: string;
  /** Tool description exposed to the model. */
  description?: string;
}

/** Options for {@link createSearchMemoryTool}. */
export interface SearchMemoryToolOptions extends MemoryToolOptions {
  /**
   * Default number of memories to return when the model does not say. Also the default baked into
   * the tool's `topK` argument schema.
   */
  topK?: number;
}

/**
 * The `search_memory` tool's argument schema, for a given default `topK`.
 *
 * Two things here are load-bearing, and both were found by asserting on the emitted JSON Schema.
 *
 * 1. **The default has to be baked into the schema, not just the closure.** The schema's default
 *    is what the model actually gets when it omits `topK` — zod fills it in during parsing, before
 *    the callback's own fallback is consulted. (The Python leg hit the identical trap with
 *    `StructuredTool` and a pydantic args schema.)
 * 2. **`.default()` alone would make `topK` *required*.** LangChain's `toJsonSchema` routes zod v4
 *    through zod's native `z.toJSONSchema`, which derives the schema from the *output* type — and
 *    a `.default()` field is always present on the output, so it lands in `required` and the model
 *    is obliged to supply it. Adding `.optional()` around the default drops it from `required`
 *    while keeping `default: <n>` advertised, and zod still fills the default in when the key is
 *    absent. This has no Python analogue: pydantic derives the schema from the input side.
 */
function searchMemorySchema(defaultTopK: number) {
  return z.object({
    query: z
      .string()
      .describe("What to look for, phrased as a natural-language question or topic."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(defaultTopK)
      .optional()
      .describe("Maximum number of memories to return."),
  });
}

/** The `add_memories` tool's argument schema. */
function addMemoriesSchema() {
  return z.object({
    memories: z
      .array(z.string())
      .describe(
        "One or more standalone facts to remember, each a complete sentence " +
          '(e.g. "Prefers async written updates over meetings").',
      ),
  });
}

/** The `search_memory` tool's argument type. */
export type SearchMemoryInput = z.infer<ReturnType<typeof searchMemorySchema>>;

/** The `add_memories` tool's argument type. */
export type AddMemoriesInput = z.infer<ReturnType<typeof addMemoriesSchema>>;

/**
 * Build the `search_memory` tool.
 *
 * @example
 * ```ts
 * const agent = createReactAgent({
 *   llm,
 *   tools: [createSearchMemoryTool({ namespace: ["memories", "e2e-alice"] })],
 *   store: new CortadelStore({ baseUrl, userId: "e2e-alice" }),
 * });
 * ```
 */
export function createSearchMemoryTool(options: SearchMemoryToolOptions = {}) {
  const {
    store,
    namespace = DEFAULT_NAMESPACE,
    topK = DEFAULT_TOOL_TOP_K,
    name = "search_memory",
    description = SEARCH_DESCRIPTION,
  } = options;

  return tool(
    async (input: SearchMemoryInput, config: ToolRunnableConfig): Promise<string> => {
      const resolved = requireStore(store, config);
      const items = await resolved.search(resolveNamespace(namespace, config), {
        query: input.query,
        // `limit` is BaseStore's own option name, not ours — it stays spelled LangGraph's way.
        limit: input.topK ?? topK,
      });
      return formatMemories(items);
    },
    { name, description, schema: searchMemorySchema(topK) },
  );
}

/**
 * Build the `add_memories` tool.
 *
 * Each fact becomes one `store.put(namespace, <uuid>, { content: fact })`. Against a
 * {@link CortadelStore} that lands in Cortadel's write pipeline, so duplicates and contradictions
 * of existing memories are resolved server-side rather than piling up — the tool does not need to
 * check first.
 */
export function createAddMemoriesTool(options: MemoryToolOptions = {}) {
  const {
    store,
    namespace = DEFAULT_NAMESPACE,
    name = "add_memories",
    description = ADD_DESCRIPTION,
  } = options;

  return tool(
    async (input: AddMemoriesInput, config: ToolRunnableConfig): Promise<string> => {
      const resolved = requireStore(store, config);
      const target = resolveNamespace(namespace, config);
      let stored = 0;
      for (const text of clean(input.memories)) {
        await resolved.put(target, crypto.randomUUID(), { content: text });
        stored += 1;
      }
      return formatStored(stored);
    },
    { name, description, schema: addMemoriesSchema() },
  );
}

/**
 * Both memory tools, ready to drop into `createReactAgent({ tools })`.
 *
 * The return type is a mutable tuple on purpose: `as const` would give a `readonly` tuple, which
 * keeps destructuring precise but is *not* assignable to `CreateReactAgentParams["tools"]` — and
 * that is this function's whole reason to exist. A plain tuple gets both.
 */
export function createMemoryTools(
  options: SearchMemoryToolOptions = {},
): [ReturnType<typeof createSearchMemoryTool>, ReturnType<typeof createAddMemoriesTool>] {
  const { topK, ...rest } = options;
  return [createSearchMemoryTool({ ...rest, topK }), createAddMemoriesTool(rest)];
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function requireStore(store: BaseStore | undefined, config?: ToolRunnableConfig): BaseStore {
  const resolved = store ?? ambientStore(config as LangGraphRunnableConfig | undefined);
  if (resolved === undefined) {
    throw new Error(
      "No store is available. Either pass store: new CortadelStore(...) when building the tool, " +
        "or compile the graph with it: createReactAgent({ ..., store: new CortadelStore(...) }) / " +
        "new StateGraph(...).compile({ store: new CortadelStore(...) }).",
    );
  }
  return resolved;
}

function clean(memories: readonly string[]): string[] {
  return memories
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.trim())
    .filter((text) => text !== "");
}

function formatStored(count: number): string {
  if (count === 0) return "Nothing to store: no non-empty memories were provided.";
  return `Stored ${count} ${count === 1 ? "memory." : "memories."}`;
}

/** Render search results as the plain text that becomes the `ToolMessage` content. */
function formatMemories(items: readonly SearchItem[]): string {
  if (items.length === 0) return "No relevant memories found.";
  const lines = items.map((item, index) => {
    const text = textOfValue(item.value);
    const suffix = typeof item.score === "number" ? ` (relevance ${item.score.toFixed(3)})` : "";
    return `${index + 1}. ${text}${suffix}`;
  });
  return `Relevant memories:\n${lines.join("\n")}`;
}

/** Pull the human-readable text out of an `Item.value`, whatever key it landed under. */
function textOfValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["content", "text", "memory", "data"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    }
    return Object.entries(record)
      .filter(([key]) => key !== "id")
      .map(([key, entry]) => `${key}=${String(entry)}`)
      .join("; ");
  }
  return String(value);
}
