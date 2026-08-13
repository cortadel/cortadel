# Cortadel × LangGraph

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search, so facts are superseded rather than
overwritten and retrieval finds things that share no words with the query. This package makes it a
first-class citizen inside LangGraph: `CortadelStore` **is** a LangGraph `BaseStore`, so everything
that already accepts a store — `StateGraph.compile({ store })`, `entrypoint({ store })`,
`createReactAgent({ store })`, `getStore()`, a tool's `config.store` — accepts Cortadel with no
other changes. On top of that you get two ready-made tools and a pair of graph nodes that give an
agent memory it never has to ask for.

LangGraph already ships short-term memory (the checkpointer, scoped to a `thread_id`). This is the
other half: long-term memory scoped to a *user*, which crosses every thread they ever open.

## Install

```bash
npm install @cortadel/langgraph
# or
pnpm add @cortadel/langgraph
```

`@langchain/langgraph`, `@langchain/langgraph-checkpoint`, `@langchain/core` and `zod` are **peer
dependencies** — the LangChain ecosystem's own convention, and the thing that guarantees the
`BaseStore` this package extends is the very class your graph checks against rather than a
duplicate copy hoisted somewhere else in `node_modules`. Modern npm and pnpm install peers
automatically; if yours does not, add them alongside.

## Quickstart

```ts
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { CortadelMemory, CortadelStore, createMemoryTools } from "@cortadel/langgraph";

const USER_ID = "e2e-alice";
const NAMESPACE = ["memories", USER_ID];

// 1. Cortadel as a LangGraph BaseStore.
const store = new CortadelStore({ baseUrl: "http://localhost:3001", userId: USER_ID });

// 2. Automatic memory: recall before the model call, persist after the turn.
const memory = new CortadelMemory({ store, namespace: NAMESPACE });

const agent = createReactAgent({
  llm,
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

// A brand-new thread — an empty transcript. Whatever it knows now came from Cortadel.
const result = await agent.invoke(
  { messages: [new HumanMessage("When should we deploy?")] },
  { configurable: { thread_id: "conv-2" } },
);
console.log(result.messages.at(-1)?.content);
```

Runnable versions of this, including two that need no LLM at all, are in [`examples/`](examples/).

## What you get

### `CortadelStore` — the `BaseStore` implementation

The flagship. The JavaScript `BaseStore` declares exactly **one** abstract member —
`batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>` — and implements
`get` / `search` / `put` / `delete` / `listNamespaces` on top of it. This implements that one
method, so all of them work.

| LangGraph op | Cortadel call |
|---|---|
| `put(ns, key, value)` | `add()` — into Cortadel's write pipeline (intent classification, dedup, extraction) |
| `put(ns, key, null)` / `delete(ns, key)` | `delete()` |
| `get(ns, key)` | `get()` |
| `search(ns, { query })` | `search()` — hybrid BM25 + vector, RRF-fused |
| `search(ns)` (no query) | `list()` |
| `listNamespaces()` | *no Cortadel equivalent* — served from a process-local registry |

Plus two Cortadel-specific extras that `BaseStore` has no room for: `addConversation()` (hand
Cortadel raw turns and let its pipeline decide what is worth remembering) and `health()`.

### `createMemoryTools()` — tools the agent calls itself

Two tools built with `tool()` from `@langchain/core/tools` and a zod schema:

- **`search_memory(query, topK?)`** — retrieve. Returns the matching facts as plain text.
- **`add_memories(memories)`** — store. One memory per fact.

They talk to a `BaseStore`, not to a Cortadel client, so omitting `store` makes them read the store
off the `LangGraphRunnableConfig` they are called with. That also means they keep working against
an `InMemoryStore` in a unit test.

### `CortadelMemory` — memory without a tool call

Two ordinary async node callables, usable as `StateGraph` nodes, as `createReactAgent`'s
`preModelHook` / `postModelHook`, or through the `.preModelHook` / `.postModelHook` aliases.

