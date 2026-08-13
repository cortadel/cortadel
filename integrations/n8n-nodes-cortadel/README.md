# Cortadel × n8n

[Cortadel](https://cortadel.ai) is self-hosted long-term memory for AI agents — a bi-temporal
graph store with hybrid BM25 + vector retrieval. This package makes it a first-class part of
n8n: a **Cortadel Memory** sub-node that plugs straight into the AI Agent's memory port, and a
**Cortadel** action node that works both as a normal workflow step and as a tool the agent can
call itself.

The memory sub-node is the interesting half. n8n's built-in memories are chat buffers — the last
N turns of the current session, gone when the session is. Cortadel Memory instead runs a fresh
hybrid search across everything Cortadel knows about that **user** on every turn, injects the
facts that are relevant *now*, and hands the finished turn back to Cortadel's extraction pipeline
to be distilled into durable facts. Memories outlive the conversation.

## Install

In n8n: **Settings → Community nodes → Install**, then enter:

```
n8n-nodes-cortadel
```

Or, for a self-hosted instance, from the command line in your n8n custom-nodes directory:

```bash
npm install n8n-nodes-cortadel
```

## Quickstart

1. **Create the credential.** Add a **Cortadel API** credential. Set **Base URL** to
   `https://app.cortadel.ai` (hosted) or `http://localhost:3001` (self-hosted). Set **API Key**
   if your server has auth enabled; leave it blank if it does not. Hit **Test** — it calls
   `GET /api/health`.

2. **Build the workflow.** Add a **Chat Trigger** and an **AI Agent**. On the agent:

   - drag **Cortadel Memory** onto the `Memory` port;
   - drag **Cortadel** onto the `Tool` port (optional, but it lets the agent search and write
     memories on purpose, not just implicitly).

3. **Configure the memory node.** The only two fields that matter:

   | Field | Value |
   |---|---|
   | **User ID** | `{{ $json.userId ?? $json.sessionId }}` |
   | **Session ID** | `{{ $json.sessionId }}` |

   These are different axes and both are load-bearing — see [User ID vs Session
   ID](#user-id-vs-session-id).

4. **Chat.** Tell the agent something about yourself, start a brand-new session, and ask about
   it. A chat buffer has forgotten. Cortadel has not.

`examples/agent-with-cortadel-memory.json` is that workflow, ready to import.

## What you get

### `Cortadel Memory` — the automatic memory (an `ai_memory` sub-node)

Outputs n8n's `ai_memory` connection type, so it drops into the AI Agent's **Memory** port
exactly like Simple Memory or Postgres Chat Memory. On every turn it:

- **before the model call** — searches Cortadel with the user's current message and injects the
  hits as context (one user-role block by default, or one message per fact);
- **after the turn** — posts the exchange to `POST /api/v1/memories/from-conversation`, where
  Cortadel's pipeline distils it into facts, deduplicates against what it already knows, and
  supersedes anything the turn contradicts.

Three behaviours worth knowing about, because they are deliberate:

- **It degrades, it does not break.** Every Cortadel call is wrapped. If the server is down,
  recall yields empty context and a warning in the execution log (n8n's own node logger); a
  failed persist is swallowed the same way. A memory outage must never take the agent down with
  it — there is deliberately no "fail hard" switch, and the default **Context Role** is chosen
  by the same rule (see [below](#context-role-user-by-default)). Writes are awaited inside the
  turn rather than fired and forgotten: n8n treats the execution as over the moment the workflow
  ends, so a write still in flight has no execution left to report into — and in queue mode the
  worker that owns it can be reaped first.
- **It does not re-search or re-store the same thing.** Identical recall queries inside one turn
  are served from a short-lived local cache (default 15 s), so an agent's tool loop cannot
  hammer the server; an identical `(input, output)` pair is never written twice **by the same
  node instance** (the last 64 pairs are remembered, so an `A → B → A` tool loop is suppressed
  too, not just consecutive repeats — but n8n builds a fresh instance per execution, so this is
  a within-execution guard); and duplicate hits are collapsed by memory id and by text before
  injection. Cortadel's own server-side deduplication is the backstop across executions.
- **`clear()` deletes nothing.** Clearing an n8n chat window drops the local recall cache only.
  Long-term memory is not something a UI button should be able to wipe — use the Cortadel node's
  **Delete** operation, explicitly.

#### Context Role: `user` by default

Recalled memories are injected as a **user** message, and the default context header tells the
model to read the block as background knowledge rather than as something the user just said.

That is the safe half of a real trade-off. A **system** message reads marginally better to
OpenAI-style models — but on Anthropic it is a hard failure of the whole agent run. Anthropic's
API takes a single `system` field, so `@langchain/anthropic` lifts `messages[0]` into it and
throws `System messages are only permitted as the first passed message.` for any later one
(`_convertMessagesToAnthropicPayload` in `dist/utils/message_inputs.js`). n8n's agent prompt is
`[system?, ...chat_history, human]` (`ToolsAgent` → `prepareMessages`), so anything a memory
node puts in `chat_history` sits at index ≥ 1 as soon as the agent's own **System Message**
option is set — and `Context Format: One Message Per Fact` produces several regardless. Both
cases throw. A memory node whose default can break the agent on a provider swap is not a memory
node that "never takes the agent down", so the default is the role no provider can reject.

**Opting into `system`:** set **Options → Context Role → System**. The one condition that has to
hold is the model: OpenAI-style (OpenAI, Azure OpenAI, Groq, Ollama, most OpenAI-compatible
gateways), **not** the Anthropic Chat Model, which throws. The reason to bother is that a system
message carries instruction-level weight instead of sitting in the dialogue — worth it if the
agent keeps treating recalled facts as something the user just said.

`test/message-compat.test.ts` pins both roles against the real `@langchain/anthropic` and
`@langchain/openai` converters, including the fact that the opt-in `system` role still throws on
Anthropic — the caveat is tested, not just documented.

#### Known limitation: the AI Agent's streaming path

n8n's agent has two execution branches, and they call memory differently.

| Branch | What n8n does | What you get |
|---|---|---|
| Non-streaming (`AgentExecutor.invoke`) | LangChain's `BaseChain._formatValues` passes the real turn inputs to `loadMemoryVariables(values)` | The per-turn hybrid search this node is built for |
| **Streaming** (chat trigger with response streaming on, node type version ≥ 2.1) | `loadMemory()` calls `memory.loadMemoryVariables({})` — an **empty** object — and `AgentExecutor`'s stream iterator never re-runs `_formatValues` | No query text reaches us, so recall degrades to the **most recent `Top K` memories** (`GET /api/v1/memories`) instead of a search |

Source: `packages/@n8n/nodes-langchain/utils/agent-execution/memoryManagement.ts` in n8n
(`loadMemory`, and its call site in the Tools Agent's streaming branch).

Nothing in a memory sub-node can recover the input — it is simply not passed. So if per-turn
relevance matters more to you than token-by-token streaming, **turn streaming off on the AI
Agent node**. Persisting the turn is unaffected: `saveContext` still receives the real input and
output on both branches.

The same code path also hardcodes the string `'chat_history'` when reading the returned
variables, so the **Memory Key** option only takes effect on the non-streaming branch. Leave it
at its default unless you know you are on the non-streaming path.

### `Cortadel` — the action node (and AI tool)

A normal main-in/main-out node with `usableAsTool: true`, so n8n also offers it in the agent's
tool list. One resource, `Memory`, with six operations that map one-to-one onto the public REST
contract:

| Operation | Route | What it does |
|---|---|---|
| **Add** | `POST /api/v1/memories` | Store one piece of text |
| **Add Conversation** | `POST /api/v1/memories/from-conversation` | Distil facts out of a transcript |
| **Search** | `POST /api/v1/memories/search` | Hybrid BM25 + vector retrieval |
| **List** | `GET /api/v1/memories` | Page through stored memories |
| **Get** | `GET /api/v1/memories/{id}` | One memory with its validity window |
| **Delete** | `DELETE /api/v1/memories` | Delete by id |

One deliberate divergence from the Cortadel SDKs: `client.get()` returns `null`/`None` for an
unknown id, whereas the **Get** operation surfaces the server's 404 as a node error. That is the
n8n convention — a failed lookup should colour the node red — and **Settings → On Error →
Continue** turns it back into a data row if you prefer the SDK behaviour.

## User ID vs Session ID

Cortadel namespaces every memory to exactly one **user**; that is the isolation boundary, and it
is what memories accumulate against across days and sessions. n8n's chat trigger only gives you
a **session** id, which is per-conversation.

So the memory node asks for both. `User ID` is the long-term identity. `Session ID` groups the
facts this conversation produces and can optionally narrow recall, via **Scope Recall to
Session**:

- **off** (default) — recall spans everything Cortadel knows about this user. This is the point.
- **on** — recall is restricted to facts stored under this session id, which makes the node
  behave more like a conversation buffer. Writes still carry the session id either way.

If you have no real user identity, `{{ $json.userId ?? $json.sessionId }}` degrades gracefully
to per-session memory.

## Configuration

### Credential — `Cortadel API`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | string | `http://localhost:3001` | Cortadel server. Hosted: `https://app.cortadel.ai` |
| `apiKey` | string (password) | — | Sent as `Authorization: Bearer <key>`. Optional: a self-hosted server with an empty auth secret leaves every endpoint open |

Credential test: `GET /api/health`. Note that Cortadel answers **503** when a dependency is
degraded, so the test reports failure against a reachable-but-degraded server — that is a
server-health signal, not necessarily a bad key.

### `Cortadel Memory` sub-node

The first four are top-level fields on the node; everything from `mode` down lives inside the
**Options** collection (click *Add Option*).

| Option | Type | Default | Meaning |
|---|---|---|---|
| `userId` | string | `{{ $json.userId ?? $json.sessionId }}` | Cortadel user that owns these memories |
| `sessionId` | string | `{{ $json.sessionId }}` | Groups the facts this conversation produces |
| `scopeRecallToSession` | boolean | `false` | Restrict recall to this session instead of the whole user graph |
| `topK` | number (1–50) | `5` | Max memories injected per turn |
| `mode` | `hybrid` \| `text` \| `vector` | `hybrid` | Which retrieval arms to fuse |
| `rerank` | boolean | `false` | Rerank with the cross-encoder (also enables the graph and session arms) |
| `memoryType` | `episodic` \| `semantic` \| `procedural` | any | Restrict recall to one cognitive type |
| `contextFormat` | `block` \| `messages` | `block` | One message listing the facts, or one message each |
| `contextRole` | `system` \| `user` | `user` | Role the recalled context is injected under. `system` is opt-in and **throws on the Anthropic Chat Model** — see [above](#context-role-user-by-default) |
| `contextHeader` | string | built-in sentence | Overrides the line above the facts in `block` format |
| `memoryKey` | string | `chat_history` | Prompt variable the context is written to. Ignored on the agent's streaming branch — see [Known limitation](#known-limitation-the-ai-agents-streaming-path) |
| `inputKey` / `outputKey` | string | `input` / `output` | Where the turn text lives in LangChain's values |
| `returnMessages` | boolean | `true` | Message objects vs one rendered string |
| `persistTurns` | boolean | `true` | Turn off for read-only memory |
| `project` | string | — | Project scope recorded on extracted facts |
| `tags` | string (CSV) | — | Tags applied to every fact stored from this chat |
| `recallCacheTtlMs` | number | `15000` | How long an identical recall is cached. `0` disables |

### `Cortadel` action node

`userId` is required on every operation. Per-operation options mirror the REST contract:
`app`, `infer`, `memoryType`, `metadata` (Add); `sessionId`, `project`, `tags`,
`isAgentMemory` (Add Conversation); `topK` (default `10`), `mode`, `sessionId`, `rerank`,
`memoryType` (Search); `page`, `appId`, `categories`, `searchQuery`, `includeSuperseded`,
`memoryType`, plus `Return All` (List).

### What Cortadel records as the app

Both nodes label themselves `n8n-nodes-cortadel` — this package's published npm name, the same
convention every Cortadel integration follows. It is sent as `app_name` on searches (access
logging) and as `app` on writes (the app that created the memory); the Add operation's `app`
field overrides the write label if you want a finer one. There is no option for it on the
memory sub-node: a workflow author has no reason to misreport which node wrote a memory.

## Design note: why not bundle `@cortadel/sdk`?

Cortadel publishes a TypeScript SDK, and for any other TypeScript integration it would be the
right dependency. n8n is the exception: **verified community nodes are not allowed run-time
dependencies**, and n8n's own `this.helpers.httpRequestWithAuthentication` is what applies the
credential's `authenticate` block along with the instance's proxy and TLS configuration —
things a bundled HTTP client would bypass. So this package ships **zero run-time dependencies**
and talks to the same REST contract (`spec/openapi.json`) the SDK is generated from, with the
wire DTOs transcribed into `shared/types.ts`.

The same rule shapes the message objects. n8n's built-in memory nodes import LangChain's
`HumanMessage`/`AIMessage`/`SystemMessage` directly; this package cannot. Instead it tries to
resolve the host's own `@langchain/core/messages` at run time — present in any n8n instance that
has the AI nodes — and falls back to a dependency-free shim when it is not (sandboxed or
non-hoisted community-node hosts, mostly). `dist/` is CommonJS, as n8n requires, but it is
emitted with `module: node16` (TypeScript 7 removed the old `node10` resolution mode), which
also leaves the one dynamic `import()` as a real dynamic import rather than downleveling it to
`require()` — so the host's `@langchain/core` loads through whichever build its `exports` map
offers, ESM included.

That fallback has to be more than `content` + `_getType()`, and the reason is easy to miss:
`coerceMessageLikeToMessage()` treats anything with a `_getType` function as already-a-message
and returns it **uncoerced**, so a shim is handed to the model provider verbatim — and provider
converters read `message.response_metadata` and `message.additional_kwargs` without a guard.
The shim therefore carries the full field set, and `test/message-compat.test.ts` proves it by
running real `@langchain/core` coercion and the real `@langchain/openai` message converter over
shim-rendered memories.

## Running the tests

```bash
cd integrations/n8n-nodes-cortadel
pnpm install
pnpm exec vitest run     # or: pnpm test
```

The suite is fully offline: no live Cortadel server, no network, no `CORTADEL_*` env vars, no
keys. Every HTTP call is stubbed at n8n's `httpRequestWithAuthentication` boundary. All test
data uses `e2e-*` user ids.

`@langchain/core`, `@langchain/openai` and `@langchain/anthropic` are installed as
**devDependencies only**, purely so `test/message-compat.test.ts` can assert against the real
classes and the real provider message converters instead of restating a comment. The published
package still has no `dependencies` at all, and `files` ships `dist/` alone. If they are absent
that one suite skips itself; the rest still runs.

Also useful:

```bash
pnpm typecheck           # tsc --noEmit over the shipped surface, then tsconfig.test.json over test/
pnpm run build           # tsc + copy icons into dist/
```

`pnpm typecheck` is two passes on purpose. The build config keeps `test/` out of `dist/`, which
also kept it out of `tsc --noEmit`; `tsconfig.test.json` adds it back as a check-only pass —
with `module: esnext`, because vitest loads the tests as ES modules and one of them uses
top-level `await import()`.

## Requirements

- **n8n** with the AI nodes available (the `ai_memory` port only exists on the AI Agent node).
  Verified against `n8n-workflow` **2.16.0** — the node uses `NodeConnectionTypes.AiMemory` and
  `usableAsTool`, both long-standing in current n8n.
- **Node.js ≥ 20**.
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` (→ `http://localhost:3001`). See
  [`docs/self-hosting.md`](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md).

## Links

- Source and issues: <https://github.com/cortadel/cortadel>
- Cortadel: <https://cortadel.ai>

Licensed under Apache-2.0.
