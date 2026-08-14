# Cortadel × Claude Agent SDK

[Cortadel](https://cortadel.ai) is long-term temporal graph memory for AI agents — a bi-temporal
graph store with hybrid BM25 + vector search. The
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) gives an agent a
session; it does not give it a memory that outlives one. `@cortadel/claude-agent-sdk` closes that
gap through the two extension points the SDK actually offers: an **in-process MCP server** carrying
memory tools the agent can call on purpose, and **`UserPromptSubmit` / `Stop` hooks** that recall
and persist without being asked. Both come off one object, `CortadelMemory`, and memory degrades
rather than breaking your agent — if the Cortadel server is unreachable the hooks return an empty
result and the turn proceeds untouched, with the failure handed to your `onError` callback (or
logged). Flip `throwOnError: true` when you would rather know loudly.

## Install

```bash
npm install @cortadel/claude-agent-sdk
# or: pnpm add @cortadel/claude-agent-sdk
```

`@anthropic-ai/claude-agent-sdk` and `zod` are **peer dependencies** — you almost certainly already
have both, since the agent SDK itself peers on `zod` ^4. If your package manager does not install
peers automatically:

```bash
npm install @anthropic-ai/claude-agent-sdk zod
```

## Quickstart

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CortadelMemory } from "@cortadel/claude-agent-sdk";

// One CortadelMemory per user: a Cortadel client is bound to one user id at construction,
// so the user id belongs here and never appears in an individual call.
const memory = new CortadelMemory({
  baseUrl: "http://localhost:3001",   // or https://app.cortadel.ai
  userId: "e2e-alice",
  // apiKey: "<token>",               // omit when the server runs with auth disabled
  onError: (error) => console.warn("[cortadel]", error),
});

// apply() returns a COPY of your options with the MCP server, the allowed tool names
// and both hooks merged in. Your own servers, tools and hooks are kept, not clobbered.
const options = memory.apply({ model: "claude-sonnet-4-5" });

for await (const message of query({ prompt: "What did we decide about the schema?", options })) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

That one `apply()` call is equivalent to writing all of this by hand:

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

Two other constructors build the same object: `CortadelMemory.fromEnv(tuning)` reads `CORTADEL_URL`
and `CORTADEL_USER_ID` (plus optional `CORTADEL_API_KEY` / `CORTADEL_CLIENT_NAME`, which becomes
`appName`) — the same variables the [`cortadel-memory` plugin](../plugin.md) reads, and it throws
naming any that are missing. `CortadelMemory.fromClient(client, tuning)` takes a Cortadel client you
already own — shared, wrapped for retries or metrics, or a test double. Both accept every tuning
option in the table below.

## What you get

### Memory tools — an in-process MCP server

Defined with the SDK's `tool()` helper and packaged by `createSdkMcpServer()`, so they run in your
process: no subprocess, no IPC.

| Tool | Fully qualified name | Arguments | What it does |
|---|---|---|---|
| `search_memory` | `mcp__cortadel__search_memory` | `query` (required), `top_k` (1–50, optional) | Hybrid BM25 + vector search over this user's memories, rendered as one bullet per hit with its date, RRF score and id. Annotated `readOnlyHint`, so Claude may batch it with other read-only calls. |
| `add_memories` | `mcp__cortadel__add_memories` | `text` (required), `memory_type` (`episodic` \| `semantic` \| `procedural`, optional) | Stores a durable fact, stamped with `appName`. The result reports Cortadel's pipeline `event` (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, …) — a successful call is not always a new memory. |

The `mcp__<server>__<tool>` prefix comes from the key in `mcpServers`; change it with `serverName`.
A tool failure comes back to the model as an `isError` result with a readable message (`CortadelError`
renders as `<code> (HTTP <status>): <message>`), so the agent loop continues rather than crashing.
The raw definitions are on `memory.tools` if you would rather register them on an MCP server of
your own.

### Automatic memory — two hooks

