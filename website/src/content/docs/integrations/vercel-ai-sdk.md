---
title: Cortadel × Vercel AI SDK
description: Long-term memory for AI SDK agents — a language-model middleware that recalls and persists automatically, plus search_memory and add_memories tools.
---

Models are stateless: every `generateText` call starts from nothing, so an agent forgets a user's
preferences the moment the conversation ends. **`@cortadel/vercel-ai-provider`** closes that gap in
the two places the AI SDK gives you for it — a **language-model middleware** that searches Cortadel
before each model call and hands the finished turn back afterwards, with no change to your
`generateText` / `streamText` code, and a pair of **tools** the agent can call when it wants to
remember something deliberately. Both are model-agnostic: the middleware wraps whatever provider you
already use, and the two compose against one shared connection.

## Install

```bash
npm install @cortadel/vercel-ai-provider
```

ESM-only. `ai` and `zod` are peer dependencies — you almost certainly have both already.

## Quickstart

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { cortadelMemory } from "@cortadel/vercel-ai-provider";

// One middleware instance, reused for every call. It caches a Cortadel client per user id.
const memory = cortadelMemory({
  baseUrl: "http://localhost:3001",       // or https://app.cortadel.ai
  userId: "e2e-alice",
  // apiKey: process.env.CORTADEL_API_KEY,  // omit when the server runs with auth disabled
  awaitPersist: true,                     // required on serverless/edge — see Known limits
});

const model = wrapLanguageModel({ model: openai("gpt-4.1-mini"), middleware: memory });

// Turn 1 — nothing here mentions memory.
const first = await generateText({
  model,
  prompt: "I always deploy on Fridays and I prefer metric units.",
});
console.log(first.text);

// Cortadel distills facts with an LLM off the request path; give the first turn a moment to land.
await new Promise((resolve) => setTimeout(resolve, 5_000));

// Turn 2 — a new conversation with no message history, and it still knows.
const second = await generateText({ model, prompt: "When do I usually ship?" });
console.log(second.text);
```

The model half needs `npm install @ai-sdk/openai` and `OPENAI_API_KEY`; the memory half needs a
running Cortadel server (see [Requirements](#requirements)).

To apply memory across a whole provider rather than one model, `wrapProvider` and
`createProviderRegistry` accept the same middleware:

```ts
import { wrapProvider } from "ai";

const provider = wrapProvider({ provider: openai, languageModelMiddleware: memory });
```

## What you get

### `cortadelMemory(options)` — the automatic-memory seam

A `LanguageModelMiddleware` for `wrapLanguageModel`. It implements all three middleware hooks:

| Hook | What it does |
|---|---|
| `transformParams` | Searches Cortadel with the latest user message and injects the hits as a system message, placed after your own system prompt and before the conversation. |
| `wrapGenerate` | Hands the finished turn to the SDK's `addConversation`, which distills it into atomic facts. |
| `wrapStream` | The same, accumulated from the token stream and written when it closes. |

### `cortadelTools(options)` — memory the agent drives

A `ToolSet` with `search_memory` and `add_memories`, named to match Cortadel's own MCP tools so an
agent behaves the same whichever surface it reaches memory through. Spread it into `generateText` /
`streamText` / `Agent`:

```ts
import { generateText, stepCountIs } from "ai";
import { cortadelTools } from "@cortadel/vercel-ai-provider";

