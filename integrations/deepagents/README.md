# Cortadel × DeepAgents

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. This package plugs it into
[DeepAgents](https://github.com/langchain-ai/deepagentsjs) as a first-class `AgentMiddleware`, so a
deep agent recalls what it learned in earlier conversations **before** it plans, and records what it
learned in this one **after** the turn ends — without you writing any retrieval or persistence code.
DeepAgents ships its own memory middleware that reads `AGENTS.md` files off a backend; this is the
same shape, with Cortadel's hybrid search in place of a static file read, plus the write half a
file-backed memory cannot do on its own.

## Install

```bash
npm install @cortadel/deepagents deepagents langchain @langchain/core
# or: pnpm add / yarn add
```

`deepagents`, `langchain` and `@langchain/core` are peer dependencies — the package uses whichever
copies your app already has.

## Quickstart

```ts
import { createDeepAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";
import { createCortadelMemoryMiddleware } from "@cortadel/deepagents";

const agent = createDeepAgent({
  model: "anthropic:claude-sonnet-4-5",
  systemPrompt: "You are a helpful engineering assistant.",
  middleware: [
    createCortadelMemoryMiddleware({
      baseUrl: "http://localhost:3001",   // or https://app.cortadel.ai
      userId: "e2e-demo-user",
      // apiKey: process.env.CORTADEL_API_KEY,   // omit when the server has auth disabled
    }),
  ],
});

// Turn 1 — the exchange is persisted when the turn ends.
await agent.invoke({
  messages: [new HumanMessage("I'm on Project Alpha and we only deploy on Tuesdays.")],
});

// Turn 2 — a fresh run with no shared state. The Tuesday rule is recalled from Cortadel
// and injected into the system message before the model sees the question.
const answer = await agent.invoke({
  messages: [new HumanMessage("Can we ship the release tomorrow?")],
});
console.log(answer.messages.at(-1)?.text);
```

## What you get

### 1. Automatic memory — `createCortadelMemoryMiddleware`

A LangChain v1 `AgentMiddleware` (built with `createMiddleware`, the same primitive DeepAgents uses
for its own built-ins) that hooks three points in the agent lifecycle:

| Hook | Runs | What it does |
|---|---|---|
| `beforeAgent` | once per turn | hybrid-searches Cortadel for the new user message and stores the hits in private state |
| `wrapModelCall` | every model call | renders those hits into the system message for that one call |
| `afterAgent` | once per turn | `addConversation`s the messages added during the turn |

Three details are load-bearing:

- **Retrieval is per *turn*, injection is per *model call*.** A deep agent makes many model calls in
  one turn — planning, tool loops, subagent dispatch — so searching once per call would multiply
  latency and cost for no new information. The recalled set is fetched once and re-rendered on every
  call.
- **The injection is ephemeral.** It rides on a per-call copy of the `ModelRequest`, never on a
  stored message, so recalled memory can never accumulate in the transcript or be persisted back
  into Cortadel as if the user had said it.
- **State is private.** The three state keys are `_`-prefixed, which is how LangChain marks
  middleware state private (`FilterPrivateProps` strips `_`-prefixed keys from the agent's public
  input/output schema). They are still checkpointed, so a thread's persisted-message cursor survives
  across turns.

### 2. Memory tools — `search_memory` and `add_memories`

Built with LangChain's `tool()` helper, so they are ordinary tools you can also hand to
`createDeepAgent({ tools })` or to a subagent. They are registered on the middleware by default;
pass `exposeTools: false` to drop them, or build them standalone:

```ts
import { createCortadelTools } from "@cortadel/deepagents";

const tools = createCortadelTools({ baseUrl: "http://localhost:3001", userId: "e2e-demo-user" });
```

- `search_memory(query, topK = 10)` — hybrid search over the user's long-term memory. Deliberately
  wider than the automatic per-turn recall (5): the model only reaches for it when recall came up
  short.
- `add_memories(memories: string[])` — record durable facts explicitly. The tool reports Cortadel's
  pipeline `event` per fact (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, …), because a successful call does
  not mean a new memory was written.

### Per-user scoping

A Cortadel client is bound to one `userId` at construction — no SDK method takes a user id — so
per-user scoping means one client per user. Leave `userId` unset and the middleware resolves it from
each run, then caches a client per user:

1. `runtime.context[userIdKey]` — from `agent.invoke(input, { context: { user_id } })`.
2. `runtime.configurable[userIdKey]` — from `agent.invoke(input, { configurable: { user_id } })`,
   which is what LangGraph Platform and Studio populate.

Both work out of the box, including when you set a custom `userIdKey`. You do **not** have to add the
key to your own `createDeepAgent({ contextSchema })` for the middleware to see it: LangChain hands a
middleware only the context keys that middleware itself declares, so this one declares `userIdKey`.
Declaring it in your agent's `contextSchema` as well is fine and gives you typing and validation on
`invoke` — the two schemas do not conflict.

An id that is not a non-empty string (or is missing entirely) disables memory for that run with a
one-time warning; it never fails the run.

If you pass a `client` yourself, that client's user wins for every run and runtime ids are ignored
(with a one-time warning) — pass `clientFactory` instead for multi-user agents. See
[`examples/multi-user.ts`](./examples/multi-user.ts).

### Degrading gracefully

Memory is an enhancement, never a dependency. Every failure path fails open:

- A recall failure leaves the turn running with no memories injected.
- A persistence failure leaves the cursor **unadvanced**, so the next turn retries that suffix rather
  than dropping it.
- A tool failure returns an explanatory string to the model instead of throwing (a throwing tool
  aborts the agent's turn).
- An unresolvable user id, or an unusable `baseUrl`, disables memory for that run with a one-time
  warning.

Set `throwOnError: true` to opt into propagation (useful in tests and CI). Pass `onError` to observe
every failure; it observes, `throwOnError` decides. With neither set, a swallowed failure goes to
`console.warn`.

### Persistence awaits by default

`awaitPersist` defaults to `true`, against the usual fire-and-forget default, because `afterAgent` is
the last node of the run: a detached write can be cut off when the run (or the process) ends, and the
persisted-message cursor could not then be advanced honestly. Set it to `false` to trade that
guarantee for latency — a detached write cannot be retried, and `throwOnError` cannot apply to it,
though `onError` still observes it.

## How this differs from `@cortadel/langgraph`

Both packages are Cortadel memory for the LangChain JS stack, and DeepAgents is built on LangGraph,
so they overlap in dependencies but not in seam:

| | `@cortadel/deepagents` (this package) | `@cortadel/langgraph` |
|---|---|---|
| Seam | `AgentMiddleware` → `createDeepAgent({ middleware })` | `BaseStore` → `createDeepAgent({ store })` / `graph.compile({ store })` |
| Granularity | whole turns: recall before, `addConversation` after | individual items: `get`/`put`/`search`/`delete` by namespace and key |
| Who decides what is stored | Cortadel's extraction pipeline distills facts from the dialogue | your graph node, explicitly |
| Works with | DeepAgents and any LangChain v1 `createAgent` | any LangGraph graph, including DeepAgents |

**Want the agent to just remember conversations?** Use this package. **Want a key-value long-term
store your own nodes read and write deliberately?** Use `@cortadel/langgraph`. They compose: pass this
middleware *and* that store to the same `createDeepAgent` call — the middleware never touches
`runtime.store`, so there is no conflict.

## Configuration

Every option on `createCortadelMemoryMiddleware(options)`. `createCortadelTools(options)` accepts the
connection, search and error options plus `provider`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server URL |
| `userId` | `string` | `$CORTADEL_USER_ID` | Static user id. Leave unset for multi-user agents |
| `apiKey` | `string` | `$CORTADEL_API_KEY` | Bearer token. Omit when auth is disabled |
| `appName` | `string` | `"@cortadel/deepagents"` | Recorded on searches for access logging, and as `AddOptions.app` on writes |
| `client` | `CortadelMemoryClient` | — | A caller-owned client. Pins every run to its user |
| `clientFactory` | `(userId) => CortadelMemoryClient` | — | Per-user client construction |
| `userIdKey` | `string` | `"user_id"` | Key on `runtime.context` / `runtime.configurable` holding the user id |
| `topK` | `number` | `5` | Memories recalled automatically per turn (1–50) |
| `searchMode` | `string` | `"hybrid"` | `hybrid`, `text`, or `vector` |
| `rerank` | `boolean` | `false` | Run Cortadel's cross-encoder reranker. More accurate, slower |
| `memoryType` | `string` | — | Restrict recall and tag writes: `episodic`, `semantic`, `procedural` |
| `scopeRecallToSession` | `boolean` | `false` | Pass the LangGraph `thread_id` as Cortadel's `sessionId` on *search*, restricting recall to this thread |
| `writeMemories` | `boolean` | `true` | Persist each turn with `addConversation`. `false` for a read-only agent |
| `awaitPersist` | `boolean` | `true` | Await the write before the hook returns (see above) |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the *assistant* rather than the user |
| `tags` | `string[]` | — | Tags applied to every extracted fact |
| `project` | `string` | — | Cortadel project scope for extracted facts |
| `exposeTools` | `boolean` | `true` | Register `search_memory` / `add_memories` on the middleware |
| `systemPrompt` | `string \| null` | `CORTADEL_SYSTEM_PROMPT` | Prompt fragment; must contain the `{cortadelMemories}` slot. `null` recalls into state without injecting |
| `throwOnError` | `boolean` | `false` | Rethrow Cortadel failures instead of degrading |
| `onError` | `(error) => void` | — | Observe every failure. Independent of `throwOnError` |
| `provider` | `ClientProvider` | — | Share one per-user client cache with separately-built tools |

Environment variables read as fallbacks: `CORTADEL_BASE_URL`, `CORTADEL_USER_ID`, `CORTADEL_API_KEY`.

## Examples

- [`examples/quickstart.ts`](./examples/quickstart.ts) — two turns, memory carried across them.
- [`examples/multi-user.ts`](./examples/multi-user.ts) — one agent serving several users.

## Running the tests

The suite is fully offline: no Cortadel server, no LLM, no keys, no network.

```bash
pnpm install
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit && tsc -p tsconfig.test.json (also checks test/ and examples/)
pnpm build         # tsc -> dist/
```

## Requirements

- Node.js ≥ 20
- `deepagents` ≥ 1.12, `langchain` ≥ 1.5, `@langchain/core` ≥ 1.2
- A running Cortadel server — self-hosted (`docker compose up` → `http://localhost:3001`) or hosted
  at `https://app.cortadel.ai`

## Links

- [Cortadel](https://cortadel.ai)
- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel)
- [DeepAgents (JS)](https://github.com/langchain-ai/deepagentsjs)
