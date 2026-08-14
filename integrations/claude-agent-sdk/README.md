# Cortadel × Claude Agent SDK

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. The
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) gives an agent a
session; it does not give it a memory that outlives one. This package closes that gap through the
SDK's own two extension points: an **in-process MCP server** carrying memory tools the agent can
call on purpose, and **`UserPromptSubmit` / `Stop` hooks** that recall and persist without being
asked. Both come off one object, and memory degrades rather than breaking your agent — if the
Cortadel server is unreachable the hooks return empty and the turn proceeds untouched, with the
failure handed to your `onError` callback (or logged). Flip `throwOnError: true` when you would
rather know loudly.

## Install

```bash
npm install @cortadel/claude-agent-sdk
# or: pnpm add @cortadel/claude-agent-sdk
```

`@anthropic-ai/claude-agent-sdk` and `zod` are **peer dependencies** — you almost certainly already
have both, since the agent SDK itself peers on zod. If your package manager does not install peers
automatically:

```bash
npm install @anthropic-ai/claude-agent-sdk zod
```

## Quickstart

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CortadelMemory } from "@cortadel/claude-agent-sdk";

// One CortadelMemory per user: a Cortadel client is bound to one user id at construction.
const memory = new CortadelMemory({
  baseUrl: "http://localhost:3001",
  userId: "e2e-alice",
});

// apply() returns a COPY of the options with the memory tools and both hooks merged in.
const options = memory.apply({ model: "claude-sonnet-4-5" });

for await (const message of query({ prompt: "What did we decide about the schema?", options })) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

That single `apply()` call is equivalent to writing all of this by hand:

```ts
const options = {
  model: "claude-sonnet-4-5",
  mcpServers: { cortadel: memory.mcpServer },
  allowedTools: ["mcp__cortadel__search_memory", "mcp__cortadel__add_memories"],
  hooks: memory.hooks(),
};
```

Take just one half with `memory.apply(options, { autoMemory: false })` (tools only — the agent
decides when to remember) or `memory.apply(options, { tools: false })` (hooks only — memory the
agent never has to think about).

## What you get

### Memory tools (in-process MCP server)

Defined with the SDK's `tool()` helper and packaged by `createSdkMcpServer()`, so they run in your
process — no subprocess, no IPC.

| Tool | Fully qualified name | Arguments | Does |
|---|---|---|---|
| `search_memory` | `mcp__cortadel__search_memory` | `query` (required), `top_k` | Hybrid BM25 + vector search over this user's memories. Annotated `readOnlyHint`, so Claude may batch it with other read-only calls. |
| `add_memories` | `mcp__cortadel__add_memories` | `text` (required), `memory_type` | Stores a durable fact. The result reports Cortadel's pipeline `event` (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, …) — a successful call does not always mean a new memory. |

The `mcp__<server>__<tool>` prefix comes from the key in `mcpServers`; change it with `serverName`.
Failures come back to the model as `isError` results with a readable message, so the agent loop
continues. The raw definitions are on `memory.tools` if you would rather register them on an MCP
server of your own.

### Automatic memory (hooks)

| Hook event | What it does |
|---|---|
| `UserPromptSubmit` | Searches Cortadel with the submitted prompt and injects the hits as `hookSpecificOutput.additionalContext`. Skips prompts shorter than `minPromptChars` and anything starting with `/` or `!`. Within a session it never injects the same memory twice (`dedupeInjections`), so a long conversation does not keep re-spending context on facts the model has already seen. |
| `Stop` | Reads the finished turn back off the session transcript and persists it with `addConversation`, tagged and scoped by `sessionId`, `project` and `transcriptPath`. Cortadel distils the durable facts server-side. Guards against re-entry via `stop_hook_active`. |