- **`recallNode`** searches Cortadel with the user's latest message and prepends the hits as a
  `SystemMessage`. It writes to **`llmInputMessages`**, the channel `createReactAgent` hands to the
  model *instead of* `messages`, so the memory block never joins the durable transcript and never
  accumulates. Within one turn the block is cached, so a tool loop costs one Cortadel search, not
  one per model call.
- **`rememberNode`** waits until the model produces a final answer (not a tool call), then hands
  the turns to `addConversation`. A per-thread cursor means each message is submitted at most once,
  and tool traffic is excluded.

**Persistence awaits the write by default** (`awaitPersist: true`), because a graph node has no
lifetime of its own: once the run finishes, LangGraph (or the platform hosting it) is free to tear
down the process, and a detached write would be silently lost. Blocking is cheap here anyway —
Cortadel's extraction pipeline already runs off the request path server-side, so the call returns
as soon as the turns are accepted. Set `awaitPersist: false` if you would rather not pay even that;
the floating promise still routes its failure through `onError`.

## Configuration

### `new CortadelStore(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | *required* | Cortadel server: `http://localhost:3001` self-hosted, `https://app.cortadel.ai` hosted |
| `userId` | `string \| (namespace) => string` | *required* | The Cortadel user that owns the memories, or a callable deriving it from the namespace |
| `apiKey` | `string?` | — | Bearer token. Omit when the server has auth disabled (the self-hosted default) |
| `appName` | `string` | `"@cortadel/langgraph"` | Recorded for access logging, and as the creating app on writes |
| `searchMode` | `string` | `"hybrid"` | `hybrid`, `text` or `vector` |
| `rerank` | `string?` | — | `"cross_encoder"` to rerank with the server's cross-encoder |
| `infer` | `boolean` | `true` | `false` stores text verbatim, skipping background entity/category extraction |
| `textKeys` | `readonly string[]` | `["content", "text", "memory", "data"]` | `Item.value` keys checked, in order, for the text to store |
| `valueKey` | `string` | `"content"` | Key the memory text is exposed under on read |
| `throwOnError` | `boolean` | `false` | `false` fails open — a Cortadel failure becomes an empty result. `true` propagates it. See *Degradation* |
| `onError` | `(error: unknown) => void`? | — | Callback invoked with the error when a failure is swallowed. Replaces the default warning log |
| `timeoutMs` | `number` | `100000` | Per-request HTTP timeout, in milliseconds. `0` disables it |
| `maxAliasEntries` | `number` | `10000` | Cap on the process-local key alias table |
| `logger` | `{ warn(...) }` | `console` | Where warnings go |
| `clientFactory` | `(userId) => CortadelMemoryClient`? | real `CortadelClient` | Builds the Cortadel client for a resolved user id. Mostly a test seam |

### `new CortadelMemory(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `store` | `BaseStore?` | — | Omit to read the graph's compiled store off the config at call time. Both halves work that way — recall through LangGraph's `AsyncBatchedStore` wrapper, persistence through the `CortadelStore` inside it |
| `namespace` | `string \| readonly string[]` | `["memories", "{userId}"]` | Namespace to use; `{placeholders}` come from `config.configurable` |
| `topK` | `number` | `5` | Maximum memories injected per turn. Lower than the `search_memory` tool's `10` because every turn pays for this search, whether or not it was needed |
| `header` | `string` | see `DEFAULT_RECALL_HEADER` | Sentence introducing the injected memories |
| `messagesKey` | `string` | `"messages"` | State key holding the conversation |
| `outputKey` | `string` | `"llmInputMessages"` | Where the recalled-plus-original messages are written |
| `persist` / `recall` | `boolean` | `true` | Turn either half off |
| `sessionFromThread` | `boolean` | `true` | Record the LangGraph `thread_id` as the Cortadel session id on persisted facts |
| `scopeRecallToSession` | `boolean` | `false` | Restrict recall to the current thread's session. Off by default — memory that only sees this thread is the checkpointer with extra steps |
| `project` / `tags` | `string` / `string[]` | — | Cortadel scope and tags applied to persisted facts |
| `awaitPersist` | `boolean` | `true` | Await the write before the node returns. See above for why the default is not `false` |
| `throwOnError` | `boolean` | `false` | `true` propagates memory failures instead of degrading. Cannot apply to a detached write (`awaitPersist: false`) — that failure surfaces after the node returned, so it goes to `onError`/the logger instead |
| `onError` | `(error: unknown) => void`? | — | Callback invoked with the error when a failure is swallowed |
| `maxTrackedThreads` | `number` | `256` | Cap on the per-thread caches |
| `logger` | `{ warn(...) }` | `console` | Where warnings go |

