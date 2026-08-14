# Cortadel × LangGraph

LangGraph already ships short-term memory — the checkpointer, scoped to a `thread_id`.
`@cortadel/langgraph` supplies the other half: long-term memory scoped to a *user*, crossing every
thread they ever open. `CortadelStore` **is** a LangGraph `BaseStore`, so everything that already
accepts a store — `StateGraph.compile({ store })`, `entrypoint({ store })`,
`createReactAgent({ store })`, `getStore()`, a tool's `config.store` — accepts Cortadel with no other
change. On top of that the package ships two agent-callable tools and a pair of graph nodes that give
an agent memory it never has to ask for.

## Install

```bash
npm install @cortadel/langgraph
```

`@langchain/langgraph`, `@langchain/langgraph-checkpoint`, `@langchain/core` and `zod` are **peer
dependencies** — the LangChain ecosystem's own convention, and the thing that guarantees the
`BaseStore` this package extends is the very class your graph checks against rather than a duplicate
copy hoisted elsewhere in `node_modules`. Modern npm and pnpm install peers automatically; if yours
does not, add them alongside.

The package is published on npm at `0.1.0` with a Sigstore provenance attestation.

## Quickstart

A complete, runnable agent. It needs a chat model too — `npm install @langchain/anthropic` for the
one used here — and a Cortadel server on `http://localhost:3001`.

```ts
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { CortadelMemory, CortadelStore, createMemoryTools } from "@cortadel/langgraph";

const USER_ID = "e2e-alice";
const NAMESPACE = ["memories", USER_ID];

// 1. Cortadel as the graph's long-term store. This object *is* a LangGraph BaseStore.
const store = new CortadelStore({
  baseUrl: "http://localhost:3001", // or "https://app.cortadel.ai"
  userId: USER_ID,
  apiKey: process.env.CORTADEL_API_KEY, // omit entirely when the server has auth disabled
});

// 2. Automatic memory: recall before the model call, persist after the turn.
const memory = new CortadelMemory({ store, namespace: NAMESPACE });

const agent = createReactAgent({
  llm: new ChatAnthropic({ model: "claude-opus-5" }),
  // 3. ...and tools, for when the agent wants to look something up or write something down.
  tools: createMemoryTools({ store, namespace: NAMESPACE }),
  store,
  preModelHook: memory.preModelHook,
  postModelHook: memory.postModelHook,
  checkpointer: new MemorySaver(),
});

await agent.invoke(
  { messages: [new HumanMessage("I ship releases on Fridays.")] },
  { configurable: { thread_id: "conv-1" } },
);

// A brand-new thread, so the checkpointer's transcript is empty here.
// Anything the agent knows now came out of Cortadel.
const result = await agent.invoke(
  { messages: [new HumanMessage("When should we deploy?")] },
  { configurable: { thread_id: "conv-2" } },
);
console.log(result.messages.at(-1)?.content);
```

The package's `examples/` folder carries three runnable variants, none of which needs an LLM API key:
two drive the store and the nodes with no model at all, and the `createReactAgent` example runs on
`FakeListChatModel`. All three need only a Cortadel server.

## What you get

### `CortadelStore` — the `BaseStore` implementation

The flagship. Because it satisfies LangGraph's own long-term-memory interface, every store call in
your graph routes to Cortadel's write and search pipelines:

| LangGraph call | Cortadel call |
|---|---|
| `put(ns, key, value)` | `add()` — into the write pipeline (intent classification, dedup, background extraction) |
| `put(ns, key, null)` / `delete(ns, key)` | `delete()` |
| `get(ns, key)` | `get()` |
| `search(ns, { query })` | `search()` — hybrid BM25 + vector, RRF-fused |
| `search(ns)` (no query) | `list()` |
| `listNamespaces()` | *no Cortadel equivalent* — served from a process-local registry |

Two Cortadel-specific extras sit beside the interface: **`addConversation(namespace, messages,
options)`** hands Cortadel raw turns and lets its extraction pipeline decide what is worth
remembering, and **`health(namespace?)`** checks the server. Neither is a `BaseStore` operation.

### `createMemoryTools()` — tools the agent calls itself

Two LangChain tools built with `tool()` and a zod schema:

- **`search_memory(query, topK?)`** — retrieve. Returns the matching facts as plain text, or
  `"No relevant memories found."`
- **`add_memories(memories)`** — store. One memory per fact.

They talk to a `BaseStore`, not to a Cortadel client, so omitting `store` makes them read the store
off the `LangGraphRunnableConfig` they are called with. That also means the same tools keep working
against an `InMemoryStore` in a unit test.

### `CortadelMemory` — the automatic-memory seam