The `Stop` hook has to read the transcript because `StopHookInput` carries no user message. It uses
the SDK's own `getSessionMessages()` (which rebuilds the conversation chain and drops meta/sidechain
entries), falls back to parsing the JSONL at `transcript_path` directly, and — only if both come up
empty — pairs `StopHookInput.last_assistant_message` with the prompt this session last submitted.
The transcript paths are preferred because they carry message uuids, which Cortadel keeps as pointer
anchors on every extracted fact.

### Relationship to the `cortadel-memory` plugin

This repo also ships [`cortadel-plugin/`](../../cortadel-plugin), a Claude Code **plugin** that does
the same two things via command hooks in the CLI. Use the plugin for interactive Claude Code; use
this package when you are building an agent programmatically. They are independent — do not run both
against the same session or every turn gets captured twice.

## Configuration

`new CortadelMemory(options)` takes one object. `baseUrl` and `userId` are required; everything else
is optional.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | *required* | Cortadel server, e.g. `http://localhost:3001` or `https://app.cortadel.ai`. |
| `userId` | `string` | *required* | Namespace anchor. Every memory read or written belongs to it. |
| `apiKey` | `string` | — | Sent as `Authorization: Bearer`. Omit when the server runs with auth disabled. |
| `client` | `CortadelMemoryClient` | — | Supply a Cortadel client you already own, instead of `baseUrl`/`userId`/`apiKey`. Also reachable as `CortadelMemory.fromClient(client, tuning)`. |
| `appName` | `string` | `"@cortadel/claude-agent-sdk"` | Recorded for access logging on searches, and stamped as the creating app on tool-written memories. |
| `serverName` | `string` | `"cortadel"` | MCP server key; sets the `mcp__<serverName>__*` tool prefix. |
| `project` | `string` | — | Project scope for captured conversations. Defaults to the basename of the session's `cwd`. |
| `tags` | `readonly string[]` | `["claude-agent-sdk"]` | Tags applied to every fact extracted from a captured conversation. |
| `topK` | `number` | `5` | Memories fetched per recall, and the `search_memory` tool's default when the model does not pass its own `top_k`. One knob serves both paths, so the tool defaults to 5 rather than the Cortadel SDK's own `SearchOptions` default of 10 — automatic injection spends context on every turn, and 5 is the budget that survives a long session. |
| `rerank` | `string` | — | Set to `"cross_encoder"` to rerank recall hits. Off by default — CPU reranking is too slow to sit in front of a prompt. |
| `scopeRecallToSession` | `boolean` | `false` | Restrict automatic recall to the current SDK session (the hook's `session_id`). Off by default: recalling across sessions is the whole point of long-term memory. No effect on the `search_memory` tool, whose handler receives tool arguments and no session id. |
| `minPromptChars` | `number` | `10` | Prompts shorter than this skip recall. |
| `maxContextChars` | `number` | `4000` | Ceiling on the injected memory block. |
| `captureMaxChars` | `number` | `16000` | Ceiling on the conversation text sent to `addConversation`. |
| `recallTimeoutMs` | `number` | `10000` | Milliseconds the `UserPromptSubmit` hook may spend before giving up. |
| `captureTimeoutMs` | `number` | `60000` | Milliseconds the `Stop` hook may spend before giving up. |
| `awaitPersist` | `boolean` | `true` | Whether the `Stop` hook waits for the write before returning. **Defaults to `true`, against the repo-wide fire-and-forget default, because `Stop` fires as the turn winds down — hand the write to a floating promise and `query()` can close (taking its transports, and often the process, with it) before the write lands, silently losing the turn.** Set it to `false` only if you keep the process alive yourself, and call `flush()` to drain what is still in flight. |
| `dedupeInjections` | `boolean` | `true` | Never inject the same memory twice in one session. |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the *assistant* instead of the user. |
| `throwOnError` | `boolean` | `false` | Fail open: a memory failure inside a hook is swallowed and the turn proceeds. Set it to `true` to have the hook rethrow instead — what you want in tests and CI. |
| `onError` | `(error: unknown) => void` | — | Called with the error on every memory failure, from either path. |

Each matcher's `HookCallbackMatcher.timeout` (which is in **seconds**) is derived from
`recallTimeoutMs` / `captureTimeoutMs` so the CLI-side timeout never fires before this package's own.

### Error handling

A Cortadel outage must never take the agent down, so `throwOnError` defaults to `false`.

```ts
const memory = new CortadelMemory({
  baseUrl: "http://localhost:3001",
  userId: "e2e-alice",
  onError: (error) => logger.warn({ error }, "cortadel"),
});
```

The three paths differ, deliberately:

- **Hooks** (`UserPromptSubmit`, `Stop`) swallow the failure and return an empty result, so the turn
  proceeds untouched. With `throwOnError: true` they rethrow instead.
- **Tools** always report the failure to the model as an `isError` result with a readable message —
  that surfaces it rather than swallowing it, so `throwOnError` does not change tool behaviour.
- **A background write** (`awaitPersist: false`) can only be observed: the hook that started it
  returned long ago, so there is nothing left to throw into.

`onError` sees the error in all three cases. When it is undefined **and** the failure was swallowed,
a warning goes to `console.warn` instead. A callback that itself throws is caught and logged — it can
never break a turn.

### Alternative constructors

```ts
// From the same env vars the cortadel-memory plugin reads:
//   CORTADEL_URL, CORTADEL_USER_ID, and optionally CORTADEL_API_KEY / CORTADEL_CLIENT_NAME
const memory = CortadelMemory.fromEnv({ topK: 8 });

// From a Cortadel client you already own (shared, wrapped, or a test double).
const memory = CortadelMemory.fromClient(myCortadelClient, { topK: 8 });
```

Both accept every tuning option in the table above. `await memory.flush()` waits for any
fire-and-forget write to land, which is what makes `awaitPersist: false` safe when you do want it.
The Cortadel TypeScript client holds no long-lived resource and has no `close()`, so there is nothing
else to release.

## Examples

Both need a running Cortadel server, plus the Claude Code CLI and Anthropic credentials that the
agent SDK itself requires. They import the package by its published name, so they are copy-pasteable
into your own project as they stand.

- [`examples/auto-memory.ts`](./examples/auto-memory.ts) — hooks only. Run it twice: the second run
  answers from memory in a brand-new session.
- [`examples/memory-tools.ts`](./examples/memory-tools.ts) — tools only, printing every memory tool
  call the model chooses to make.

```bash
# From a checkout: the examples import the package by name, which Node resolves through
# `exports` to `dist/`, so build once first.
pnpm build && pnpm dlx tsx examples/auto-memory.ts
```

## Running the tests

Offline unit tests — no network, no Cortadel server, no API keys. The Cortadel boundary is faked; the
agent SDK is not, so the tools are driven through the real in-process MCP server over an in-memory
transport.

```bash
cd integrations/claude-agent-sdk
pnpm install
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit && tsc -p tsconfig.test.json — src, test AND examples
pnpm build         # tsc, src only: dist/ holds the shipped surface and nothing else
```

`tsconfig.test.json` maps `@cortadel/claude-agent-sdk` to `./src/index.ts`, so the examples are
type-checked against this folder's source rather than a stale `dist/` — an example that drifts from
the API fails `pnpm typecheck`.

## Requirements

- Node.js ≥ 20
- `@anthropic-ai/claude-agent-sdk` ≥ 0.3.0 < 0.4.0 (developed and verified against **0.3.231**) and
  `zod` ^4 — both peer dependencies. The agent SDK itself needs the Claude Code CLI and Anthropic
  credentials to run an agent; the tests here need neither.
- `@cortadel/sdk` ^1.0.0 (a direct dependency, installed for you)
- A running Cortadel server: hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` → `http://localhost:3001`.

## Links

- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)

Apache-2.0.