### Tool factories

`createSearchMemoryTool({ store?, namespace?, topK?, name?, description? })`,
`createAddMemoriesTool({ store?, namespace?, name?, description? })`, and
`createMemoryTools({ store?, namespace?, topK? })` for both.

`topK` is both the number of memories fetched when the model omits the argument **and** the default
advertised in the tool's JSON schema — the model sees it, so the two cannot drift. It defaults to
`10`, matching the Cortadel SDK's own `SearchOptions.topK`.

## Multi-tenancy

A Cortadel client is bound to **one user id at construction** — no method takes a user id. So one
store serves many users by deriving the user from the namespace and keeping one client each:

```ts
import { CortadelMemory, CortadelStore, namespaceUserId } from "@cortadel/langgraph";

const store = new CortadelStore({
  baseUrl: "http://localhost:3001",
  userId: namespaceUserId(-1),
});
const memory = new CortadelMemory({ store, namespace: ["memories", "{userId}"] });

await graph.invoke(inputs, { configurable: { thread_id: "t-1", userId: "e2e-alice" } });
```

`thread_id` scopes the short-term transcript; `userId` scopes long-term memory. They are
independent — a user has many threads, and their memory crosses all of them. A `{userId}`
placeholder also matches a `user_id` entry (and vice versa), because LangGraph's own protocol keys
are snake_case while TypeScript callers naturally write camelCase.

## Degradation

Memory is an enhancement, never a reason for an agent to fall over. **The store fails open by
default** (`throwOnError: false`). Every Cortadel call is wrapped: a `CortadelError` — which the SDK
also throws for transport failures, with `code: "transport_error"` — becomes an empty result. A
search returns `[]`, a `get` returns `null`, a write is dropped, and the graph runs on without
memory.

You then choose what *observes* that failure:

```ts
// Default: a warning on the console, and the agent carries on.
const store = new CortadelStore({ baseUrl, userId });

// Route failures into your own telemetry instead of the log.
new CortadelStore({ baseUrl, userId, onError: (error) => Sentry.captureException(error) });

// Silence them entirely.
new CortadelStore({ baseUrl, userId, onError: () => {} });

// Or opt out of failing open: the CortadelError reaches your code.
new CortadelStore({ baseUrl, userId, throwOnError: true });
```

`onError` is only consulted for failures that are *swallowed*, so `throwOnError: true` wins over it
— there is nothing to observe when the error reaches the caller anyway. Passing a string (the
pre-release spelling of this option) throws a `TypeError` rather than quietly never firing.

## Things worth knowing

- **Keys.** Cortadel mints its own memory ids and has **no upsert-by-caller-key**, so the store's
  key space *is* Cortadel memory ids — that is what `search()` returns as `SearchItem.key` and what
  `get()` / `delete()` expect. A caller-chosen key given to `put()` is bridged to the minted id
  through a **process-local** alias table, so `put(); get()` round-trips within one run but not
  across a restart. `value.id` always holds the durable Cortadel id. This is a Cortadel constraint,
  not a JavaScript one — the Python integration had exactly the same limitation.
- **Values.** `BaseStore` values are objects; Cortadel stores text. The first matching `textKeys`
  entry becomes the memory text and the rest becomes metadata, so `{ content: "…" }` is the shape to
  use. A value with no matching key is stored as deterministic (key-sorted) JSON — lossless, but
  Cortadel's extraction works far better on prose.
- **`listNamespaces()`** reports namespaces *this store instance* has touched, because Cortadel
  namespaces by user rather than by path. It is accurate but not durable, and empty in a
  freshly-started process.
