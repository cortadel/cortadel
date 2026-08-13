# Cortadel × Mastra

Long-term memory for [Mastra](https://mastra.ai) agents, backed by
[Cortadel](https://cortadel.ai) — self-hosted temporal graph memory for AI agents
(a bi-temporal graph store with hybrid BM25 + vector search). Mastra's built-in
memory is conversation history scoped to a thread; Cortadel is the layer above
that: durable, distilled facts about a person that survive across threads,
sessions and apps.

This package gives you both halves of that:

- an **automatic memory processor** that recalls relevant memories before every
  model call and persists the finished turn after it, and
- two **agent tools** so the model can search and write memory on its own
  initiative.

Both are ordinary Mastra primitives — a `Processor` and two `createTool` tools —
so there is nothing to wire up beyond adding them to your `Agent`.

## Install

```bash
npm install @cortadel/mastra
# pnpm add @cortadel/mastra   ·   yarn add @cortadel/mastra
```

`@mastra/core` and `zod` are peer dependencies; you already have both in a Mastra
project.

## Quickstart

```ts
import { Agent } from "@mastra/core/agent";
import { cortadelMemory } from "@cortadel/mastra";

const memory = cortadelMemory({
  baseUrl: "http://localhost:3001", // or https://app.cortadel.ai
  // apiKey: process.env.CORTADEL_API_KEY,  // omit when the server has auth disabled
});

const agent = new Agent({
  id: "assistant",
  name: "assistant",
  instructions: "You are a helpful assistant with long-term memory.",
  model: "openai/gpt-5",
  tools: { ...memory.tools },
  // The SAME instance goes in both arrays — one implements both hooks.
  inputProcessors: [memory.processor],
  outputProcessors: [memory.processor],
});

// `resource` is the person; it becomes the Cortadel user id. `thread` is the
// conversation; it becomes the Cortadel session. Mastra only propagates
// `resource` when a `thread` is present, so always pass both.
await agent.generate("I only ship to production on Tuesdays.", {
  memory: { resource: "e2e-mastra-alice", thread: "thread-1" },
});

// A brand-new thread — Mastra's own history is empty, so anything the agent
// knows here came out of Cortadel.
const answer = await agent.generate("Can we cut a release this Friday?", {
  memory: { resource: "e2e-mastra-alice", thread: "thread-2" },
});
console.log(answer.text);
```

Full runnable scripts are in [`examples/`](examples/).

## What you get

### Automatic memory — `CortadelMemoryProcessor`

A Mastra [`Processor`](https://mastra.ai/reference/processors/processor-interface)
implementing two of its methods. Register the one instance in both
`inputProcessors` and `outputProcessors`.

| Hook | When | What it does |
|---|---|---|
| `processInput` | before the model call | Searches Cortadel with the latest user message and appends **one** system message containing the hits. Leaves your own system messages untouched. |
| `processOutputResult` | after the turn finishes | Sends the user message and the model's reply to `addConversation`, so Cortadel's extraction pipeline distills durable facts from the turn. |

Five details worth knowing:

- **Recall is not thread-scoped by default.** The search deliberately omits
  `sessionId` — long-term memory is supposed to cross conversations. The *write*
  does carry the thread as Cortadel's `sessionId`, so facts stay grouped by
  conversation; set `scopeRecallToSession: true` if you want recall confined to
  the current thread as well.
- **A memory is injected once per thread.** The processor remembers which memory
  ids it has already put in front of the model and filters them out of later
  turns, instead of burning tokens re-stating them every time. Set
  `dedupeAcrossTurns: false` to turn that off.
- **Failure is a no-op, never an exception.** Every Cortadel call is time-boxed
  with an `AbortSignal` and wrapped; if the server is slow or down, the turn
  proceeds with no memory and `onError` is called. The agent never dies because
  memory did. Set `throwOnError: true` if memory is load-bearing for you and
  you would rather the run fail loudly.
- **The write is awaited by default.** See
  [`awaitPersist`](#persistence-processoutputresult) below for why this package
  differs from the other Cortadel integrations.
- **A turn is written at most once — and a failed write stays retryable.** The
  processor keeps a per-thread latch so the same turn is never written twice,
  but the latch is only made permanent once the write has actually succeeded.
  Retry a turn whose persist threw and it is written; repeat a turn that landed
  and it is skipped.

### Agent tools — `createCortadelTools`

| Tool | Input | Purpose |
|---|---|---|
| `search_memory` | `{ query, topK? }` | Look something up on demand, e.g. mid-reasoning. |
| `add_memories` | `{ statements: string[] }` | Deliberately commit facts to memory. |

The names match Cortadel's own MCP tools. Mastra names a tool after the **key you
register it under**, not after its `id`, so those keys are exactly what the model
sees — and renaming one is just re-keying it:

```ts
new Agent({ /* ... */ tools: { recall_memory: memory.tools.search_memory } });
```

Both return an `error` field rather than throwing, so a memory outage cannot
break the tool loop (unless you set `throwOnError`). `add_memories` reports
Cortadel's own `event` per statement (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, …) —
a 2xx does not mean a new memory was written, and the model gets to see which it
was.

Use them without the processor if you only want explicit memory:

```ts
import { createCortadelTools } from "@cortadel/mastra";
const tools = createCortadelTools({ baseUrl: "http://localhost:3001" });
new Agent({ /* ... */ tools: { ...tools } });
```

## Identity: how a Mastra `resourceId` becomes a Cortadel user

A Cortadel client is bound to **one** user id at construction — no method takes a
user id. So multi-user scoping means one client per user, which this package
pools for you (bounded, LRU). The id is resolved per run, highest precedence
first:

1. `resolveUserId(scope)` — full control; receives `{ resourceId, threadId, requestContext }`
2. `userId` — pin every run to one id (single-user scripts, CLIs)
3. Mastra's `resourceId` — the default, and usually the right answer

```ts
cortadelMemory({
  // Namespace tenants so two customers' "alice" never share a graph.
  resolveUserId: (scope) => (scope.resourceId ? `acme:${scope.resourceId}` : undefined),
});
```

If none of the three yields an id, memory silently no-ops and `onError` fires
once with `operation: "resolve-user-id"` — it will not guess. (With
`throwOnError: true` it throws instead, and keeps throwing after that first
report: every later run is just as unscoped as the first.)

> **Gotcha:** Mastra only attaches `resourceId` to messages when a `threadId` is
> present too (`MessageList`'s `memoryInfo` is `{ threadId, resourceId? }`). A
> call like `agent.generate(text)` with no `memory` option therefore has nothing
> to scope to. Either pass `memory: { resource, thread }`, set
> `MASTRA_RESOURCE_ID_KEY` on the `RequestContext`, or pin `userId`.

## Configuration

`cortadelMemory(options)` accepts everything below. `createCortadelTools` and
`new CortadelMemoryProcessor()` each accept the subset relevant to them.

### Connection and identity

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | `$CORTADEL_BASE_URL` → `http://localhost:3001` | Cortadel server URL. |
| `apiKey` | `string` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server runs with auth disabled. |
| `userId` | `string` | — | Pin every run to one Cortadel user id. |
| `resolveUserId` | `(scope) => string \| undefined` | — | Derive the user id from the run. Highest precedence. |
| `appName` | `string` | `"cortadel-mastra"` | Recorded on searches and stamped on writes via `AddOptions.app`. |
| `timeoutMs` | `number` | `100000` | Per-request timeout handed to the SDK. `0` disables. |
| `createClient` | `(userId) => CortadelClientLike` | real `CortadelClient` | Swap the client — for tests, or to wrap the SDK. |
| `onError` | `(error, context) => void` | `console.warn` | Callback fired on every Cortadel failure. Replaces the default warning. |
| `throwOnError` | `boolean` | `false` | Propagate memory failures to the caller instead of degrading to no-memory. |

`onError` is always a **callback**, never a mode string, and `throwOnError` is the
separate switch for "memory is a hard dependency". With `throwOnError: true`
every failure reported to `onError` is rethrown afterwards — a failed recall or
an awaited persist throws out of the processor, and the tools throw instead of
returning their `error` field. The one thing it cannot reach is a fire-and-forget
persist (`awaitPersist: false`): there is no caller left to throw to, so there
`onError` stays the only signal. Retrying the turn after a thrown persist is
safe and is the point — see
[writing a turn exactly once](#writing-a-turn-exactly-once-and-retrying-one-that-failed).

### Recall (`processInput`)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `recall` | `boolean` | `true` | Turn injection off entirely. |
| `topK` | `number` | `5` | Memories per turn (Cortadel allows 1–50). |
| `searchMode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Cortadel search mode. |
| `rerank` | `boolean` | `false` | Rerank with the server's cross-encoder. |
| `memoryType` | `string` | — | Restrict to `episodic` \| `semantic` \| `procedural`. |
| `scopeRecallToSession` | `boolean` | `false` | Recall only from the current thread (Mastra's `threadId` = Cortadel's `sessionId`). |
| `minQueryLength` | `number` | `3` | Skip the search on trivially short input. |
| `dedupeAcrossTurns` | `boolean` | `true` | Never inject the same memory twice in a thread. |
| `maxTrackedPerThread` | `number` | `200` | Memory ids remembered per thread for that. |
| `maxTrackedThreads` | `number` | `256` | Threads tracked before the oldest is dropped. |
| `header` | `string` | see `DEFAULT_MEMORY_HEADER` | Heading above the injected bullets. |
| `recallTimeoutMs` | `number` | `5000` | Abort recall after this. `0` disables. |

### Persistence (`processOutputResult`)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `persist` | `boolean` | `true` | Turn the write off entirely. |
| `awaitPersist` | `boolean` | `true` | `false` = fire-and-forget, for latency-sensitive long-lived servers. |
| `persistTimeoutMs` | `number` | `10000` | Abort the write after this. `0` disables. |
| `project` | `string` | — | Cortadel project scope stamped on stored facts. |
| `tags` | `string[]` | — | Tags applied to every stored fact. |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the assistant instead of the user. |

**Why `awaitPersist` defaults to `true` here** — and to `false` in the other
Cortadel integrations: `processOutputResult` is the last thing Mastra runs for a
turn, and Mastra ships deployers for Cloudflare Workers, Vercel and Netlify,
where the runtime may freeze or kill the isolate the moment the response is
returned — taking an un-awaited write with it and silently losing the memory.

#### Writing a turn exactly once, and retrying one that failed

The processor keeps one latch per `(user, thread)` holding the signature of the
turn it last wrote, so re-running an identical turn does not write it twice. The
latch is claimed when the write **starts** and settled by its outcome:

| Outcome | Latch | An identical turn afterwards |
|---|---|---|
| Write succeeded | held permanently | skipped — it is already in Cortadel |
| Write failed | released | **written** — the turn is not in Cortadel yet |
| Write still in flight, `awaitPersist: true` | held | joins the write in flight; no second write is issued, and the caller does not return until it settles |
| Write still in flight, `awaitPersist: false` | held | dropped — nobody is waiting on the first write, so there is nothing to join |

That is what makes `throwOnError: true` usable for persistence: the retry the
throw invites is a real re-attempt, not a no-op. Each call still makes **at most
one** write attempt — releasing the latch re-opens the turn, it does not
schedule a retry of its own.

The one trade: if a write actually landed server-side and only the response was
lost, the retry writes a duplicate — which Cortadel's own dedup pipeline
collapses. Losing the memory outright has no such remedy.

Under `awaitPersist: false` a failure is reported to `onError` after
`processOutputResult` has already returned, so the caller cannot retry that
turn — but the latch is released all the same, so the next identical turn is
written rather than skipped.

### Tools

| Option | Type | Default | Meaning |
|---|---|---|---|
| `topK` | `number` | `10` | Default result count when the model doesn't ask (matches the SDK's own `SearchOptions` default). |
| `searchMode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Cortadel search mode. |
| `rerank` | `boolean` | `false` | Rerank with the cross-encoder. |
| `scopeRecallToSession` | `boolean` | `false` | Restrict `search_memory` to the current thread. |
| `timeoutMs` | `number` | `10000` | Abort a tool call after this. `0` disables. |
| `idPrefix` | `string` | — | Prefixes both tool **ids** (`"memory"` → `memory_search_memory`) to disambiguate two tool sets in a registry. It does not rename what the model calls — re-key the tool for that. |

## Running the tests

Everything is offline — no server, no keys, no network.

```bash
cd integrations/mastra
pnpm install
pnpm test            # vitest run
pnpm run typecheck   # tsc over src/ and test/ (tsconfig.test.json)
pnpm run build
```

The suite includes an end-to-end test that drives a real `@mastra/core` `Agent`
against a stub language model and a fake Cortadel client, asserting that recalled
memories genuinely land in the model's system prompt and that the finished turn
genuinely reaches `addConversation`.

## Requirements

- **Node.js ≥ 22.13** (the floor `@mastra/core` sets).
- **`@mastra/core` ≥ 1.0 < 2** — verified against `1.58.0`. Declared as a peer
  dependency, as Mastra integrations do.
- **`zod` ^3.25 || ^4** — the same range `@mastra/core` peers on.
- **A running Cortadel server**: hosted at `https://app.cortadel.ai`, or
  self-hosted with `docker compose up` from the
  [repo root](https://github.com/cortadel/cortadel) → `http://localhost:3001`.
  See [`docs/self-hosting.md`](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md).

## Why a processor and not a `MastraMemory` subclass

Mastra's `MastraMemory` (`@mastra/core/memory`) is a **storage** interface: 13
abstract methods covering thread CRUD, message persistence, working memory and
thread cloning (`getThreadById`, `listThreads`, `saveThread`, `saveMessages`,
`recall`, `updateThread`, `deleteThread`, `getWorkingMemory`,
`getWorkingMemoryTemplate`, `updateWorkingMemory`,
`__experimental_updateWorkingMemoryVNext`, `deleteMessages`, `cloneThread`).

Cortadel is not a message store. Its public surface is seven methods — `add`,
`addConversation`, `search`, `list`, `get`, `delete`, `health` — with no thread
objects, no message CRUD and no update. Implementing `MastraMemory` would mean
faking most of it. The processor pipeline is the seam that actually fits: it is
where Mastra itself injects working memory, and it composes with whatever real
storage you already use for conversation history.

## Links

- [Cortadel on GitHub](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)
- [Mastra docs — Processors](https://mastra.ai/docs/agents/processors)

Apache-2.0.
