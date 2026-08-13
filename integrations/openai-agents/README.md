# Cortadel × OpenAI Agents SDK

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. This package makes it native to the
[OpenAI Agents SDK for TypeScript](https://github.com/openai/openai-agents-js): your agent
remembers a user across conversations, processes and deployments, without you writing any
retrieval plumbing.

It plugs into the SDK's own seams — the `Session` interface for conversation history,
`callModelInputFilter` for automatic recall, and the `tool()` helper for explicit memory calls. No
monkey-patching, no wrapper `Runner`.

## Install

```bash
npm install @cortadel/openai-agents @openai/agents zod
```

`@openai/agents` and `zod` are peer dependencies — you almost certainly have both already, since
`@openai/agents` itself peer-requires `zod@^4`. The Cortadel SDK (`@cortadel/sdk`) comes along as a
regular dependency.

## Quickstart

```ts
import { Agent, run } from '@openai/agents';
import { CortadelSession } from '@cortadel/openai-agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a concise assistant.',
  model: 'gpt-4.1-mini',
});

const session = new CortadelSession({
  sessionId: 'chat-1',
  userId: 'e2e-alice',                  // the memory namespace
  baseUrl: 'http://localhost:3001',     // or https://app.cortadel.ai
});

try {
  const result = await run(agent, 'What editor do I use?', session.runOptions());
  console.log(result.finalOutput);
} finally {
  await session.close();                // drain any in-flight writes
}
```

`session.runOptions()` installs **both halves** of automatic memory:

```ts
{ session, callModelInputFilter }
```

`session` gives you conversation history *and* writes each finished turn to Cortadel.
`callModelInputFilter` searches Cortadel for the question the user just asked and injects the hits
into the model call. Pass only `{ session }` and you get storage without recall — occasionally what
you want, usually not.

`runOptions()` copies any options you hand it, so nothing is clobbered:

```ts
await run(agent, 'hi', session.runOptions({ maxTurns: 5 }));
```

The same pair works on a `Runner`'s `RunConfig`, which also carries `callModelInputFilter`.

## What you get

### `CortadelSession` — automatic memory

A `Session` (the SDK's conversation-history interface) that adds long-term memory on top:

| Method / member | What it does |
|---|---|
| `getSessionId` / `getItems` / `addItems` / `popItem` / `clearSession` | Verbatim conversation history, delegated to a transcript session |
| `addItems` (also) | Distils the finished user↔assistant exchange into Cortadel via `addConversation` |
| `callModelInputFilter` | A `CallModelInputFilter`: searches Cortadel for the latest user message and injects the hits |
| `runOptions(base?)` | Run options with the session **and** that filter installed |
| `tools()` | The two memory tools below, bound to this session's client |
| `flush()` / `close()` | Send anything still buffered; drain background writes |

**Why history and memory are separate.** A `Session` is a verbatim transcript store — the runner
replays it, reconciles it against what the model saw, and pops from it to rewind. Cortadel is a
*distilled* store: it deduplicates facts and does not preserve item order, so backing `getItems`
with it would corrupt the run loop. So `CortadelSession` is a **wrapper session**: it holds a
transcript session for exact short-term fidelity and layers Cortadel on top. The transcript
defaults to the SDK's own in-memory `MemorySession`; pass `transcript:` any `Session` to survive
restarts.

**Why recall is a filter, not `getItems`.** `getItems()` receives no query, and the runner calls it
*before* the new turn's input exists — on the first turn there is nothing to search on at all.
`callModelInputFilter` is "invoked immediately before calling the model, allowing callers to edit
the system instructions or input items that will be sent to the model", which is exactly this job.
Lifecycle hooks (`agent.on('agent_start', …)`) were the other candidate and are the wrong one:
they are observation-only, so nothing a listener does can reach the model input.

**One thing the TypeScript SDK does that the Python one does not:** it *persists* what the filter
produced back into the session (`applyCallModelInputFilter` returns `persistedItems`, and marks
filter-added items `'injected'`). Left alone, an `injectAs: 'input'` block would enter the
transcript, replay as history next turn, and suppress fresh recall. `CortadelSession` strips its
own block in `addItems`, so the injected memories stay **ephemeral** in both injection modes:
context never accumulates memories turn after turn, and no injected text is ever stored as a
memory.

### `cortadelMemoryTools` — explicit memory

Two real `FunctionTool`s for agents that should decide when to remember:

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
| `search_memory` | `query: string` | Numbered relevant memories, or `"No relevant memories found."` |
| `add_memories` | `text: string` | What the write pipeline did (`Stored.`, `Already remembered…`) |

Schemas are Zod objects converted by `tool()`, and are strict (`additionalProperties: false`). The
two shapes compose — give an agent a `CortadelSession` *and* `tools: session.tools()` for automatic
recall plus an explicit "look it up again" escape hatch.

### Failure behaviour

Memory degrades; it never takes down the agent. If Cortadel is unreachable, a search returns
nothing and the model call proceeds unchanged, a write is dropped, and a tool call tells the model
memory is unavailable.

Two independent knobs govern that, available on both `CortadelSession` and `cortadelMemoryTools`:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `throwOnError` | `boolean` | `false` | Propagate memory failures to the caller instead of degrading. |
| `onError` | `(error: unknown) => unknown` | `undefined` | Called with the thrown value on **every** memory failure. May return a promise. |

```ts
const session = new CortadelSession({
  sessionId: 'chat-1',
  userId: 'e2e-alice',
  onError: (error) => Sentry.captureException(error),
});
```

`onError` *observes*; `throwOnError` *propagates* — they compose. With no callback set, a swallowed
failure is `console.warn`ed; setting a callback replaces that log rather than doubling it. A
callback that throws is itself logged and dropped, so your telemetry going down cannot become the
agent's problem.

## Configuration

### `new CortadelSession(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `sessionId` | `string` | *required* | Conversation id. Keys the transcript, is returned by `getSessionId()`, and is sent as Cortadel's `ConversationOptions.sessionId`. |
| `userId` | `string` | *required* | Memory namespace owner. **One session serves one user** — a Cortadel client is bound to a user id at construction and no method takes one. |
| `baseUrl` | `string` | `$CORTADEL_BASE_URL` → `http://localhost:3001` | Cortadel server URL. |
| `apiKey` | `string` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server has auth disabled. |
| `appName` | `string` | `"cortadel-openai-agents"` | Recorded for access logging on searches. |
| `client` | `CortadelClient` | — | Use a pre-built client instead. Must already be scoped to `userId`. |
| `transcript` | `Session` | `new MemorySession({ sessionId })` | Where verbatim history lives. |
| `topK` | `number` | `5` | Memories recalled per turn. |
| `searchMode` | `string` | `"hybrid"` | `hybrid`, `text`, or `vector`. |
| `rerank` | `string` | — | Set `"cross_encoder"` to rerank server-side. |
| `minScore` | `number` | — | Drop hits below this `rrfScore`. |
| `scopeRecallToSession` | `boolean` | `false` | Recall only facts extracted from *this* conversation (`SearchOptions.sessionId`). Off by default — long-term memory earns its name by crossing conversations. |
| `injectAs` | `"instructions" \| "input"` | `"instructions"` | Append the block to the system prompt, or insert it as a system message immediately before the latest user message (leaves the earlier prefix byte-identical, so prompt caches still hit). |
| `memoryHeader` | `string` | `"# Long-term memory (Cortadel)"` | Heading of the injected block; also the double-injection marker. |
| `retrieve` | `boolean` | `true` | Set `false` to store without recalling. |
| `store` | `boolean` | `true` | Set `false` to recall without storing. |
| `awaitPersist` | `boolean` | `false` | Whether the write is awaited before the turn returns. See below. |
| `tags` | `string[]` | — | Tags applied to every fact extracted from this conversation. |
| `project` | `string` | — | Project scope for extracted facts. |
| `throwOnError` | `boolean` | `false` | Surface Cortadel failures instead of degrading. |
| `onError` | `(error: unknown) => unknown` | — | Observe every Cortadel failure; replaces the warning log. |

**`awaitPersist` defaults to `false`** — fire-and-forget, so Cortadel's extraction latency stays
off the turn. That is safe in Node: a pending `fetch` keeps the event loop alive, so a script that
falls off the end still lands its write. It is *not* safe where the runtime can freeze the process
the moment your handler returns (serverless) or where you call `process.exit()`. In those places
either set `awaitPersist: true` or `await session.flush()` before returning — `flush()` is a hard
synchronisation point whatever `awaitPersist` says, and `close()` calls it for you. A background
write is not awaited by anyone, so `throwOnError` cannot apply to it: those failures always go to
`onError` or the log.

### `cortadelMemoryTools(options)`

Takes `baseUrl`, `apiKey`, `appName`, `client`, `topK`, `searchMode`, `rerank`, `minScore`,
`throwOnError` and `onError` with the same meanings, plus `userId` and `sessionId` (restrict
`search_memory` to one conversation; omit to search everything the user has). Pass either `userId`
or an already-scoped `client`, not both.

Two defaults differ from `CortadelSession`, deliberately:

- **`topK` defaults to `10`**, the Cortadel SDK's own `SearchOptions` default. An agent that chose
  to call `search_memory` can spend more context on the answer than a per-turn injection that fires
  whether or not memory was needed.
- **`session.tools()` inherits the session's settings instead** — including its `topK` (`5` by
  default) and its `scopeRecallToSession` — so an explicit tool call and an automatic recall never
  disagree about what the user's memory contains.

### Multiple users

Because scoping happens at construction, serve several users by building one session (or one
toolset) per user:

```ts
const sessions = new Map(
  ['e2e-alice', 'e2e-bob'].map((userId) => [
    userId,
    new CortadelSession({ sessionId: `chat-${userId}`, userId }),
  ]),
);
```

## Running the tests

The suite is fully offline — no network, no Cortadel server, no API keys. The Cortadel boundary is
a fake client; the model boundary is a fake `Model`, so several tests drive a real `run()` and
assert on what the runner actually sent.

```bash
cd integrations/openai-agents
pnpm install
pnpm exec vitest run     # or: pnpm test
pnpm typecheck           # tsc over src/ and test/
pnpm build               # tsc -> dist/
```

## Requirements

- **Node** ≥ 20
- **`@openai/agents`** ≥ 0.15.0, < 1.0.0 (peer) — verified against 0.15.0
- **`zod`** ^4 (peer) — the major `@openai/agents` itself peer-requires
- **`@cortadel/sdk`** ^1.0.0
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` (→ `http://localhost:3001`). See
  [self-hosting](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md).

### Known limits

- **Sessions and server-managed conversations are mutually exclusive.** The SDK forbids combining
  a `session` with `conversationId` or `previousResponseId`. Use `cortadelMemoryTools` if you need
  OpenAI server-side conversation continuation.
- **`clearSession()` clears the transcript, not Cortadel.** Closing a chat window is not a request
  to forget the user. Delete memories deliberately with `client.delete([...])`.
- **`popItem()` rewinds history, not memory.** Facts already written are bi-temporal — superseded,
  never silently erased. Unflushed messages *are* dropped on pop.
- **Recall is keyed on the latest user message.** An image-only or tool-only turn injects nothing.

## Links

- [Cortadel on GitHub](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)
- [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)

Apache-2.0.