const result = await generateText({
  model: openai("gpt-4.1-mini"),
  tools: cortadelTools({ baseUrl: "http://localhost:3001", userId: "e2e-alice" }),
  stopWhen: stepCountIs(5),
  prompt: "What do you remember about my deployment habits?",
});
```

| Tool | Input | Returns |
|---|---|---|
| `search_memory` | `{ query: string, topK?: number }` (`topK` an integer 1–50) | `{ memories: [{ id, content, score?, createdAt? }], count, error? }` |
| `add_memories` | `{ memories: string[] }` (at least one non-empty string) | `{ stored, duplicates, ids, error? }` |

`stored` counts what the server actually wrote, `duplicates` what it folded into an existing memory
(a `SKIP_DUPLICATE` event), and `ids` collects everything it acknowledged. Failures come back as an
`error` field rather than a throw, so a memory outage leaves the agent able to answer instead of
aborting the run.

The package also exports `formatMemories` (the default renderer, so you can wrap it rather than
replace it), `DEFAULT_APP_NAME`, and `CORTADEL_PROVIDER_OPTIONS_KEY` — the `"cortadel"`
`providerOptions` namespace, exported so you can key it without a string literal.

## Configuration

### Connection — accepted by both `cortadelMemory` and `cortadelTools`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | — | Cortadel server URL, e.g. `https://app.cortadel.ai` or `http://localhost:3001`. Required unless `client` is given; the two are mutually exclusive. |
| `userId` | `string` | — | User that owns the memories. Required with `baseUrl`. |
| `apiKey` | `string` | — | Sent as `Authorization: Bearer <key>`. Omit when the server runs with auth disabled. |
| `appName` | `string` | `"cortadel-vercel-ai-provider"` | App name recorded for access logging on searches — this package's own published npm name, de-scoped. |
| `client` | `CortadelMemoryClient` | — | A client you built yourself. Mutually exclusive with `baseUrl`, and it pins the integration to that client's single user. |
| `timeoutMs` | `number` | `100000` | Per-request timeout in milliseconds, passed through to the SDK. `0` disables it. |
| `fetch` | `typeof fetch` | global `fetch` | Custom `fetch`, passed through to the SDK. Never mutated. |
| `clientCacheSize` | `number` | `64` | Maximum per-user clients kept alive when using `baseUrl`. Least-recently-created entries are evicted. |

### Failure handling — accepted by both

| Option | Type | Default | Meaning |
|---|---|---|---|
| `onError` | `(error: unknown, context: { phase: "recall" \| "persist"; userId: string }) => void` | unset | Observes any Cortadel failure. Fires whether or not `throwOnError` is set — it reports, it does not decide control flow. With no callback and no `throwOnError`, a swallowed failure is logged through `console.warn` rather than vanishing. An `onError` that itself throws is swallowed. |
| `throwOnError` | `boolean` | `false` | Propagate memory failures to the caller instead of degrading. Memory never takes the agent down by default. |

| You set | Recall fails | Persistence fails |
|---|---|---|
| nothing | prompt goes through unmodified, `console.warn` | write dropped, `console.warn` |
| `onError` | prompt goes through unmodified, callback fires | write dropped, callback fires |
| `throwOnError: true` | the model call rejects | rejects **only with `awaitPersist: true`** |

On `cortadelTools` the same pair applies, with the default being a result carrying `error` and
`throwOnError: true` making the tool call reject instead.

### `cortadelMemory` — recall