Two ordinary async node callables — `recallNode` and `rememberNode` — exposed under LangGraph's own
hook names as `.preModelHook` and `.postModelHook`.

- **`recallNode`** searches Cortadel with the user's latest message and prepends the hits as a
  `SystemMessage`. Within one turn the rendered block is cached per thread, so a tool loop costs one
  Cortadel search rather than one per model call.
- **`rememberNode`** waits until the model produces a final answer (not a tool call), then hands the
  new turns to `addConversation`. A per-thread cursor means each message is submitted at most once,
  and tool traffic is excluded — raw tool payloads are noise the extraction pipeline should not mine
  for user facts.

## Configuration

### `new CortadelStore(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | *required* | Cortadel server: `http://localhost:3001` self-hosted, `https://app.cortadel.ai` hosted |
| `userId` | `string \| (namespace: string[]) => string` | *required* | The Cortadel user that owns the memories, or a callable deriving it from the namespace |
| `apiKey` | `string?` | — | Bearer token. Omit when the server has auth disabled (the self-hosted default) |
| `appName` | `string` | `"@cortadel/langgraph"` | Recorded for access logging, and as the creating app on writes |
| `searchMode` | `string` | `"hybrid"` | `hybrid`, `text` or `vector` |
| `rerank` | `string?` | — | `"cross_encoder"` to rerank with the server's cross-encoder; any other value is ignored server-side |
| `infer` | `boolean` | `true` | `false` stores text verbatim, skipping background entity/category extraction (dedup still applies) |
| `textKeys` | `readonly string[]` | `["content", "text", "memory", "data"]` | `Item.value` keys checked, in order, for the text to store. An empty list throws |
| `valueKey` | `string` | `"content"` | Key the memory text is exposed under on read |
| `throwOnError` | `boolean` | `false` | `false` fails open — a Cortadel failure becomes an empty result. `true` propagates it |
| `onError` | `(error: unknown) => void`? | — | Callback invoked with the error when a failure is swallowed. Replaces the default warning log. Passing a non-function throws a `TypeError` at construction |
| `timeoutMs` | `number` | `100000` | Per-request HTTP timeout, in milliseconds. `0` disables it |
| `maxAliasEntries` | `number` | `10000` | Cap on the process-local caller-key → memory-id alias table |
| `logger` | `{ warn(message, ...args) }` | `console` | Where warnings go |
| `clientFactory` | `(userId: string) => CortadelMemoryClient`? | a real `CortadelClient` | Builds the Cortadel client for a resolved user id. Mostly a test seam |

`addConversation` additionally accepts `{ sessionId?, project?, tags?, isAgentMemory? }`;
`isAgentMemory` defaults to `false` (extract facts about the user, not the assistant).

### `new CortadelMemory(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `store` | `BaseStore?` | — | Omit to read the graph's compiled store off the config at call time |
| `namespace` | `string \| readonly string[]` | `["memories", "{userId}"]` | Namespace to use; `{placeholders}` are filled from `config.configurable` |
| `topK` | `number` | `5` | Maximum memories injected per turn. Lower than the `search_memory` tool's `10` because every turn pays for this search, asked for or not |
| `header` | `string` | `DEFAULT_RECALL_HEADER` | Sentence introducing the injected memories |
| `messagesKey` | `string` | `"messages"` | State key holding the conversation |
| `outputKey` | `string` | `"llmInputMessages"` | State key the recalled-plus-original message list is written to |
| `persist` | `boolean` | `true` | `false` for a read-only agent |
| `recall` | `boolean` | `true` | `false` to persist only |
| `sessionFromThread` | `boolean` | `true` | Record the LangGraph `thread_id` as the Cortadel session id on persisted facts |
| `scopeRecallToSession` | `boolean` | `false` | Restrict recall to the current thread's session. Off by default — memory that only sees this thread is the checkpointer with extra steps |
| `project` | `string?` | — | Cortadel project scope recorded on persisted facts |
| `tags` | `string[]?` | — | Cortadel tags applied to every persisted fact |
| `awaitPersist` | `boolean` | `true` | Await the write before the node returns. See *Known limits* for why the default is not `false` |
| `throwOnError` | `boolean` | `false` | `true` propagates memory failures instead of degrading to "no memory this turn" |
| `onError` | `(error: unknown) => void`? | — | Callback invoked with the error when a failure is swallowed |
| `maxTrackedThreads` | `number` | `256` | Cap on the per-thread recall cache and persistence cursors |
| `logger` | `{ warn(message, ...args) }` | `console` | Where warnings go |

### Tool factories

`createSearchMemoryTool({ store?, namespace?, topK?, name?, description? })`,
`createAddMemoriesTool({ store?, namespace?, name?, description? })`, and
`createMemoryTools({ store?, namespace?, topK? })` for both as a tuple.

