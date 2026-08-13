# Cortadel × Vercel AI SDK

Long-term memory for [AI SDK](https://ai-sdk.dev) agents, backed by
[**Cortadel**](https://github.com/cortadel/cortadel) — self-hosted long-term temporal graph memory
for AI agents (a bi-temporal graph store with hybrid BM25 + vector search). Models are stateless:
every `generateText` call starts from nothing, so an agent forgets a user's preferences the moment
the conversation ends. This package closes that gap in the two places the AI SDK gives you for it —
a **language-model middleware** that recalls before each call and stores after each turn without
your code asking, and a pair of **tools** the agent can call when it wants to remember something
deliberately.

## Install

```bash
npm install @cortadel/vercel-ai-provider
# or: pnpm add @cortadel/vercel-ai-provider / yarn add @cortadel/vercel-ai-provider
```

ESM-only, Node ≥ 22. `ai` and `zod` are peer dependencies — you almost certainly have both already.

## Quickstart

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { cortadelMemory } from "@cortadel/vercel-ai-provider";

const model = wrapLanguageModel({
  model: openai("gpt-4.1-mini"),
  middleware: cortadelMemory({
    baseUrl: "http://localhost:3001",
    userId: "alice",
    // apiKey: "<token>",   // omit when the server runs with auth disabled
  }),
});

// Turn 1 — nothing here mentions memory.
await generateText({ model, prompt: "I always deploy on Fridays and I prefer metric units." });

// Turn 2 — a new conversation with no message history, and it still knows.
const { text } = await generateText({ model, prompt: "When do I usually ship?" });
console.log(text);
```

Any AI SDK model works — the middleware wraps whatever you already use, and `wrapProvider` /
`createProviderRegistry` accept it too if you would rather apply memory across a whole provider:

```ts
const provider = wrapProvider({ provider: openai, languageModelMiddleware: memory });
```

## What you get

### 1. `cortadelMemory(options)` — automatic memory

A `LanguageModelMiddleware` for `wrapLanguageModel`. It hooks all three middleware seams:

| Seam | What it does |
|---|---|
| `transformParams` | Searches Cortadel with the latest user message and injects the hits as a system message, placed after your own system prompt and before the conversation. |
| `wrapGenerate` | Hands the finished turn to `addConversation`, which distills it into atomic facts. |
| `wrapStream` | The same, accumulated from the token stream and written when it closes. |

Three behaviours worth knowing, because they are the difference between this and a naive wrapper:

- **One search per turn, not per step.** Every step of a tool-calling loop re-enters the
  middleware with the same trailing user message. A short-lived cache keyed on
  `(user, session, query)` collapses those into a single search.
- **Unfinished turns are not stored.** A generation that ends in `tool-calls` is mid-loop, so the
  write is deferred until the step that actually answers. Turns are also fingerprinted, so a retry
  cannot write the same exchange twice.
- **Memory never takes the agent down.** Both halves are wrapped. If Cortadel is unreachable,
  recall returns the prompt untouched and persistence is dropped; you hear about it through
  `onError` — or, if you set none, through `console.warn` — and the model call proceeds regardless.
  Set `throwOnError: true` when you would rather the run fail than answer without memory.

### 2. `cortadelTools(options)` — memory the agent drives

A `ToolSet` with `search_memory` and `add_memories`, named to match Cortadel's MCP tools so an
agent behaves the same whichever surface it reaches memory through.

```ts
import { generateText, stepCountIs } from "ai";
import { cortadelTools } from "@cortadel/vercel-ai-provider";

const result = await generateText({
  model: openai("gpt-4.1-mini"),
  tools: cortadelTools({ baseUrl: "http://localhost:3001", userId: "alice" }),
  stopWhen: stepCountIs(5),
  prompt: "What do you remember about my deployment habits?",
});
```

| Tool | Input | Returns |
|---|---|---|
| `search_memory` | `{ query: string, topK?: number }` | `{ memories: [{ id, content, score?, createdAt? }], count, error? }` |
| `add_memories` | `{ memories: string[] }` | `{ stored, duplicates, ids, error? }` |

Failures come back as an `error` field rather than a thrown exception, so a memory outage degrades
into an agent that can still answer instead of a run that aborts. `throwOnError: true` flips that
if you want the tool call to fail loudly instead.

The two compose: use the middleware for always-on context and the tools for deliberate recall, both
against one shared `client`.

## Scoping memory to a user

A Cortadel client is bound to **one user id at construction** — no method takes a user id. So
per-user scoping means one client per user, and this package handles that for you: give it
`baseUrl` and it builds and caches a client per user id.

```ts
// Default user, overridden per request:
await generateText({
  model,
  prompt: "What do you remember about me?",
  providerOptions: { cortadel: { userId: "bob", sessionId: "thread-42" } },
});
```

`providerOptions.cortadel` accepts `userId`, `sessionId`, `recall` and `persist`. Other providers
ignore the namespace, so it is safe to leave in place. Note that passing a pre-built `client`
instead of `baseUrl` pins the middleware to that client's single user — a per-request `userId` is
then ignored, because a client's own user id is fixed and not readable back out.

**Tools are always single-user**, deliberately: the user id is not part of any tool's input schema,
so nothing the model reads can talk it into fetching another user's memories. For a multi-tenant
server, build a tool set per request.

## Configuration

### Connection (both `cortadelMemory` and `cortadelTools`)

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | — | Cortadel server URL, e.g. `https://app.cortadel.ai` or `http://localhost:3001`. Required unless `client` is given. |
| `userId` | `string` | — | User that owns the memories. Required with `baseUrl`. |
| `apiKey` | `string` | — | Sent as `Authorization: Bearer <key>`. Omit when auth is disabled. |
| `appName` | `string` | `"cortadel-vercel-ai-provider"` | App name recorded for access logging on searches. Defaults to this package's own npm name. |
| `client` | `CortadelClient` | — | A client you built yourself. Mutually exclusive with `baseUrl`; pins to one user. |
| `timeoutMs` | `number` | `100000` | Per-request timeout. `0` disables it. |
| `fetch` | `typeof fetch` | global | Custom fetch. Never mutated. |
| `clientCacheSize` | `number` | `64` | Max per-user clients kept alive. |
| `onError` | `(error, { phase, userId }) => void` | — | Observes any Cortadel failure. `phase` is `"recall"` or `"persist"`. With no callback, a swallowed failure is logged through `console.warn`. |
| `throwOnError` | `boolean` | `false` | Propagate memory failures to the caller instead of degrading. See below. |

### `cortadelMemory` — recall

| Option | Type | Default | Meaning |
|---|---|---|---|
| `recall` | `boolean` | `true` | Search and inject before each model call. |
| `topK` | `number` | `5` | Memories to inject (1–50). Tighter than the `search_memory` tool's `10`, because automatic injection pays for every hit in every prompt. |
| `mode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Retrieval arm. Hybrid fuses BM25 + vector with RRF. |
| `rerank` | `"cross_encoder"` | — | Rerank with the server's local cross-encoder. Costs a model pass. |
| `memoryType` | `"episodic" \| "semantic" \| "procedural"` | — | Restrict recall to one cognitive type. |
| `sessionId` | `string` | — | Group recalled and stored facts under a session. |
| `minScore` | `number` | — | Drop hits below this `rrfScore`. Unscored hits are kept. |
| `formatMemories` | `(hits, { query, userId }) => string` | built-in | Render the injected block. |
| `recallCacheTtlMs` | `number` | `60000` | How long an identical `(user, session, query)` recall is reused. `0` disables. |
| `recallCacheSize` | `number` | `32` | Max cached recalls. |

### `cortadelMemory` — persistence

| Option | Type | Default | Meaning |
|---|---|---|---|
| `persist` | `boolean` | `true` | Store each completed turn with `addConversation`. |
| `awaitPersist` | `boolean` | `false` | Await the write before the call resolves. **Turn this on in serverless/edge handlers**, where a background promise is killed when the handler returns. |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the assistant rather than the user. |
| `tags` | `string[]` | — | Tags applied to every stored fact. |
| `project` | `string` | — | Project scope applied to every stored fact. |

### `cortadelTools`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `search.topK` | `number` | `10` | Default result count when the model does not ask for one (the Cortadel SDK's own search default). The model can override it per call. |
| `search.mode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Retrieval arm. |
| `search.rerank` | `"cross_encoder"` | — | Cross-encoder rerank. |
| `search.memoryType` | `"episodic" \| "semantic" \| "procedural"` | — | Restrict to one cognitive type. |
| `search.sessionId` | `string` | — | Restrict to one session. |
| `search.minScore` | `number` | — | Drop hits below this `rrfScore`. |
| `add.app` | `string` | — | App name recorded as each memory's creator. |
| `add.infer` | `boolean` | `true` | When `false`, store verbatim and skip background extraction. Dedup still applies. |
| `add.memoryType` | `"episodic" \| "semantic" \| "procedural"` | — | Pin stored memories to a cognitive type. |
| `add.metadata` | `Record<string, unknown>` | — | Metadata attached to every stored memory. |

### Failure handling

Fail-open is the default across the whole package: a memory outage must never be the reason an
agent stops working.

| You set | Recall fails | Persistence fails |
|---|---|---|
| nothing | prompt goes through unmodified, `console.warn` | write dropped, `console.warn` |
| `onError` | prompt goes through unmodified, callback fires | write dropped, callback fires |
| `throwOnError: true` | the model call rejects | rejects **only with `awaitPersist: true`** |

`onError` is an observer, not a switch — it fires either way, and it is `throwOnError` alone that
decides whether the error also reaches your `await`. A fire-and-forget write (`awaitPersist: false`,
the default) has already returned to the caller by the time it fails, so it can only ever be
reported; it is never left as an unhandled rejection.

The same pair works on `cortadelTools`, where the default is a result carrying `error` and
`throwOnError: true` makes the tool call reject instead.

## Examples

- [`examples/chat-with-memory.ts`](examples/chat-with-memory.ts) — the middleware: the same
  question across two runs that share no message history, plus a per-request user override.
- [`examples/memory-tools.ts`](examples/memory-tools.ts) — the tools: the agent decides when to
  store and when to recall.

Both need a running server and a model provider:

```bash
pnpm add @ai-sdk/openai
export OPENAI_API_KEY=...
pnpm exec tsx examples/chat-with-memory.ts
```

## Running the tests

```bash
pnpm install
pnpm test           # vitest run
pnpm run typecheck  # tsc --noEmit over src/ and test/
pnpm run build
```

The suite is fully offline — no server, no network, no API keys. It stubs the Cortadel client at
the `CortadelMemoryClient` interface and drives the real AI SDK end to end with
`MockLanguageModelV4` from `ai/test`, so the assertions are made on what actually reached the model
after `wrapLanguageModel` ran.

## Requirements

- **Node ≥ 22** (the floor `ai@7` sets).
- **`ai` ≥ 7.0.0** and **`zod`** `^3.25.76 || ^4.1.8` — peer dependencies, matching the range `ai`
  itself declares.
- **A running Cortadel server**: the hosted service at `https://app.cortadel.ai`, or self-host with
  `docker compose up` → `http://localhost:3001`. See
  [self-hosting](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md).

Built on [`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk).

## Links

- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)

Apache-2.0.
