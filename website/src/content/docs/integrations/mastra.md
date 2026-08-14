---
title: Cortadel × Mastra
description: Long-term Cortadel memory for Mastra agents — a Processor that recalls and persists, plus search_memory and add_memories tools.
---

[Mastra](https://mastra.ai)'s built-in memory is conversation history scoped to a thread. Cortadel is
the layer above it: durable, distilled facts about a person that survive across threads, sessions and
apps. `@cortadel/mastra` gives you both halves of that as ordinary Mastra primitives — a `Processor`
that recalls relevant memories before every model call and persists the finished turn after it, and
two `createTool` tools (`search_memory`, `add_memories`) the model can reach for on its own
initiative. Mastra's `resourceId` becomes the Cortadel user id and its `threadId` becomes the
Cortadel session, with one pooled client per user id, so a single agent can serve many people.

## Install

```bash
npm install @cortadel/mastra
# pnpm add @cortadel/mastra   ·   yarn add @cortadel/mastra
```

`@mastra/core` and `zod` are peer dependencies — a Mastra project already has both. The Cortadel
TypeScript SDK (`@cortadel/sdk`) comes along as a normal dependency.

## Quickstart

```ts
import { Agent } from "@mastra/core/agent";
import { cortadelMemory } from "@cortadel/mastra";

const memory = cortadelMemory({
  baseUrl: "http://localhost:3001", // or https://app.cortadel.ai
  // apiKey: process.env.CORTADEL_API_KEY,  // omit when the server runs with auth disabled
});

const agent = new Agent({
  id: "assistant",
  name: "assistant",
  instructions: "You are a helpful assistant with long-term memory.",
  model: "openai/gpt-5",
  tools: { ...memory.tools },
  // The SAME instance goes in both arrays — one object implements both hooks.
  inputProcessors: [memory.processor],
  outputProcessors: [memory.processor],
});

// `resource` is the person and becomes the Cortadel user id; `thread` is the
// conversation and becomes the Cortadel session.
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

`cortadelMemory(options)` returns `{ processor, tools, pool }`, all three sharing one
`CortadelClientPool`. Want only one half? `new CortadelMemoryProcessor(options)` and
`createCortadelTools(options)` are exported separately and work on their own.

:::note
**Always pass both `resource` and `thread`.** Mastra only stamps `resourceId` onto a run's messages
when a `threadId` is present too (`MessageList`'s `memoryInfo` is `{ threadId, resourceId? }`), so
`agent.generate(text)` with no `memory` option leaves the integration nothing to scope to. Pass
`memory: { resource, thread }`, set `MASTRA_RESOURCE_ID_KEY` on the `RequestContext`, or pin
`userId` in the options.
:::

## What you get

### Automatic memory — `CortadelMemoryProcessor`

One object implementing two methods of Mastra's `Processor` interface. Register the same instance in
both `inputProcessors` and `outputProcessors`:

| Hook | When | What it does |
|---|---|---|
| `processInput` | before the model call | Searches Cortadel with the latest user message and appends **one** system message holding the hits. Your own system messages are left untouched. |
| `processOutputResult` | after the turn finishes | Sends the user message and the model's reply to `addConversation`, so Cortadel's extraction pipeline distills durable facts from the turn. |

Five behaviours worth knowing:

- **Recall is not thread-scoped by default.** The search deliberately omits `sessionId` — long-term
  memory is supposed to cross conversations. The *write* does carry the thread as Cortadel's
  `sessionId`, so facts stay grouped by conversation. Set `scopeRecallToSession: true` to confine
  recall to the current thread as well.
- **A memory is injected once per thread.** The processor remembers the memory ids it has already put
  in front of the model and filters them out of later turns instead of re-stating them every time.
  `dedupeAcrossTurns: false` turns that off.
- **Failure is a no-op, never an exception.** Every Cortadel call is time-boxed with an `AbortSignal`
  and wrapped; a slow or unreachable server means the turn simply has no memory, and `onError` is
  called. `throwOnError: true` opts into the opposite when memory is load-bearing for you.
- **The write is awaited by default** — unlike the other Cortadel integrations. See
  [Persistence](#persistence-processoutputresult) for why.
- **A turn is written at most once, and a failed write stays retryable.** A per-thread latch stops the
  same turn being written twice, but it only becomes permanent once the write has actually landed:
  retry a turn whose persist threw and it is written; repeat a turn that succeeded and it is skipped.

### Agent tools — `createCortadelTools`

| Tool | Input | Returns |
|---|---|---|
| `search_memory` | `{ query: string, topK?: 1–50 }` | `{ memories: [{ id, content, score?, createdAt?, categories? }], count, error? }` — `score` is the fused RRF score. |
| `add_memories` | `{ statements: string[] }` | `{ stored: [{ text, id?, event?, error? }], count, error? }` — `count` is the number written without error. |

The keys are what the model sees, and they match Cortadel's own MCP tool names. Mastra names a tool
after **the key you register it under**, not after its `id`, so renaming one is just re-keying it:

```ts
new Agent({ /* ... */ tools: { recall_memory: memory.tools.search_memory } });
```

Both return an `error` field rather than throwing, so a memory outage cannot break the tool loop
(unless `throwOnError` is set — and because statements are written in parallel, the first failure
then throws even though the other writes have already gone out). `add_memories` reports Cortadel's own
per-statement `event` (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, …): a 2xx does not mean a new memory was
written, and the model gets to see which it was.

## Configuration

`cortadelMemory(options)` accepts everything below; `new CortadelMemoryProcessor()` and
`createCortadelTools()` each accept the subset relevant to them.

### Connection and identity

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | `$CORTADEL_BASE_URL` → `http://localhost:3001` | Cortadel server URL. |
| `apiKey` | `string` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server runs with auth disabled. |
| `userId` | `string` | — | Pin every run to one Cortadel user id (single-user scripts, CLIs). |
| `resolveUserId` | `(scope) => string \| undefined \| null` | — | Derive the user id from `{ resourceId, threadId, requestContext }`. Highest precedence; return `undefined` to fall through. |
| `appName` | `string` | `"cortadel-mastra"` | Label recorded on searches and stamped on `add_memories` writes via `AddOptions.app`. |
| `timeoutMs` | `number` | `100000` (the SDK's own default) | Per-request timeout handed to the Cortadel SDK. `0` disables. |
| `createClient` | `(userId) => CortadelClientLike` | a real `CortadelClient` | Swap the client — for tests, or to wrap the SDK with retries/metrics. |
| `onError` | `(error, context) => void` | a `console.warn` | Callback fired on every Cortadel failure, with `context.operation` (`recall`, `persist`, `search-tool`, `add-tool`, `resolve-user-id`). Replaces the default warning. |
| `throwOnError` | `boolean` | `false` | Propagate memory failures to the caller instead of degrading to no-memory. |

`onError` is always a **callback**, never a mode string, and `throwOnError` is the separate switch for
"memory is a hard dependency". With `throwOnError: true` every failure reported to `onError` is
rethrown afterwards: a failed recall or an awaited persist throws out of the processor, and the tools
throw instead of returning their `error` field. The one thing it cannot reach is a fire-and-forget
persist (`awaitPersist: false`) — there is no caller left to throw to, so there `onError` stays the
only signal.

### Recall (`processInput`)

The processor also takes an `id` (`string`, default `"cortadel-memory"`), which must be unique within
an agent.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `recall` | `boolean` | `true` | Turn injection off entirely. |
| `topK` | `number` | `5` | Memories injected per turn (Cortadel allows 1–50). |
| `searchMode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Cortadel search mode. |
| `rerank` | `boolean` | `false` | Rerank with the server's cross-encoder (`rerank: "cross_encoder"`). |
| `memoryType` | `string` | — | Restrict to `episodic` \| `semantic` \| `procedural`. |
| `scopeRecallToSession` | `boolean` | `false` | Recall only from the current thread (Mastra's `threadId` = Cortadel's `sessionId`). Ignored on a run with no thread. |
| `minQueryLength` | `number` | `3` | Skip the search when the user's message is shorter than this. |
| `dedupeAcrossTurns` | `boolean` | `true` | Never inject the same memory twice in a thread. |
| `maxTrackedPerThread` | `number` | `200` | Memory ids remembered per thread for that. |
| `maxTrackedThreads` | `number` | `256` | Threads tracked before the oldest is dropped. |
| `header` | `string` | `DEFAULT_MEMORY_HEADER` (exported) | Heading placed above the injected bullets. |
| `recallTimeoutMs` | `number` | `5000` | Abort recall after this, so a slow memory server can't stall a turn. `0` disables. |

### Persistence (`processOutputResult`)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `persist` | `boolean` | `true` | Turn the write off entirely. |
| `awaitPersist` | `boolean` | `true` | `false` = fire-and-forget, for latency-sensitive long-lived servers. |
| `persistTimeoutMs` | `number` | `10000` | Abort the write after this. `0` disables. |
| `project` | `string` | — | Cortadel project scope stamped on stored facts (e.g. a repo name). |
| `tags` | `string[]` | — | Tags applied to every stored fact. |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the assistant instead of the user. |

:::note
**Why `awaitPersist` defaults to `true` here**, against the repo-wide `false`: `processOutputResult`
is the last thing Mastra runs for a turn, and Mastra ships first-party deployers for Cloudflare
Workers, Vercel and Netlify — runtimes free to freeze or kill the isolate the moment the response is
returned. An un-awaited write is exactly what dies there, silently losing the memory. Set `false` on
a long-lived server if you would rather not pay the write latency on the turn.
:::

### Tools

| Option | Type | Default | Meaning |
|---|---|---|---|
| `topK` | `number` | `10` | Result count when the model doesn't ask for one (matches the SDK's own `SearchOptions` default). |
| `searchMode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Cortadel search mode. |
| `rerank` | `boolean` | `false` | Rerank with the cross-encoder. |
| `scopeRecallToSession` | `boolean` | `false` | Restrict `search_memory` to the current thread. |
| `timeoutMs` | `number` | `10000` | Abort a tool call after this. `0` disables. |
| `idPrefix` | `string` | — | Prefixes both tool **ids** (`"memory"` → `memory_search_memory`) to disambiguate two tool sets in a registry. It does not rename what the model calls — re-key the tool for that. |

Five names appear in more than one table — `topK`, `searchMode`, `rerank`, `scopeRecallToSession` and
`timeoutMs` — and on `cortadelMemory()` each is a **single field feeding both halves**. Set `topK: 3`
there and the processor injects three memories *and* the tool defaults to three; leave it unset and
the two defaults diverge (5 and 10). Likewise `timeoutMs`: unset, the SDK uses its own 100 s
per-request timeout while a tool call aborts at 10 s; set, both take your value. Construct the
processor and the tools separately if you want them configured differently.

## How it works

The extension point is **Mastra's `Processor` interface**, exported from `@mastra/core/processors` —
the same seam Mastra's own memory processors use (`@mastra/core/processors/memory` holds its
message-history, semantic-recall and working-memory processors). `CortadelMemoryProcessor implements
Processor`, supplying the interface's `id` / `name` / `description` plus two of its optional methods:

- **`processInput(args: ProcessInputArgs): ProcessInputResult`.** The interface allows three return
  shapes — a mutated `MessageList`, a replacement `MastraDBMessage[]`, or
  `{ messages, systemMessages }`. This uses the third: `args.messages` is handed back untouched and
  one `{ role: "system", content }` message is **appended** to `args.systemMessages`, so your own
  system prompt survives and nothing in the conversation is rewritten. When there is nothing to
  inject, `args.messages` is returned as-is and no system message is added at all.
- **`processOutputResult(args: ProcessOutputResultArgs): MastraDBMessage[]`.** Returns `args.messages`
  unchanged; the write is a side effect.

Mastra's `InputProcessor` type requires `id` + `processInput` and its `OutputProcessor` requires
`id` + `processOutputResult`, so this one object satisfies both — which is why the same instance goes
in both arrays.

A turn, end to end:

1. **Scope.** `resourceId` / `threadId` are read from the run's `RequestContext` under Mastra's own
   well-known keys (`MASTRA_RESOURCE_ID_KEY`, `MASTRA_THREAD_ID_KEY` from
   `@mastra/core/request-context`), falling back to the newest message carrying them. The Cortadel
   user id is then `resolveUserId(scope)` → the pinned `userId` → `resourceId`. If none of the three
   yields an id, memory no-ops and `onError` fires once with `operation: "resolve-user-id"` — it will
   not guess.
2. **Query.** `messageList.getLatestUserContent()`, falling back to the text parts of the newest user
   message. Shorter than `minQueryLength` and the search is skipped.
3. **Search.** `client.search(query, { topK, mode, rerank?, memoryType?, sessionId? }, signal)` under a
   `recallTimeoutMs` `AbortSignal` combined with the run's own.
4. **Inject.** Each hit becomes `- <gist or content> (recorded <createdAt>)` under the header, ids
   already injected in this thread filtered out first.
5. **Persist.** After the turn, `client.addConversation([user, assistant], { sessionId: threadId,
   project?, tags?, isAgentMemory? }, signal)` under `persistTimeoutMs`, awaited by default. The
   duplicate-turn latch is claimed when the write *starts* and only made permanent when it succeeds,
   so a concurrent identical call joins the in-flight write rather than issuing a second one, while a
   failed write releases the latch and leaves an identical retry free to be written. (If a write
   landed server-side and only the response was lost, that retry is a duplicate — which Cortadel's own
   dedup pipeline collapses. Losing the memory outright has no such remedy.)
6. **Pool.** A `CortadelClient` is bound to one user id at construction — no SDK method takes a user
   id — so `CortadelClientPool` creates one lazily per resolved id and keeps the 128 most recently used
   (`MAX_CACHED_CLIENTS`), bounded so a multi-tenant server can't leak clients.

The tools are built with `createTool` from `@mastra/core/tools`, with zod input and output schemas.
Each `execute(input, context)` re-resolves the user id from the same precedence chain, reading
`context.agent.resourceId` / `context.agent.threadId` off Mastra's `AgentToolExecutionContext` and
falling back to the `requestContext`.

**Why a processor and not a `MastraMemory` subclass.** `MastraMemory` (`@mastra/core/memory`) is a
*storage* interface — 13 abstract methods covering thread CRUD, message persistence, working memory
and thread cloning. Cortadel is not a message store: its SDK surface is seven methods (`add`,
`addConversation`, `search`, `list`, `get`, `delete`, `health`) with no thread objects, no message
CRUD and no update, so implementing `MastraMemory` would mean faking most of it. The processor
pipeline is the seam that fits, and it composes with whatever real storage you already use for
conversation history.

## Known limits

- **No `resourceId` without a `threadId`.** Mastra propagates the two together, so
  `agent.generate(text)` with no `memory` option has nothing to scope to — pass
  `memory: { resource, thread }`, set the resource on the `RequestContext`, or pin `userId`.
- **Recall runs once per turn, not per step.** The package implements `processInput` and
  `processOutputResult` only — not `processInputStep` or `processOutputStream` — so nothing is
  recalled mid-loop between tool calls, and nothing runs per streamed chunk.
- **The dedupe and duplicate-turn guards are in-process.** Injected-id sets (200 per thread, 256
  threads) and persist latches live on the processor instance, so a horizontally scaled deployment
  re-injects a memory once per instance and a restart forgets both.
- **`awaitPersist` defaults to `true`**, deviating from the repo-wide `false` — see the note above for
  the serverless reason.
- **`appName` does not reach the automatic write.** The SDK's `addConversation` request carries no app
  field, so `appName` labels searches and `add_memories` writes but not the per-turn persist.
- **Tool renaming is re-keying.** The model-facing name is the registration key; `idPrefix` prefixes
  ids only, which is what Mastra's registry and traces key on.
- **`throwOnError` cannot reach a fire-and-forget persist.** With `awaitPersist: false` the caller has
  already returned, so `onError` is the only signal for that failure — though the latch is released
  either way, so the next identical turn is written rather than skipped.
- **Cortadel does not replace Mastra's conversation history.** It is long-term distilled memory
  alongside whatever storage you already configured, not a `MastraMemory` implementation.
- **Tests are offline.** The suite drives a real `@mastra/core` `Agent` against a stub language model
  and a fake Cortadel client — including an end-to-end check that recalled memories reach the model's
  system prompt and the finished turn reaches `addConversation` — but nothing runs against a live
  Cortadel server in CI, and the covered path is `agent.generate`.

## Requirements

- **Node.js ≥ 22.13** — the package's own `engines` floor, matching `@mastra/core`'s.
- **`@mastra/core` ≥ 1.0 < 2**, declared as a peer dependency and verified against `1.58.0`.
- **`zod` ^3.25 || ^4** — the same range `@mastra/core` peers on. Also a peer dependency.
- **`@cortadel/sdk` ^1.0.0** — a normal dependency, installed for you.
- **A running Cortadel server**: the hosted service at `https://app.cortadel.ai`, or your own
  (`docker compose up` → `http://localhost:3001`, see [Self-hosting](/self-hosting/)). Pass its
  bearer token as `apiKey`, or omit it when auth is disabled — see
  [Authentication](/authentication/).

## Links

- [`@cortadel/mastra` on npm](https://www.npmjs.com/package/@cortadel/mastra)
- [Source: `integrations/mastra`](https://github.com/cortadel/cortadel/tree/main/integrations/mastra)
- [All integrations](/integrations/)
- [Mastra docs — Processors](https://mastra.ai/docs/agents/processors)
