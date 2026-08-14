---
title: Cortadel × OpenAI Agents SDK
description: Long-term memory for the OpenAI Agents SDK — a Session implementation, automatic recall via callModelInputFilter, and memory tools.
---

[Cortadel](https://cortadel.ai) is long-term temporal graph memory for AI agents — a bi-temporal
graph store with hybrid BM25 + vector search. `@cortadel/openai-agents` makes it native to the
[OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/), so an agent
remembers a user across conversations, processes and deployments without you writing any retrieval
plumbing. It plugs into the SDK's own seams — the `Session` interface for conversation history,
`callModelInputFilter` for automatic recall, and the `tool()` helper for explicit memory calls —
so there is no wrapper `Runner` and nothing is monkey-patched.

## Install

```bash
npm install @cortadel/openai-agents @openai/agents zod
```

`@openai/agents` and `zod` are **peer** dependencies — you almost certainly have both already,
since `@openai/agents` itself declares `zod: ^4.0.0` as a peer. The Cortadel TypeScript SDK
([`@cortadel/sdk`](/sdk-typescript/)) comes along as a regular dependency.

## Quickstart

```ts
import { Agent, run } from '@openai/agents';
import { CortadelSession } from '@cortadel/openai-agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a concise assistant. Answer in one sentence.',
  model: 'gpt-4.1-mini',
});

const session = new CortadelSession({
  sessionId: 'chat-1',
  userId: 'e2e-alice',                // the memory namespace
  baseUrl: 'http://localhost:3001',   // or https://app.cortadel.ai
});

try {
  // Turn 1 — stored.
  await run(agent, 'Remember that I use Neovim and that I ship on Fridays.', session.runOptions());

  // Turn 2 — recalled, and it would still be recalled in a brand-new process.
  const answer = await run(agent, 'What editor do I use?', session.runOptions());
  console.log(answer.finalOutput);
} finally {
  await session.close();              // drain any in-flight writes
}
```

`session.runOptions()` returns `{ session, callModelInputFilter }` — **both halves** of automatic
memory in one object. `session` gives you conversation history *and* writes each finished turn to
Cortadel; `callModelInputFilter` searches Cortadel for the question the user just asked and injects
the hits into the model call. Pass only `{ session }` and you get storage without recall.

`runOptions(base?)` copies whatever you hand it rather than clobbering it, so
`session.runOptions({ maxTurns: 5 })` keeps your other run settings. The same pair works on a
`Runner`'s `RunConfig`, which carries `callModelInputFilter` too.

:::note
`baseUrl` and `apiKey` default to `$CORTADEL_BASE_URL` and `$CORTADEL_API_KEY`, so a deployed
agent needs neither in code. An env var that is present but empty counts as unset.
:::

## What you get

### Automatic memory — `CortadelSession`

A `Session` (the SDK's conversation-history interface) with long-term memory layered on top:

| Member | What it does |
|---|---|
| `getSessionId` / `getItems` / `addItems` / `popItem` / `clearSession` | The `Session` interface. Verbatim history, delegated to a transcript session — no memories are mixed in. |
| `addItems` (also) | Distils the finished user↔assistant exchange into Cortadel via `addConversation`. |
| `callModelInputFilter` | A `CallModelInputFilter` bound to this session: searches Cortadel for the latest user message and injects the hits. Stable identity across property reads. |
| `runOptions(base?)` | Run options with the session **and** that filter installed. |
| `tools()` | The two memory tools below, bound to this session's client and retrieval settings. |
| `flush()` | Send everything still owed to Cortadel — background writes included — and wait for it to land. |
| `close()` | `flush()`, then tear down a transcript this session created itself. |

The package also exports `buildClient`, `formatMemoryBlock`, `DEFAULT_APP_NAME`,
`DEFAULT_BASE_URL` (`http://localhost:3001`) and `DEFAULT_MEMORY_HEADER`
(`# Long-term memory (Cortadel)`); a test pins that export list, so an import documented here
cannot quietly disappear.

### Explicit memory — `cortadelMemoryTools()`

Two real `FunctionTool`s, for agents that should decide *when* to remember:

```ts
import { Agent } from '@openai/agents';
import { cortadelMemoryTools } from '@cortadel/openai-agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Search your memory before answering personal questions.',
  tools: cortadelMemoryTools({ userId: 'e2e-alice', baseUrl: 'http://localhost:3001' }),
});
```

| Tool | Parameters | Returns |
|---|---|---|
| `search_memory` | `query: string` | A numbered list of memories, or `"No relevant memories found."` |
| `add_memories` | `text: string` | What the write pipeline actually did — `"Stored."`, `"Already remembered; nothing new stored."`, or `"Stored (event: …)."` for a supersede/invalidate |

Schemas come from Zod objects converted by `tool()`, and are strict. The two shapes compose: give
an agent a `CortadelSession` *and* `tools: session.tools()` for automatic recall plus an explicit
"look it up again" escape hatch.

### The automatic-memory seam

Recall happens in `callModelInputFilter`, storage happens in `addItems`, and both are ephemeral in
the right direction: the injected block is stripped before anything is written down, so context
never accumulates memories turn after turn and no injected text is ever stored back as a memory.
Recall is cached one entry deep and invalidated whenever the conversation advances, so a
tool-using turn that makes five model calls still searches Cortadel once.

### Failure behaviour

Memory degrades; it never takes the agent down. With Cortadel unreachable, a search returns
nothing and the model call proceeds unchanged, a write is dropped, and a tool call tells the model
memory is unavailable (`"Memory is currently unavailable. Answer without it."`). Two independent
knobs govern that, on both `CortadelSession` and `cortadelMemoryTools`:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `throwOnError` | `boolean` | `false` | Propagate memory failures to the caller instead of degrading. On a tool it passes `errorFunction: null` to `tool()`, so the throw fails the run instead of being formatted for the model. |
| `onError` | `(error: unknown) => unknown` | unset | Called with the thrown value on **every** memory failure. May return a promise. |

`onError` *observes*; `throwOnError` *propagates* — they compose. With no callback set, a swallowed
failure is `console.warn`ed; setting a callback replaces that log rather than doubling it. A
callback that throws is itself logged and dropped, so your telemetry going down cannot become the
agent's problem.

## Configuration

### `new CortadelSession(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `sessionId` | `string` | *required* | Conversation id. Keys the transcript, is returned by `getSessionId()`, and is sent as Cortadel's `ConversationOptions.sessionId`. |
| `userId` | `string` | *required* | The memory namespace owner. **One session serves one user** — a Cortadel client is bound to a user id at construction and no method takes one. |
| `baseUrl` | `string` | `$CORTADEL_BASE_URL` → `http://localhost:3001` | Cortadel server URL. |
| `apiKey` | `string` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server runs with auth disabled. |
| `appName` | `string` | `"cortadel-openai-agents"` | Recorded on searches, for access logging. It does **not** reach writes: the conversation API carries no app field, and `session.tools()` does not forward `appName`, so tool writes are stamped `cortadel-openai-agents` regardless. |
| `client` | `CortadelClient` | — | Use a pre-built client instead of constructing one. It must already be scoped to `userId`. |
| `transcript` | `Session` | `new MemorySession({ sessionId })` | Where verbatim history lives. Pass a durable `Session` to survive restarts. |
| `topK` | `number` | `5` | Memories recalled per turn. |
| `searchMode` | `string` | `"hybrid"` | `hybrid`, `text`, or `vector`. |
| `rerank` | `string` | — | Set `"cross_encoder"` to rerank server-side. |
| `minScore` | `number` | — | Drop hits whose `rrfScore` is below this. A hit the server ranked without an `rrfScore` is kept. |
| `scopeRecallToSession` | `boolean` | `false` | Recall only facts extracted from *this* conversation. Off by default — long-term memory earns its name by crossing conversations. |
| `injectAs` | `"instructions" \| "input"` | `"instructions"` | Append the block to the system prompt, or insert it as a system message immediately before the latest user message. Anything else throws at construction. |
| `memoryHeader` | `string` | `"# Long-term memory (Cortadel)"` | Heading of the injected block; also the marker that prevents double-injection. |
| `retrieve` | `boolean` | `true` | Set `false` to store without recalling. |
| `store` | `boolean` | `true` | Set `false` to recall without storing (a read-only agent). |
| `awaitPersist` | `boolean` | `false` | Await the write before the turn returns. See below. |
| `tags` | `string[]` | — | Tags applied to every fact extracted from this conversation. |
| `project` | `string` | — | Project scope for extracted facts. |
| `throwOnError` | `boolean` | `false` | Surface Cortadel failures instead of degrading. |
| `onError` | `(error: unknown) => unknown` | — | Observe every Cortadel failure; replaces the warning log. |

Every one of those settings is also a public, mutable field on the instance, so `session.topK = 8`
or `session.retrieve = false` takes effect on the next turn.

**`awaitPersist` defaults to `false`** — fire-and-forget, so Cortadel's extraction latency stays
off the turn. That is safe in Node, where a pending `fetch` keeps the event loop alive, so even a
script that falls off the end lands its write. It is *not* safe where the runtime can freeze the
process the moment your handler returns (serverless) or where you call `process.exit()`. There,
either set `awaitPersist: true` or `await session.flush()` before returning — `flush()` is a hard
synchronisation point whatever `awaitPersist` says, and `close()` calls it for you.

### `cortadelMemoryTools(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `userId` | `string` | — | The memory namespace owner. Required unless `client` is given; passing both throws, because a client is already scoped. |
| `client` | `CortadelClient` | — | A pre-built client, already scoped to the intended user. You own its lifecycle. |
| `baseUrl` / `apiKey` / `appName` | `string` | as above | Same meanings as on the session. `appName` also labels facts written by `add_memories`. |
| `topK` | `number` | `10` | Hits `search_memory` returns. |
| `searchMode` | `string` | `"hybrid"` | `hybrid`, `text`, or `vector`. |
| `rerank` | `string` | — | Set `"cross_encoder"` to rerank server-side. |
| `minScore` | `number` | — | Drop hits below this `rrfScore`. |
| `sessionId` | `string` | — | Restrict `search_memory` to one conversation. Omit to search everything the user has. |
| `throwOnError` | `boolean` | `false` | Fail the run on a memory failure instead of telling the model memory is unavailable. |
| `onError` | `(error: unknown) => unknown` | — | Observe every Cortadel failure. |

Two `topK` values, deliberately. **The standalone factory defaults to `10`**, the Cortadel SDK's
own `SearchOptions` default: an agent that *chose* to call `search_memory` can spend more context
on the answer than a per-turn injection that fires whether or not memory was needed.
**`session.tools()` inherits the session's settings instead** — its `topK` (5 by default), its
`searchMode`, `rerank`, `minScore`, its `scopeRecallToSession` and its error handling — so an
explicit tool call and an automatic recall never disagree about what the user's memory contains.

### Multiple users

Scoping happens at construction, so serve several users by building one session (or one toolset)
per user:

```ts
const sessions = new Map(
  ['e2e-alice', 'e2e-bob'].map((userId) => [
    userId,
    new CortadelSession({ sessionId: `chat-${userId}`, userId }),
  ]),
);
```

## How it works

Three extension points, all of them the SDK's own.

**1. `Session` — history.** `@openai/agents-core/dist/memory/session.d.ts` declares five required
members: `getSessionId`, `getItems`, `addItems`, `popItem`, `clearSession`. (This is not the same
surface as the Python SDK's `Session` protocol — TypeScript adds `getSessionId()`, and `popItem()`
resolves to `undefined` rather than `None`. Version 0.15.0 also declares a stack of *optional*
capability interfaces — `RunContextAwareSession`, `SessionHistoryTransactionAwareSession`,
`OpenAIResponsesCompactionAwareSession` — which this package does not implement.)

A `Session`, though, is a **verbatim transcript store**, and Cortadel is not one. The runner
round-trips items through it and reconciles them against what the model actually saw
(`runner/sessionPersistence.d.ts`). Cortadel deliberately does not store transcripts: it distils
conversations into deduplicated facts, so two identical turns collapse into one and item order is
not preserved. Backing `getItems`/`popItem` with Cortadel would corrupt the run loop. So
`CortadelSession` is a **wrapper session**: it holds a transcript `Session` (the SDK's own
in-memory `MemorySession` by default) for exact short-term fidelity, and layers long-term memory
on top of `addItems`.

**2. `callModelInputFilter` — recall.** `CallModelInputFilter`
(`@openai/agents-core/dist/runner/conversation.d.ts`) is
`(args: CallModelInputFilterArgs) => ModelInputData | Promise<ModelInputData>`, wired in through
`RunConfig.callModelInputFilter` or the run options. `run.d.ts` describes it as "invoked
immediately before calling the model, allowing callers to edit the system instructions or input
items that will be sent to the model" — which is exactly this job.

`getItems()` cannot do it: it takes no query, and the runner calls it *before* the new turn's
input exists, so on the very first turn there is nothing at all to search on. Lifecycle hooks
(`agent.on('agent_start', …)`, `runner.on(…)`) were the other candidate and are the wrong one:
`AgentHookEvents`/`RunHookEvents` in `lifecycle.d.ts` are observation-only — listeners return
`void` and the emitter ignores them, so nothing a hook does can reach the model input.

**The subtlety the TypeScript SDK adds:** unlike the Python SDK — where `call_model_input_filter`
receives a copy that is thrown away — the TypeScript runner **persists what the filter produced**.
`applyCallModelInputFilter` returns `persistedItems`, "the normalized clones we should commit to
session memory", and tags filter-added items `'injected'` in `sourceMatchKinds`. Left alone, an
`injectAs: "input"` block would land in the transcript, replay as history next turn, and trip the
double-injection guard so fresh recall never happened. `CortadelSession.addItems` therefore strips
its own block — recognised by `memoryHeader` — before writing anything down, which is what keeps
injection ephemeral in both injection modes.

`injectAs` picks where the block goes. `"instructions"` appends it to the system prompt, the
plainest reading of the filter's own contract. `"input"` inserts it as a system message
immediately before the latest user message, which leaves the instructions and earlier history
byte-identical between turns — so a provider's prompt-prefix cache still hits — and puts the facts
next to the question.

**3. `tool()` — explicit memory.** Both tools are built with the SDK's own tool primitive
(`@openai/agents-core/dist/tool.d.ts`), so the JSON schema is derived from the Zod object and the
result is a real `FunctionTool`. `tool()` throws `UserError('Strict mode is required for Zod
parameters')` unless `strict` stays on, so these tools are strict. `tool()` also installs a default
`errorFunction` that converts any throw in the tool body into a model-visible string; passing
`null` explicitly disables it, which is how `throwOnError: true` reaches a tool — verified in
`tool.mjs`, where `resolveToolFailure` does `if (!toolErrorFunction) { throw error; }`.

## Known limits

- **Only message items become memories.** `AgentInputItem` is a union of message items, function
  calls, function-call outputs, reasoning items and compaction markers; the package stores text
  from `user` and `assistant` messages only. Tool plumbing and system messages are dropped, not
  stored.
- **Recall is keyed on the latest user message.** An image-only or tool-only turn has nothing to
  search on, so it injects nothing and the model call is returned untouched.
- **`clearSession()` clears the transcript, not Cortadel.** Closing a chat window is not a request
  to forget the user. Delete memories deliberately with `client.delete([...])`.
- **`popItem()` rewinds history, not memory.** An unflushed pending message matching the popped
  item *is* dropped, but facts already written are bi-temporal — superseded, never silently
  erased.
- **A failed write drops its batch** rather than retrying forever and growing without bound while
  the server is down.
- **A fire-and-forget write cannot honour `throwOnError`.** Nothing awaits it, so a rejection would
  surface as an unhandled rejection and crash Node. Those failures always go to `onError` or the
  log; use `awaitPersist: true` or `flush()` if you need them to propagate.
- **One run takes one filter.** `runOptions()` replaces a `callModelInputFilter` already on the
  options you passed and warns that it did — compose them yourself if you need both.
- **A `client` you supply is trusted to match `userId`.** Nothing cross-checks the two.
- **The recall cache is per instance and in-process**, so a horizontally scaled deployment searches
  once per instance.
- **Sessions and server-managed conversations.** The package README says the SDK forbids combining
  a `session` with `conversationId` / `previousResponseId`; at the pinned peer version that is no
  longer true — `run.mjs` explicitly handles `serverManagesConversation && session` by deferring
  prior turns to the server and persisting only the new delta locally, and the only exclusivity the
  runner enforces is `conversationId` *versus* `previousResponseId`. The combination is not covered
  by this package's tests, so treat it as untested rather than forbidden; `cortadelMemoryTools` is
  the belt-and-braces option there.
- **The test suite is fully offline** — a fake Cortadel client and a fake `Model`, with several
  tests driving a real `run()` and asserting on what the runner actually sent. Nothing is exercised
  against a live Cortadel server in CI, so wire-level behaviour rests on
  [`@cortadel/sdk`](/sdk-typescript/) and its own conformance suite.
- **Verified against `@openai/agents` 0.15.0** — the peer range allows anything below 1.0.0, but
  0.15.0 is what the package is developed and tested against.

## Requirements

- **Node** ≥ 20 (ESM-only)
- **`@openai/agents`** ≥ 0.15.0, < 1.0.0 — peer dependency
- **`zod`** ^4 — peer dependency, the major `@openai/agents` itself requires
- **`@cortadel/sdk`** ^1.0.0 — a regular dependency, installed for you
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` (→ `http://localhost:3001`). See [Self-hosting](/self-hosting/) and
  [Authentication](/authentication/) for the API key.

## Links

- [`@cortadel/openai-agents` on npm](https://www.npmjs.com/package/@cortadel/openai-agents) —
  published at `0.1.0`, with a Sigstore provenance attestation.
- [Package source](https://github.com/cortadel/cortadel/tree/main/integrations/openai-agents) —
  including its README and two runnable examples.
- [All integrations](/integrations/) — the other eleven, and the shared option vocabulary.
- [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
