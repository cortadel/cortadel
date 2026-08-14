---
title: Cortadel × DeepAgents
description: An AgentMiddleware that recalls before the turn and persists after it, plus search_memory / add_memories tools for a deep agent.
---

[Cortadel](https://cortadel.ai) is long-term temporal graph memory for AI agents — a bi-temporal
graph store with hybrid BM25 + vector search. `@cortadel/deepagents` plugs it into
[DeepAgents](https://github.com/langchain-ai/deepagentsjs) as a first-class `AgentMiddleware`, so a
deep agent recalls what it learned in earlier conversations **before** it plans, and hands the
finished turn to Cortadel's extraction pipeline **after** it answers — with no retrieval or
persistence code of your own. DeepAgents already ships a memory middleware of its own
(`createMemoryMiddleware`), which loads `AGENTS.md` files off a filesystem backend; this is the same
shape, with hybrid search in place of a static file read, plus the write half a file-backed memory
cannot do.

## Install

```bash
npm install @cortadel/deepagents deepagents langchain @langchain/core
```

`deepagents`, `langchain` and `@langchain/core` are **peer** dependencies — the package uses
whichever copies your app already has. Only `@cortadel/sdk` and `zod` are pulled in as real
dependencies.

:::note
**Published at `0.1.0`** on npm, with a Sigstore provenance attestation — the command above works
as written.
:::

## Quickstart

Point it at a local server (`docker compose up` → `http://localhost:3001`) or at the hosted service
(`https://app.cortadel.ai`), install the provider package for whichever model you name
(`npm install @langchain/anthropic` for the string below) and export that provider's key.

```ts
import { createDeepAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";
import { createCortadelMemoryMiddleware } from "@cortadel/deepagents";

const agent = createDeepAgent({
  model: "anthropic:claude-sonnet-4-5",
  systemPrompt: "You are a helpful engineering assistant.",
  middleware: [
    createCortadelMemoryMiddleware({
      baseUrl: "http://localhost:3001",        // or https://app.cortadel.ai
      userId: "e2e-demo-user",
      // apiKey: process.env.CORTADEL_API_KEY, // omit when the server has auth disabled
      onError: (error) => console.error("[cortadel] memory degraded:", error),
    }),
  ],
});

// Turn 1 — `afterAgent` hands the exchange to Cortadel once the turn ends.
await agent.invoke({
  messages: [new HumanMessage("I'm on Project Alpha and we only deploy on Tuesdays.")],
});

// Turn 2 — a fresh run with no shared state. `beforeAgent` recalls the Tuesday rule and
// `wrapModelCall` injects it into the system message before the model sees the question.
const answer = await agent.invoke({
  messages: [new HumanMessage("Can we ship the release tomorrow?")],
});
console.log(answer.messages.at(-1)?.text);
```

## What you get

One `createCortadelMemoryMiddleware()` call gives you both halves. `createCortadelTools()` builds
the tools on their own if that is all you want.

### The automatic-memory seam — an `AgentMiddleware`

`createCortadelMemoryMiddleware(options)` returns a LangChain v1 `AgentMiddleware`, built with
`createMiddleware` — the same primitive DeepAgents builds its own filesystem, subagent and
summarization middleware with — that you drop into `createDeepAgent({ middleware: [...] })`. It
hooks three points of the agent lifecycle:

| Hook | Runs | What it does |
|---|---|---|
| `beforeAgent` | once per turn | hybrid-searches Cortadel for the latest human message and stores the hits in private state |
| `wrapModelCall` | every model call | renders those hits into the system message for that one call |
| `afterAgent` | once per turn | hands the messages added during the turn to `addConversation` |

### The tools — `search_memory` and `add_memories`

Built with LangChain's `tool()` helper, so they are ordinary `ClientTool`s: the middleware registers
them by default (`exposeTools`), and you can equally pass them to `createDeepAgent({ tools })` or to
a subagent's own `tools`.

- **`search_memory(query, topK?)`** — hybrid search over the user's long-term memory. `topK`
  defaults to **10** and is bounded 1–50 by the tool's own schema — deliberately wider than the
  middleware's automatic per-turn recall of 5, since the model only reaches for the tool when recall
  came up short. Results come back as a numbered list, each hit carrying its `[recorded YYYY-MM-DD]`
  date when Cortadel returned one.
- **`add_memories(memories: string[])`** — record durable facts explicitly. Blank entries are
  dropped before anything is sent; each surviving fact is written with the middleware's `appName` as
  its `app`. The reply reports Cortadel's pipeline `event` per fact (`ADD`, `SKIP_DUPLICATE`, …),
  because a successful call does **not** mean a new memory was written — the write pipeline may have
  deduplicated or superseded it.

Build them standalone with the same connection, search and failure options:

```ts
import { createCortadelTools } from "@cortadel/deepagents";

const tools = createCortadelTools({ baseUrl: "http://localhost:3001", userId: "e2e-demo-user" });
```

:::note
**Composing with `@cortadel/langgraph`.** The two packages take different seams, and the store one
composes with this middleware — pass `CortadelStore` and this middleware to the same
`createDeepAgent` call, since the middleware never touches `runtime.store`. Do **not** stack this
with that package's `CortadelMemory` recall/remember nodes: both recall and both persist, so you
would pay for each twice.
:::

## Configuration

Every option on `createCortadelMemoryMiddleware(options)`. `createCortadelTools(options)` accepts
the connection, search and failure rows plus `provider` — the write, surface and prompt rows are
middleware-only.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server URL |
| `userId` | `string` | `$CORTADEL_USER_ID` | Static user id. Leave unset for multi-user agents that resolve it per run |
| `apiKey` | `string` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server has auth disabled |
| `appName` | `string` | `"@cortadel/deepagents"` | Recorded on searches for access logging, and set as `AddOptions.app` on writes |
| `client` | `CortadelMemoryClient` | — | A caller-owned client. Pins every run to that client's user |
| `clientFactory` | `(userId: string) => CortadelMemoryClient` | — | Per-user client construction (custom `fetch`, timeouts, …) |
| `userIdKey` | `string` | `"user_id"` | Key on `runtime.context` / `runtime.configurable` holding the user id |
| `provider` | `ClientProvider` | — | Share one per-user client cache with separately-built tools. When given, the connection options above are ignored |
| `topK` | `number` | `5` | Memories recalled automatically per turn (Cortadel accepts 1–50) |
| `searchMode` | `string` | `"hybrid"` | `hybrid`, `text`, or `vector` |
| `rerank` | `boolean` | `false` | Send `rerank: "cross_encoder"` — Cortadel's cross-encoder reranker. More accurate, slower |
| `memoryType` | `string` | — | Restrict recall and tag writes: `episodic`, `semantic`, `procedural` |
| `scopeRecallToSession` | `boolean` | `false` | Pass the LangGraph `thread_id` as Cortadel's `sessionId` on *search*, restricting recall to this thread |
| `writeMemories` | `boolean` | `true` | Persist each turn with `addConversation`. `false` for a read-only agent |
| `awaitPersist` | `boolean` | `true` | Await the write before `afterAgent` returns (see [Known limits](#known-limits)) |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the *assistant* rather than the user |
| `tags` | `string[]` | — | Tags applied to every fact extracted from this agent's conversations |
| `project` | `string` | — | Cortadel project scope for extracted facts (e.g. a repo name) |
| `exposeTools` | `boolean` | `true` | Register `search_memory` / `add_memories` on the middleware |
| `systemPrompt` | `string \| null` | `CORTADEL_SYSTEM_PROMPT` | Prompt fragment injected into the system message; must contain the `{cortadelMemories}` slot. `null` recalls into state without injecting |
| `throwOnError` | `boolean` | `false` | Rethrow Cortadel failures instead of degrading |
| `onError` | `(error: unknown) => void` | — | Callback handed every failure. Independent of `throwOnError`: it observes, it does not decide |

Environment variables read as fallbacks: `CORTADEL_BASE_URL`, `CORTADEL_USER_ID`,
`CORTADEL_API_KEY`. A variable set to the empty string counts as unset.

An invalid `systemPrompt` is the one thing that fails loudly, at wiring time: a non-string throws
`TypeError`, and a string without the `{cortadelMemories}` slot throws `Error`.

## How it works

**The extension point is `CreateDeepAgentParams.middleware`** — the array `createDeepAgent` appends
to its own built-in middleware stack, and the one seam DeepAgents gives you for adding behaviour to
every turn. What you put in it is a LangChain v1 `AgentMiddleware`; this package produces one from
`createMiddleware({ name: "CortadelMemoryMiddleware", stateSchema, contextSchema, tools,
beforeAgent, wrapModelCall, afterAgent })`.

**Retrieval is per *turn*, injection is per *model call*.** A deep agent makes many model calls in
one turn — planning, tool loops, subagent dispatch — so the search lives in `beforeAgent`, not
`beforeModel`: searching per call would multiply latency and cost by the length of the loop for no
new information. The recalled set is fetched once, and `wrapModelCall` re-renders it into the system
message on every call, so it is present for the whole loop without being re-fetched.

**The injection is ephemeral.** `wrapModelCall` appends the rendered block to a *copy* of the
`ModelRequest`'s `systemMessage` (via `SystemMessage.concat`) and hands that to the next handler.
Nothing is written back into `messages`, so recalled memory can never accumulate in the transcript,
and can never be persisted back to Cortadel as if the user had said it.

**State is private but checkpointed.** The middleware's `stateSchema` declares exactly three keys,
all `_`-prefixed: `_cortadelMemories` (the hits for this turn), `_cortadelRecallQuery` (the message
they were recalled for, so a run resumed after an interrupt does not search again for the same text)
and `_cortadelPersistedCount` (how many messages have already been written). LangChain's
`FilterPrivateProps` strips `_`-prefixed keys out of the agent's public input/output schema, while
the checkpointer still carries them across turns on a thread — which is what lets `afterAgent` send
only the suffix added since the last write instead of re-ingesting the whole history.

**The middleware declares the user-id key on its own `contextSchema`.** LangChain's middleware node
does not hand a middleware the run's context: it builds a *fresh* object per hook call containing
only the keys that middleware itself declared. Without the declaration, a middleware sees a frozen
empty `runtime.context`, so `agent.invoke(input, { context: { user_id } })` would reach the tools
(which go through `ToolNode`, where the raw run config survives) while automatic recall and
persistence silently sat out the run. Two consequences worth knowing:

- **You do not have to add the key to your own `createDeepAgent({ contextSchema })`.** Declaring it
  there as well is fine — it gives you typing and validation at the `invoke` call — and the two
  schemas do not conflict.
- **The declared type is `unknown`, not `string`.** The schema is parsed on every hook call, so a
  stricter type would turn a host that passes a numeric `user_id` into a `ZodError` thrown from
  inside the agent graph. Memory is an enhancement, never a dependency: a bad id costs the run its
  memory, not its answer.

**Per-user scoping resolves a client per run.** A Cortadel client is bound to one `userId` at
construction — no SDK method takes a user id — so `ClientProvider` looks for a non-empty string at
`runtime.context[userIdKey]`, then `runtime.configurable[userIdKey]` (which is what LangGraph
Platform and Studio populate), and returns a cached client for that user, building one on first use.
LangGraph's `thread_id` comes from `configurable`, which is never filtered, and is what the package
passes as Cortadel's `sessionId`.

**The tools read the same run through `ToolRuntime`.** `tool()`'s two-argument form hands the
handler a `ToolRuntime` carrying `context`, `config` and `store`; both runtime shapes are normalised
to one internal `RunScope` before anything looks at them, so the tools and the hooks always agree
about who the user is. The run's `AbortSignal` is threaded into the search and into an awaited
write.

**Only human/assistant dialogue is persisted.** System messages, tool messages and assistant
messages whose only payload is tool calls are dropped before `addConversation` is called — a deep
agent's system prompt is a multi-kilobyte harness instruction and tool output is transcript noise,
neither of which is a durable fact about the user.

## Known limits

- **`awaitPersist` defaults to `true`**, against the repo-wide fire-and-forget default. `afterAgent`
  is the last node of the run: a detached write can be cut off when the run (or the process) ends,
  and the persisted-message cursor could not then be advanced honestly. Set it to `false` to trade
  that guarantee for latency — a detached write is deliberately sent with no `AbortSignal`, cannot
  be retried, and `throwOnError` cannot apply to it (there is no caller left to throw to), though
  `onError` still observes it.
- **A failed write leaves the cursor unadvanced**, so the next turn retries that suffix rather than
  dropping it — at the cost of re-sending messages a partially-succeeded write may already have
  ingested. A turn whose new messages are tool traffic only also leaves the cursor put; those
  messages are simply skipped again next time.
- **`tags` and `project` apply to the automatic write only.** The `add_memories` tool sends `app`
  and `memoryType` and nothing else, so facts the model records explicitly are not tagged or scoped
  to a project.
- **`scopeRecallToSession` applies to automatic recall only.** The `search_memory` tool never sets a
  session id. Writes, meanwhile, always carry the LangGraph `thread_id` as `sessionId` when the run
  has one, whatever the flag says — the flag narrows *reads*.
- **Recall is keyed on the latest human message.** A turn with no human message searches nothing,
  and a resumed run whose last human message is unchanged reuses the hits it already has.
- **`add_memories` writes one fact per call**, sequentially, so a long list costs one round trip per
  fact.
- **Only the tool's `topK` is validated locally** (1–50, by its schema). The middleware's `topK` is
  passed straight through to the server.
- **Passing `client` pins every run to that client's user**, and a run carrying a different id is
  ignored with a one-time warning. Multi-user agents pass `clientFactory` instead.
- **An unresolvable user id — missing, or anything that is not a non-empty string — or an unusable
  `baseUrl` disables memory for that run** with a one-time `console.warn`, never a failed run. Set
  `throwOnError: true` to opt into propagation (useful in tests and CI); pass `onError` to observe
  every failure. With neither set, a swallowed failure goes to `console.warn`.
- **The test suite is fully offline.** It drives a real `createDeepAgent` with a fake tool-calling
  model and a stubbed Cortadel client — no server, no LLM, no network — so wire-level behaviour
  rests on [`@cortadel/sdk`](/sdk-typescript/) and its own conformance suite rather than on this
  package's tests.
- **ESM only.** The package publishes a single `import` condition; there is no CommonJS build.

## Requirements

- **Node.js ≥ 20**
- **`deepagents` ≥ 1.12, `langchain` ≥ 1.5, `@langchain/core` ≥ 1.2** — peer dependencies, developed
  against 1.12.3 / 1.5.8 / 1.2.7
- **A running Cortadel server** — the hosted service at `https://app.cortadel.ai`, or your own
  (`docker compose up` → `http://localhost:3001`, see [Self-hosting](/self-hosting/)). Pass
  `apiKey` unless the server runs with auth disabled — see [Authentication](/authentication/).

## Links

- [`@cortadel/deepagents` on npm](https://www.npmjs.com/package/@cortadel/deepagents)
- [Source: `integrations/deepagents`](https://github.com/cortadel/cortadel/tree/main/integrations/deepagents)
- [All integrations](/integrations/)