`topK` defaults to `10` — matching the Cortadel SDK's own `SearchOptions.topK` — and is both the
value used when the model omits the argument **and** the default baked into the tool's advertised
JSON schema, so the two cannot drift.

> **Memory failures degrade, they don't escalate.** Both classes fail open by default. A
> `CortadelError` — which the SDK also throws for transport failures, with `code: "transport_error"`
> — becomes an empty result: a search returns `[]`, a `get` returns `null`, a write is dropped, and
> the graph runs on without memory. `onError` is consulted only for failures that are *swallowed*, so
> `throwOnError: true` wins over it.

## How it works

**The extension point is `BaseStore`** from `@langchain/langgraph-checkpoint` (`src/store/base.ts`) —
LangGraph's single long-term-memory interface, and what `StateGraph.compile({ store })`,
`entrypoint({ store })` and `createReactAgent({ store })` accept, what `getStore()` hands a node, and
what a tool reads off its `LangGraphRunnableConfig`.

The JavaScript `BaseStore` is not the Python one. It declares exactly **one** abstract member —
`batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>` — where Python declares
two (`batch` and `abatch`). Everything else (`get` / `search` / `put` / `delete` / `listNamespaces`) is
concrete on the base class and routes through it, so `CortadelStore` implements that one method and
inherits the rest. Operations are also plain structural interfaces rather than classes, so dispatch
discriminates on *which properties are present*, and order matters: `namespacePrefix` identifies a
`SearchOperation`, `value` a `PutOperation`, `key` + `namespace` a `GetOperation`, and
`ListNamespacesOperation` — whose `matchConditions` is optional — can only be recognised last.

Three seams follow from mapping the two models onto each other:

- **Namespace → user id.** A Cortadel client is bound to one user id at construction, so per-user
  scoping means *one client per user*. `userId` therefore accepts a callable that derives the id from
  the namespace (`namespaceUserId(-1)` reads the trailing label, pairing with the default
  `["memories", "{userId}"]`), and the store pools clients keyed by the resolved id.
- **Store resolution.** `getStore(config)` in `@langchain/langgraph` is
  `(config ?? AsyncLocalStorageProviderSingleton.getRunnableConfig())?.store` — it takes an optional
  config, unlike Python's zero-argument `get_store()`. The package threads the explicit config through
  every call site and narrows every failure mode (no config, no ALS, no store) to a single
  `undefined`, so memory can be absent without crashing the graph.
- **The recall channel.** `recallNode` writes to **`llmInputMessages`**, declared in
  `PreHookAnnotation` (`libs/langgraph-core/src/prebuilt/react_agent_executor.ts`) with the
  overwriting reducer `(_, update) => messagesStateReducer([], update)`. `getModelInputState` in the
  same file destructures `{ messages, llmInputMessages, ...rest }` and hands the model
  `llmInputMessages` **instead of** `messages`. The recalled block therefore never joins the durable
  transcript and never accumulates — each hook run replaces the whole channel.

The tools are built with `tool()` from `@langchain/core/tools`, which invokes its callback as
`func(input, childConfig)` where `childConfig = patchConfig(config, …)`. Argument two is the runnable
config, which inside a graph carries `.store` — so reading `config.store` (exactly what
`getStore(config)` does) is what lets a tool find the compiled store with no extra plumbing.

Both nodes are bare `(state, config) => update` async callables. `CreateReactAgentParams` types
`preModelHook` / `postModelHook` as `RunnableLike<…, LangGraphRunnableConfig>`, which a plain function
satisfies, so no `RunnableLambda` wrapper is needed on the JavaScript side.

## Known limits

- **Keys are Cortadel memory ids.** Cortadel mints its own ids and has no upsert-by-caller-key, so
  the store's key space *is* Cortadel memory ids — that is what `search()` returns as
  `SearchItem.key` and what `get()` / `delete()` expect. A caller-chosen key passed to `put()` is
  bridged to the minted id through a **process-local** alias table, so `put(); get()` round-trips
  within one run but not across a restart. `value.id` always holds the durable id.
- **Values are text.** `BaseStore` values are objects; Cortadel stores text. The first matching
  `textKeys` entry becomes the memory text and the rest becomes metadata, so `{ content: "…" }` is the
  shape to use. A value with no matching key is stored as deterministic (key-sorted) JSON — lossless,
  but Cortadel's extraction works far better on prose. LangGraph's `index: false` maps to Cortadel's
  `infer: false`; a list of field paths (`index: ["a", "b"]`) has no equivalent and is ignored.
- **`listNamespaces()` is not durable.** Cortadel namespaces by user rather than by path, so this
  reports the namespaces *this store instance* has read from or written to. Accurate, but empty in a
  freshly-started process.