| Hook event | What it does |
|---|---|
| `UserPromptSubmit` | Searches Cortadel with the submitted prompt and injects the hits as `hookSpecificOutput.additionalContext` under a `## Relevant Cortadel memories` heading, with `suppressOutput: true`. Skips prompts shorter than `minPromptChars` and anything starting with `/` or `!`. Within a session it never injects the same memory twice (`dedupeInjections`), so a long conversation does not keep re-spending context on facts the model has already seen. |
| `Stop` | Reads the finished turn back off the session transcript and persists it with `addConversation`, scoped by `sessionId`, `project` and `transcriptPath` and tagged with `tags`. Cortadel distils the durable facts server-side, so the whole exchange is handed over rather than something pre-summarised in your process. Guards against re-entry via `stop_hook_active`. |

Both hooks are total: a dead server, a timeout or a malformed response yields an empty hook result
and the turn proceeds untouched.

> Also in this repo: [`cortadel-memory`](../plugin.md), a Claude Code **plugin** that does the same
> two things through the CLI's own command hooks. Use the plugin for interactive Claude Code; use
> this package when you are building an agent programmatically. They are independent — do not run
> both against the same session, or every turn gets captured twice.

## Configuration

`new CortadelMemory(options)` takes one object. `baseUrl` and `userId` are required (or `client`
instead of both); everything else is optional.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | *required* | Cortadel server, e.g. `http://localhost:3001` or `https://app.cortadel.ai`. |
| `userId` | `string` | *required* | Namespace anchor. Every memory read or written by this object belongs to it. |
| `apiKey` | `string` | — | Sent as `Authorization: Bearer`. Omit when the server runs with auth disabled. |
| `client` | `CortadelMemoryClient` | — | Supply a Cortadel client you already own, instead of `baseUrl`/`userId`/`apiKey`. Also reachable as `CortadelMemory.fromClient(client, tuning)`. |
| `appName` | `string` | `"@cortadel/claude-agent-sdk"` | Recorded for access logging on searches, and stamped as the creating app on tool-written memories. A client you supply yourself already carries its own app name, so with `client` this only stamps writes. |
| `serverName` | `string` | `"cortadel"` | MCP server key; sets the `mcp__<serverName>__*` tool-name prefix. |
| `project` | `string` | basename of the session's `cwd` | Project scope for captured conversations. |
| `tags` | `readonly string[]` | `["claude-agent-sdk"]` | Tags applied to every fact extracted from a captured conversation. |
| `topK` | `number` | `5` | Memories fetched per automatic recall, **and** the `search_memory` tool's default when the model passes no `top_k` of its own. Clamped to 1–50. |
| `rerank` | `string` | — | Set to `"cross_encoder"` to rerank recall hits. Off by default: CPU reranking is far too slow to sit in front of a prompt. |
| `scopeRecallToSession` | `boolean` | `false` | Restrict automatic recall to the current SDK session (the hook's `session_id`). Off by default — recalling across sessions is the entire point of long-term memory. No effect on the `search_memory` tool, whose handler is given tool arguments and no session id. |
| `minPromptChars` | `number` | `10` | Prompts shorter than this skip recall entirely. |
| `maxContextChars` | `number` | `4000` | Ceiling on the rendered memory block — both the injected one and the `search_memory` tool's result text. Each individual memory is also truncated at 300 characters. |
| `captureMaxChars` | `number` | `16000` | Ceiling on the conversation text sent to `addConversation`. The user side takes at most `min(4000, captureMaxChars)` of it and the assistant side gets the remainder. |
| `recallTimeoutMs` | `number` | `10000` | Milliseconds a search may spend before giving up — the `UserPromptSubmit` hook's budget, and also the `search_memory` tool's. |
| `captureTimeoutMs` | `number` | `60000` | Milliseconds the `Stop` hook's write may spend before giving up. |
| `awaitPersist` | `boolean` | `true` | Whether the `Stop` hook waits for the write to land before returning. Defaults to `true`, against the repo-wide fire-and-forget default — see [Known limits](#known-limits). Set it to `false` only if you keep the process alive yourself, and call `await memory.flush()` to drain what is still in flight. |
| `dedupeInjections` | `boolean` | `true` | Never inject the same memory twice in one session. |
| `isAgentMemory` | `boolean` | `false` | Extract facts about the *assistant* instead of the user. |
| `throwOnError` | `boolean` | `false` | Fail open: a memory failure inside a hook is swallowed and the turn proceeds. Set it to `true` to have the hook rethrow instead — what you want in tests and CI. |
| `onError` | `(error: unknown) => void` | — | Called with the error on every memory failure, whichever path it came from. A callback that itself throws is caught and logged; it can never break a turn. |

`apply()` itself takes a second argument, `{ tools?: boolean; autoMemory?: boolean }`, both `true`
by default.

The three failure paths differ, deliberately. **Hooks** swallow the failure and return an empty
result, unless `throwOnError` is set. **Tools** always report it to the model as an `isError`
result, which surfaces it rather than swallowing it, so `throwOnError` does not change tool
behaviour. **A background write** (`awaitPersist: false`) can only be observed — the hook that
started it returned long ago, so there is nothing left to throw into. `onError` sees the error in
all three cases; when it is undefined *and* the failure was swallowed, a warning goes to
`console.warn` instead.

Configuration errors are the one deliberate exception to failing open: `CortadelMemory` builds its
Cortadel client eagerly in the constructor, and the SDK validates `baseUrl` / `userId` there, so a
typo throws at wiring time instead of becoming memory that silently never works.

## How it works

**Tools.** Each tool is built with the SDK's `tool(name, description, zodShape, handler, extras)`
helper and packaged by `createSdkMcpServer({ name, version, tools })` into an
`McpSdkServerConfigWithInstance` — an MCP server running in your own process over an in-memory
transport, with no subprocess and no stdio. `apply()` puts it in `Options.mcpServers` under
`serverName`, and that key is what the CLI turns into the `mcp__<server_name>__<tool_name>` segment
of each fully qualified tool name; the same names are appended to `Options.allowedTools` so they are
pre-approved. The zod shapes become the JSON Schema the model sees, so an out-of-range `top_k` is
rejected by the SDK's own validation before the handler ever runs.

**Hooks.** `Options.hooks` is `Partial<Record<HookEvent, HookCallbackMatcher[]>>`, and `hooks()`
returns one matcher for `UserPromptSubmit` and one for `Stop`. Each matcher's `matcher` field is
left unset on purpose — it filters by *tool name*, which is meaningless for these two events — and
its `timeout`, which the SDK counts in **seconds**, is derived from `recallTimeoutMs` /
`captureTimeoutMs` plus a five-second margin, so the CLI-side timeout can never pre-empt this
package's own graceful give-up.

The `UserPromptSubmit` callback returns `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
additionalContext: … } }`. The nesting is load-bearing: `additionalContext` is a field of
`UserPromptSubmitHookSpecificOutput` in the SDK's `sdk.d.ts`, and a top-level key of the same name
is silently ignored. The hook's own `AbortSignal` is composed with the recall timeout via
`AbortSignal.any`, so cancelling a turn also cancels the recall it was for.

The `Stop` callback has a harder job, because `StopHookInput` carries `session_id`, `cwd`,
`transcript_path`, `stop_hook_active` and `last_assistant_message` — but **no user message**. The
finished turn therefore has to be read back, and there are three routes, tried in order:

1. `getSessionMessages(sessionId, { dir: cwd })`, the SDK's own public reader, which rebuilds the
   conversation chain through `parentUuid` links and drops meta and sidechain entries. It is pulled
   in through a dynamic `import()` and read defensively, so an older `0.3.x` without it degrades to
   the next route instead of failing at module load.
2. The raw JSONL at `transcript_path` — the file the hook itself named, so there is no session
   lookup to get wrong. Malformed lines are skipped rather than fatal, `isMeta` / `isSidechain`
   entries are filtered out, and a user entry whose `origin.kind` is not `human` is treated as a
   machine turn and only used if the exchange has no human turn at all.
3. `last_assistant_message` paired with the prompt this session last submitted, which the
   `UserPromptSubmit` hook records before its own skip checks. This is the fallback for a transcript
   that is unreadable or lives in a remote session store.

The first two routes are preferred because they carry message uuids, which ride along as
`ChatMessage.uuid` and become Cortadel's pointer anchors on every extracted fact; route 3 stores the
turn with no anchor. From there `session_id` becomes `ConversationOptions.sessionId` and the
basename of `cwd` becomes `project`, unless you set one explicitly. Unlike recall, the write is
deliberately *not* composed with the hook's abort signal: `Stop` fires as the turn winds down, and
letting a closing `query()` cancel the write is exactly the memory loss `awaitPersist` exists to
prevent.

## Known limits

- **Two hook events, and no more.** The SDK's `HookEvent` union is much wider — it includes
  `SessionStart`, `SessionEnd`, `PreCompact` and two dozen others — but priming memory at session
  start remains the [`cortadel-memory` plugin](../plugin.md)'s job.
- **`awaitPersist` defaults to `true`**, against the repo-wide fire-and-forget default. `Stop` fires
  at the end of a turn: hand the write to a floating promise and `query()` can close, taking its
  transports and often the process with it, before the write completes — silently losing the turn.
  With `awaitPersist: false` you own the drain, via `await memory.flush()`.
- **One `topK` (default 5) serves both paths.** The shared vocabulary's default for an explicit
  `search_memory` tool is 10, matching the Cortadel SDK's own `SearchOptions`; here the recall hook
  and the tool share one knob, and automatic injection spends context on every single turn, so 5 is
  the budget that survives a long session. Pass `top_k` per call to override it.
- **`scopeRecallToSession` applies to the hook only.** A tool handler is handed its arguments and no
  session id, so there is nothing for it to scope to.
- **`throwOnError` changes hook behaviour only.** Tools already surface failures to the model as
  `isError` results, and a background write has no caller left to throw into.
- **Two knobs are broader than their names suggest.** `recallTimeoutMs` and `maxContextChars` bound
  the `search_memory` tool as well as the recall hook, even though both read as hook settings.
- **One user per instance.** No Cortadel method takes a user id — the client is bound to one at
  construction — so a multi-user app builds one `CortadelMemory` per user. That matches the agent
  SDK, whose hook inputs carry `session_id` and `cwd` but no user identity at all.
- **One exchange per `Stop`.** Only the last user→assistant pair of the turn is captured, and a pair
  whose two sides total under 80 characters is dropped as too thin to yield durable facts.
- **The injection ledger is in-process and bounded** — 32 sessions, 512 memory ids each, evicted
  oldest-first. A very long session can eventually be re-shown a memory it saw thousands of turns
  ago, and restarting the process clears the ledger entirely.
- **Don't stack it with the plugin.** Running `cortadel-memory` and this package against the same
  session captures every turn twice.
- **Tested offline.** The package's suite fakes the Cortadel boundary but drives the *real*
  in-process MCP server over an in-memory transport; it does not exercise a live Cortadel server, a
  live agent run, or the real `getSessionMessages` reader (which is covered through injected fakes).
  It is developed and verified against `@anthropic-ai/claude-agent-sdk` 0.3.231.

## Requirements

- Node.js ≥ 20 — the agent SDK itself allows ≥ 18, this package does not.
- `@anthropic-ai/claude-agent-sdk` ≥ 0.3.0 < 0.4.0 and `zod` ^4, both **peer** dependencies. The
  agent SDK in turn needs the Claude Code CLI and Anthropic credentials to run an agent.
- `@cortadel/sdk` ^1.0.0 — a direct dependency, installed for you.
- A running Cortadel server: the hosted service at `https://app.cortadel.ai`, or your own
  (`docker compose up` → `http://localhost:3001`, see [Self-hosting](../self-hosting.md)).

## Links

- [`@cortadel/claude-agent-sdk` on npm](https://www.npmjs.com/package/@cortadel/claude-agent-sdk) —
  published at `0.1.0`, with a Sigstore provenance attestation.
- [Source and examples](https://github.com/cortadel/cortadel/tree/main/integrations/claude-agent-sdk)
  — `examples/auto-memory.ts` (hooks only; run it twice and the second run answers from memory in a
  brand-new session) and `examples/memory-tools.ts` (tools only, printing every memory tool call the
  model chooses to make).
- [All integrations](../integrations.md) · [MCP integration](../mcp.md) ·
  [Claude Code plugin](../plugin.md)