- **`filter`** supports the fields Cortadel exposes on a hit (`categories`, `tags`, `memoryType`,
  `appName`, `source`, `state`, …) plus the `$eq` / `$ne` / `$gt` / `$gte` / `$lt` / `$lte`
  operators that LangGraph's `SearchOperation` documents. `memoryType` and `sessionId` are pushed to
  the server; the rest are applied client-side. An unusable key is warned about once and ignored —
  it does *not* silently drop results.
- **Namespace labels cannot contain a period**, and the first label cannot be `"langgraph"`.
  That is `BaseStore.put`'s own `validateNamespace`, not ours — and it runs on `put` only, so a
  namespace that only ever gets read is never checked. Worth knowing if your user ids are email
  addresses.
- **Operations in a `batch` run in order, not in parallel.** A batch may legitimately contain a
  write and a read of the same key, and Cortadel has no batch endpoint that would preserve that
  ordering. LangGraph wraps a compiled store in `AsyncBatchedStore`, which coalesces concurrent
  operations into one `batch` call, so a heavily parallel graph trades some throughput for that
  guarantee.
- **`AsyncBatchedStore` only drains while the graph is running.** Reading through the store handed
  to a node (`config.store`) *after* `invoke()` has returned will hang. Use your own
  `CortadelStore` reference outside the graph.
- **That wrapper forwards only `get`/`search`/`put`/`delete`** — not `addConversation`, which is
  Cortadel's own and not a `BaseStore` operation at all. So a store-less `CortadelMemory` looks
  through the wrapper to find the `CortadelStore` the graph was compiled with, and persists against
  that directly. Nothing is batched away by this: the wrapper has no queue for a method it does not
  implement. If you write your own store wrapper, keep the wrapped store on a `store` property (the
  convention `AsyncBatchedStore` follows) and `CortadelMemory` will see through it too.
- **There is no TTL.** Unlike the Python `BaseStore`, the JS one has no `ttl` argument and no
  `supports_ttl` flag, so there is nothing to opt out of. Cortadel is bi-temporal anyway — memories
  are superseded, not expired on a timer.
- **`createReactAgent` is deprecated** as of LangGraph 1.0 in favour of `createAgent` in the
  `langchain` package. It still ships in `@langchain/langgraph/prebuilt` and is covered by this
  package's tests. On `createAgent`, use `store` plus `createMemoryTools()`; or drive `recallNode` /
  `rememberNode` as nodes of your own `StateGraph`, which is what
  [`examples/03-multi-user-graph.ts`](examples/03-multi-user-graph.ts) does.
- **Do not reach for `ToolRuntime.store` in your own tools.** Its type is `@langchain/core`'s
  key-value `BaseStore<string, unknown>` (the `mset`/`mget` one), which is a different class from
  LangGraph's. Read `config.store` — or call `getStore(config)` — instead.

## Running the tests

The suite is fully offline: no network, no Cortadel server, no API keys. It stubs at the Cortadel
client boundary through the store's `clientFactory` option.

```bash
cd integrations/langgraph
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc over src, then over src + test + examples
pnpm build         # tsc -> dist/
```

## Requirements

- **Node.js ≥ 20**
- **`@langchain/langgraph` ≥ 1.4.9** (peer), with `@langchain/langgraph-checkpoint` ≥ 1.1.3 for
  `BaseStore`, `@langchain/core` ≥ 1.1.48 for `tool()` and the message classes, and `zod`
  (`^3.25.32 || ^4.2.0`, the range LangGraph itself declares) for the tool schemas
- **`@cortadel/sdk` ≥ 1.0.0** — the official TypeScript SDK
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` from the [repo root](https://github.com/cortadel/cortadel) → serves the API,
  dashboard and MCP endpoint on `http://localhost:3001`. Self-hosted defaults to auth disabled, so
  `apiKey` is optional there.

## Links

- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel) — SDKs, plugin, docs
- [cortadel.ai](https://cortadel.ai)
- [Issues](https://github.com/cortadel/cortadel/issues)

Apache-2.0.