- **Filters are split.** `memoryType` and `sessionId` are pushed to the server; the rest are applied
  client-side against the fields Cortadel exposes on a hit (`categories`, `tags`, `appName`, `source`,
  `state`, `gist`, `projectId`, …), including the `$eq` / `$ne` / `$gt` / `$gte` / `$lt` / `$lte`
  operators the JS `SearchOperation` documents. An unusable key is warned about once and ignored — it
  does *not* silently drop results.
- **`limit`, not `topK`, on store calls.** `BaseStore.search()`'s own option is `limit`, so calls into
  the store keep LangGraph's spelling. `topK` names only the surface this package owns —
  `CortadelMemory` and the tool factories. Cortadel also caps a search at 50 results and a list at
  100; a `limit + offset` beyond that is clamped, with a one-time warning.
- **`awaitPersist` defaults to `true`, against the repo-wide default.** A graph node has no lifetime
  of its own: once the run finishes, LangGraph or its host may tear the process down, and a detached
  write would be silently lost. Cortadel's extraction already runs off the request path server-side,
  so awaiting costs only the round trip. With `awaitPersist: false` the floating promise still routes
  its failure through `onError` (or the logger) and **never** through `throwOnError` — by then the
  node has returned, so there is no caller left to throw to.
- **Batched operations run in order, not in parallel.** A batch may legitimately contain a write and a
  read of the same key, and Cortadel has no batch endpoint preserving that ordering. LangGraph wraps a
  compiled store in `AsyncBatchedStore`, which coalesces concurrent operations into one `batch` call,
  so a heavily parallel graph trades throughput for the ordering guarantee.
- **`AsyncBatchedStore` drains only while the graph runs.** Reading through the store handed to a node
  (`config.store`) *after* `invoke()` has returned will hang. Keep your own `CortadelStore` reference
  for outside-the-graph reads.
- **That wrapper forwards only `get` / `search` / `put` / `delete`** — not `addConversation`, which is
  not a `BaseStore` operation at all. A store-less `CortadelMemory` therefore looks *through* the
  wrapper to persist against the `CortadelStore` the graph was compiled with. Nothing is batched away:
  the wrapper has no queue for a method it does not implement. A wrapper of your own is seen through
  too, provided it keeps the wrapped store on a `store` property.
- **Namespace labels cannot contain a period, and the first label cannot be `"langgraph"`.** That is
  `BaseStore.put`'s own `validateNamespace`, not this package's — and it runs on `put` only, so a
  namespace that is never written to is never checked. Worth knowing if your user ids are email
  addresses.
- **There is no TTL.** Unlike the Python `BaseStore`, the JS one has no `ttl` argument and no
  `supports_ttl` flag, so there is nothing to opt out of. Cortadel is bi-temporal anyway — memories
  are superseded, not expired on a timer.
- **`createReactAgent` is deprecated** as of LangGraph 1.0 in favour of `createAgent` in the
  `langchain` package. It still ships from `@langchain/langgraph/prebuilt` and is covered by this
  package's tests. On `createAgent`, use `store` plus `createMemoryTools()`, or drive `recallNode` /
  `rememberNode` as nodes of your own `StateGraph`.
- **Do not reach for `ToolRuntime.store` in your own tools.** Its type is `@langchain/core`'s
  key-value `BaseStore<string, unknown>` (the `mset` / `mget` one), a different class from LangGraph's.
  Read `config.store`, or call `getStore(config)`.
- **The test suite is fully offline.** It stubs at the Cortadel client boundary through
  `clientFactory`, so the store, tools, and hooks are exercised against a fake rather than a live
  server. Behaviour against a real Cortadel deployment is not covered by CI.

## Requirements

- **Node.js ≥ 20** (the package is ESM-only)
- **`@langchain/langgraph` ≥ 1.4.9** (peer), with `@langchain/langgraph-checkpoint` ≥ 1.1.3 for
  `BaseStore`, `@langchain/core` ≥ 1.1.48 for `tool()` and the message classes, and `zod`
  (`^3.25.32 || ^4.2.0`, the range LangGraph itself declares) for the tool schemas
- **`@cortadel/sdk` ≥ 1.0.0** — the official TypeScript SDK, a regular dependency
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` from the repo root, which serves the API, dashboard and MCP endpoint on
  `http://localhost:3001`. Self-hosted defaults to auth disabled, so `apiKey` is optional there.
  See [Self-hosting](../self-hosting.md) and [Authentication](../authentication.md).

## Links

- [`@cortadel/langgraph` on npm](https://www.npmjs.com/package/@cortadel/langgraph)
- [`integrations/langgraph` source](https://github.com/cortadel/cortadel/tree/main/integrations/langgraph)
- [All integrations](../integrations.md)