| Option | Type | Default | Meaning |
|---|---|---|---|
| `recall` | `boolean` | `true` | Search and inject before each model call. |
| `topK` | `number` | `5` | Memories to inject (the server accepts 1–50). Tighter than the `search_memory` tool's `10`, because automatic injection pays for every hit in every prompt. |
| `mode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Retrieval arm. Hybrid fuses BM25 + vector with RRF. |
| `rerank` | `"cross_encoder"` | unset | Rerank hits with the server's local cross-encoder. Omitted by default: it costs a model pass per search. |
| `memoryType` | `"episodic" \| "semantic" \| "procedural"` | unset | Restrict recall to one cognitive type. |
| `sessionId` | `string` | unset | Groups recalled and stored facts under a session. |
| `minScore` | `number` | unset | Drop hits whose `rrfScore` is below this. Unscored hits are kept. |
| `formatMemories` | `(hits: SearchHit[], context: { query, userId }) => string` | built-in | Renders the injected system block. |
| `recallCacheTtlMs` | `number` | `60000` | How long an identical `(userId, sessionId, query)` recall is reused. `0` disables caching. |
| `recallCacheSize` | `number` | `32` | Maximum cached recalls. |

### `cortadelMemory` — persistence

| Option | Type | Default | Meaning |
|---|---|---|---|
| `persist` | `boolean` | `true` | Store each completed turn with `addConversation`. |
| `awaitPersist` | `boolean` | `false` | Await the write before the call resolves (or the stream closes). **Turn this on in serverless/edge handlers**, where a fire-and-forget promise is killed the moment the handler returns. |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the assistant rather than the user. |
| `tags` | `string[]` | unset | Tags applied to every stored fact. |
| `project` | `string` | unset | Project scope applied to every stored fact. |

### `cortadelTools`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `search.topK` | `number` | `10` | Result count when the model does not ask for one — the Cortadel SDK's own `SearchOptions` default. A tool the model called on purpose can afford a wider net than automatic injection. The model overrides it per call. |
| `search.mode` | `"hybrid" \| "text" \| "vector"` | `"hybrid"` | Retrieval arm. |
| `search.rerank` | `"cross_encoder"` | unset | Cross-encoder rerank. |
| `search.memoryType` | `"episodic" \| "semantic" \| "procedural"` | unset | Restrict results to one cognitive type. |
| `search.sessionId` | `string` | unset | Restrict results to one session. |
| `search.minScore` | `number` | unset | Drop hits below this `rrfScore`. Unscored hits are kept. |
| `add.app` | `string` | unset | App name recorded as each memory's creator (the SDK's `AddOptions.app`). Distinct from the connection-level `appName`, which is recorded on *searches* only and never applies to a write. Unset leaves attribution to the server. |
| `add.infer` | `boolean` | server default (`true`) | When `false`, store text verbatim and skip background entity/category extraction. Server-side dedup still applies. |
| `add.memoryType` | `"episodic" \| "semantic" \| "procedural"` | unset | Pin every stored memory to a cognitive type. |
| `add.metadata` | `Record<string, unknown>` | unset | Metadata attached to every stored memory. |

### Per-request overrides

The middleware reads a `cortadel` namespace out of `providerOptions` on every call. Other providers
ignore the namespace, so it is safe to leave in place.

| Key | Type | Overrides |
|---|---|---|
| `userId` | `string` | The configured `userId` — but only when the integration was built with `baseUrl`. |
| `sessionId` | `string` | The configured `sessionId`, for both recall and persistence. |
| `recall` | `boolean` | The configured `recall`. |
| `persist` | `boolean` | The configured `persist`. |

```ts
await generateText({
  model,
  prompt: "What do you remember about me?",
  providerOptions: { cortadel: { userId: "e2e-bob", sessionId: "thread-42" } },
});
```

## How it works

The extension point is **`LanguageModelMiddleware`**, the type `ai` hands to `wrapLanguageModel`. In
`ai@7` that is a `LanguageModelV4Middleware` with a relaxed `specificationVersion`. The package
imports the name `ai` re-exports and derives the call shapes it needs (`params`, `prompt`, the
generate result, the stream part) **structurally** from it, rather than adding `@ai-sdk/provider` as
a second dependency and pinning itself to the `V4` spelling — which has already been renamed twice
(V2 → V3 → V4). That keeps it correct across spec bumps as long as `wrapLanguageModel` keeps its
shape.

What the three hooks actually do, beyond "search then store":

- **`transformParams` — recall.** The query is the joined text of the *last* `user` message; files,
  images and tool results are skipped. Hits are rendered into a system message that is inserted
  after any leading system messages and before the first non-system one. That placement is
  load-bearing: your own instructions stay in first position where they outrank recalled context,
  and the system block stays contiguous at the top — several providers (Anthropic among them) reject
  a system message that appears after a user or assistant message. The prompt is copied, never
  mutated.
- **One search per turn, not per step.** Every step of a tool-calling loop re-enters
  `transformParams` with the same trailing user message, so a short-lived cache keyed on
  `(userId, sessionId, query)` collapses those into a single search.
- **`wrapGenerate` / `wrapStream` — persistence.** A turn whose unified finish reason is
  `"tool-calls"` is mid-loop and is not stored; the write waits for the step that actually answers.
  Both the V4 object form (`{ unified, raw }`) and the pre-V4 bare string are read, so a model
  wrapped from an older spec still works. The result and the stream are handed back exactly as the
  provider produced them — this middleware remembers a turn, it never rewrites one.
- **Turns are fingerprinted.** An FNV-1a digest over `(userId, user text, assistant text)`, folded
  over UTF-8 bytes, keeps a bounded set of recently written turns so a retry cannot store the same
  exchange twice. The key is claimed *before* the write is awaited, so concurrent steps of one loop
  cannot both write it, and released again if the write fails, so a failure is retried rather than
  suppressed forever.
- **Failures degrade, and are read inside the guard.** Every read of provider-shaped data — the
  prompt on the way in, the result on the way out — happens inside the same `try` that catches a
  Cortadel outage, because a malformed prompt would otherwise throw straight out of the hook and
  abort the model call with `onError` never firing. A fire-and-forget write attaches its own
  `.catch`, since an unhandled rejection terminates a Node process by default. In the stream tap, a
  null or unreadable part is enqueued untouched rather than erroring the stream a consumer is
  already reading.
- **A client per user.** A Cortadel client is bound to one user id at construction — there is no
  per-call user parameter — so per-user scoping means one client per user. Given `baseUrl`, the
  package builds and caches them in a bounded, insertion-ordered map. Given a pre-built `client`, it
  uses that one and nothing else.
- **Connection mistakes fail loudly, at wiring time.** `cortadelMemory({})`, a `client` *and* a
  `baseUrl` together, or a `baseUrl` with no `userId` all throw from the constructor rather than
  becoming silently inert memory.

## Known limits

- **`awaitPersist` defaults to `false`.** On serverless/edge runtimes set it to `true`, or the
  background write dies when your handler returns. And because a fire-and-forget write has already
  returned to the caller by the time it fails, `throwOnError` has nothing left to throw into — its
  failure reaches `onError` (or `console.warn`) only.
- **No `scopeRecallToSession`.** This package deviates from the shared vocabulary here: `sessionId`
  is passed straight through to the SDK, where today it both groups writes *and* restricts recall.
  There is no separate switch to group without narrowing.
- **Tools are single-user by design.** The user id never enters a tool's input schema, so nothing
  the model reads can talk it into fetching another user's memories — but multi-tenant callers must
  build a tool set per request. Only the middleware takes a per-request user, and only when it was
  built with `baseUrl`: a pre-built `client` carries a user id it does not expose, so a per-request
  `userId` is deliberately ignored rather than silently misrouted.
- **Persistence stores the final user↔assistant exchange, not the whole history.** If either half is
  empty — an image-only answer, a turn with no text — nothing is written, because the server needs
  both halves to distill anything useful. Streamed turns capture `text-delta` parts only, so
  reasoning, tool calls and files are not remembered.
- **Recall is text-only.** The query comes from the last user message's text parts. An image-only
  turn is skipped silently — nothing failed, so nothing is reported.
- **The caches are per-instance and in-process.** The recall cache, the turn-fingerprint set (256
  entries) and the client cache all live on one middleware instance. A second process, a second
  instance, or an evicted entry can search or write again.
- **`topK` is only validated on the tool.** The `search_memory` input schema enforces the 1–50 range;
  the middleware's `topK` is passed straight to the server, so an out-of-range value is the server's
  to reject.
- **`add_memories` writes sequentially, on purpose** — the server dedups each write against what is
  already stored, and firing near-identical facts in parallel races that check.
- **Untested against a live server.** The package's suite is fully offline: it stubs the Cortadel
  client at an interface and drives the real AI SDK end to end with `MockLanguageModelV4` from
  `ai/test`, so assertions are made on what actually reached the model after `wrapLanguageModel` ran.
  Nothing in CI exercises a running Cortadel server, so wire-level behaviour rests on
  [`@cortadel/sdk`](/sdk-typescript/) and its own conformance suite.

## Requirements

- **`ai` ≥ 7.0.0** and **`zod`** `^3.25.76 || ^4.1.8` — peer dependencies, matching the range `ai`
  itself declares.
- **Node ≥ 22**, the floor `ai@7` sets. The package is ESM-only.
- **A running Cortadel server** — the hosted service at `https://app.cortadel.ai`, or self-host with
  `docker compose up` → `http://localhost:3001`. See [Self-hosting](/self-hosting/) and
  [Authentication](/authentication/).

Built on [`@cortadel/sdk`](/sdk-typescript/). Apache-2.0.

:::note
Every `@cortadel/*` npm package is published at `0.1.0` and carries a Sigstore provenance
attestation, so the install command above works as written.
:::

## Links

- [`@cortadel/vercel-ai-provider` on npm](https://www.npmjs.com/package/@cortadel/vercel-ai-provider)
- [Source: `integrations/vercel-ai-sdk`](https://github.com/cortadel/cortadel/tree/main/integrations/vercel-ai-sdk)
- [All integrations](/integrations/)
