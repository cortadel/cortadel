---
title: Integrations
description: First-party Cortadel packages for twelve agent frameworks — eight TypeScript, three Python and one .NET — with memory tools plus automatic recall and persistence.
---

Cortadel ships **first-party integration packages** for twelve agent frameworks. Each one is a
standalone, publishable package that makes Cortadel feel native inside its host framework: install
it, point it at your server, and the agents you already have gain long-term memory.

Each package gives you up to two things:

- **Memory tools** — `search_memory` and `add_memories`, built with the framework's own tool
  primitive, so an agent can decide for itself what to look up and what is worth remembering. The
  names match Cortadel's own MCP surface everywhere; only OpenClaw differs, and only because its
  host requires a plugin prefix (`cortadel_search_memory`, `cortadel_add_memories`). n8n has no
  per-tool naming hook at all, so it exposes the equivalents as node operations instead.
- **Automatic memory** — the framework's own extension point (a store interface, middleware,
  capability, processor, plugin, context provider or lifecycle hook) that searches Cortadel before
  each model call, injects what it finds, and hands the finished turn to `add_conversation`
  afterwards. The agent doesn't have to cooperate, or even know.

Where a framework already has a first-class memory abstraction, the integration implements **that**
— LangGraph's `BaseStore`, the OpenAI Agents SDK's `Session`, Agent Framework's
`AIContextProvider`, CrewAI's `Memory`, Google ADK's `BaseMemoryService` — rather than bolting a
callback onto the side.

All of them talk to a running Cortadel server: the hosted service at `https://app.cortadel.ai`, or
your own (`docker compose up` → `http://localhost:3001`, see [Self-hosting](/self-hosting/)).

:::note
**Status — published at `0.1.0`.** Every package below went live on its registry on 2026-08-14
(npm ×8, PyPI ×3, NuGet ×1) and its source lives in
[`integrations/`](https://github.com/cortadel/cortadel/tree/main/integrations) — the install
commands work as written, and every npm package carries a Sigstore provenance attestation. Each
package ships an offline test suite that drives the real host framework (fake model, stubbed
Cortadel client); none is exercised against a live Cortadel server in CI, so wire-level behaviour
rests on the [SDKs](/sdk-python/) and their own conformance suites.
:::

## Three languages, and why

**Eight TypeScript · three Python · one .NET.** The language is not a preference — it is decided by
what the host framework itself publishes:

- **TypeScript (8)** — `@cortadel/claude-agent-sdk`, `@cortadel/deepagents`,
  `@cortadel/langgraph`, `@cortadel/mastra`, `n8n-nodes-cortadel`, `@cortadel/openai-agents`,
  `@cortadel/openclaw`, `@cortadel/vercel-ai-provider`. **Where a framework ships a first-party
  TypeScript package as well as a Python one, the integration is written in TypeScript.** LangGraph,
  DeepAgents, the OpenAI Agents SDK and the Claude Agent SDK all publish both; each of those
  integrations targets the framework's own npm package, against its own types.
- **Python (3)** — `cortadel-crewai`, `cortadel-google-adk`, `cortadel-pydantic-ai`. These three
  frameworks have **no first-party TypeScript package at all**. (The npm package `@iqai/adk` is a
  third-party port of Google ADK, not Google's own.) Python is the only language their maintainers
  ship, so it is the only language an integration can be built in without depending on someone
  else's reimplementation.
- **.NET (1)** — `Cortadel.AgentFramework`, targeting `net8.0`. The Microsoft Agent Framework is a
  .NET-first framework, so its integration is a NuGet package built on `Microsoft.Agents.AI` and the
  [.NET SDK](/sdk-dotnet/).

So: **LangGraph is TypeScript because LangChain publishes `@langchain/langgraph` itself; CrewAI is
Python because CrewAI publishes nothing outside PyPI.** Same rule, different answer.

## The integrations

| Framework | Package | Language | What you get | Folder |
|---|---|---|---|---|
| **Claude Agent SDK** | `@cortadel/claude-agent-sdk` | TypeScript | Memory tools via an in-process MCP server, plus `UserPromptSubmit` / `Stop` hooks | [`integrations/claude-agent-sdk`](https://github.com/cortadel/cortadel/tree/main/integrations/claude-agent-sdk) |
| **DeepAgents** | `@cortadel/deepagents` | TypeScript | An `AgentMiddleware` that recalls and persists, plus native tools | [`integrations/deepagents`](https://github.com/cortadel/cortadel/tree/main/integrations/deepagents) |
| **LangGraph** | `@cortadel/langgraph` | TypeScript | A `BaseStore` implementation, memory tools, and recall/persist graph nodes | [`integrations/langgraph`](https://github.com/cortadel/cortadel/tree/main/integrations/langgraph) |
| **Mastra** | `@cortadel/mastra` | TypeScript | A `Processor` that recalls and persists, plus `createTool` memory tools | [`integrations/mastra`](https://github.com/cortadel/cortadel/tree/main/integrations/mastra) |
| **n8n** | `n8n-nodes-cortadel` | TypeScript | A Cortadel Memory sub-node for the AI Agent's `ai_memory` port, and a six-operation action node | [`integrations/n8n-nodes-cortadel`](https://github.com/cortadel/cortadel/tree/main/integrations/n8n-nodes-cortadel) |
| **OpenAI Agents SDK** | `@cortadel/openai-agents` | TypeScript | A `Session` implementation, recall via `callModelInputFilter`, and function tools | [`integrations/openai-agents`](https://github.com/cortadel/cortadel/tree/main/integrations/openai-agents) |
| **OpenClaw** | `@cortadel/openclaw` | TypeScript | A memory corpus supplement, two agent tools, and recall/capture hooks | [`integrations/openclaw`](https://github.com/cortadel/cortadel/tree/main/integrations/openclaw) |
| **Vercel AI SDK** | `@cortadel/vercel-ai-provider` | TypeScript | A `LanguageModelMiddleware` that recalls and persists, plus AI SDK tools | [`integrations/vercel-ai-sdk`](https://github.com/cortadel/cortadel/tree/main/integrations/vercel-ai-sdk) |
| **CrewAI** | `cortadel-crewai` | Python | A drop-in `crewai.Memory`, native crew tools, and a task-completed listener | [`integrations/crewai`](https://github.com/cortadel/cortadel/tree/main/integrations/crewai) |
| **Google ADK** | `cortadel-google-adk` | Python | A `BaseMemoryService` (so ADK's own `load_memory` / `preload_memory` work), an auto-persist plugin, and tools | [`integrations/google-adk`](https://github.com/cortadel/cortadel/tree/main/integrations/google-adk) |
| **Pydantic AI** | `cortadel-pydantic-ai` | Python | An `AbstractCapability` that recalls, persists, and contributes a memory toolset | [`integrations/pydantic-ai`](https://github.com/cortadel/cortadel/tree/main/integrations/pydantic-ai) |
| **Microsoft Agent Framework** | `Cortadel.AgentFramework` | .NET | An `AIContextProvider` (`ProvideAIContextAsync` / `StoreAIContextAsync`) plus native `AIFunction` tools | [`integrations/microsoft-agent-framework`](https://github.com/cortadel/cortadel/tree/main/integrations/microsoft-agent-framework) |

Every package is Apache-2.0 and built on the published Cortadel SDK for its language —
[`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk) on npm,
[`cortadel`](https://pypi.org/project/cortadel/) on PyPI, or
[`Cortadel.Sdk`](https://www.nuget.org/packages/Cortadel.Sdk) on NuGet.

## Common configuration

Whatever the framework's naming convention, every integration is configured with the same four
Cortadel values (`camelCase` in TypeScript, `snake_case` in Python, `PascalCase` in .NET; on n8n
they are split between the credential and the node):

| Setting | Meaning |
|---|---|
| `baseUrl` / `base_url` / `BaseUrl` | Your Cortadel origin — `https://app.cortadel.ai` hosted, or `http://localhost:3001` self-hosted. |
| `userId` / `user_id` / `UserId` | The memory namespace. Every SDK call is scoped to it, so per-user memory means a client per user id — integrations that serve many tenants resolve the id per run and pool clients for you. |
| `apiKey` / `api_key` / `ApiKey` | The bearer token (see [Authentication](/authentication/)). Omit it when the server runs with auth disabled. |
| `appName` / `app_name` / `AppName` | The label recorded on writes and in access logs. Defaults to the integration's own published package name: `@cortadel/langgraph`, `@cortadel/deepagents` and `@cortadel/claude-agent-sdk` record the scoped npm name verbatim, `@cortadel/mastra`, `@cortadel/openai-agents`, `@cortadel/openclaw` and `@cortadel/vercel-ai-provider` record the de-scoped form (`cortadel-mastra`, …), the Python packages record `cortadel-crewai` / `cortadel-google-adk` / `cortadel-pydantic-ai`, and the .NET package records `Cortadel.AgentFramework`. The n8n nodes fix theirs to `n8n-nodes-cortadel` rather than exposing it. |

### The shared vocabulary

Beyond those four, five more knobs mean the same thing in every package that has the concept, and
are spelled the same way. The **names** are fixed repo-wide; a package may ship a different
**default** where its framework forces one, and its README says why. TypeScript uses `camelCase`
and Python `snake_case`; the .NET package expresses the same five concepts in the same words, in
PascalCase — `ThrowOnError`, `OnError`, `TopK`, `AwaitPersist`, `ScopeRecallToSession` — so it is one
vocabulary with one casing per language, not a different vocabulary.

| Setting | Meaning | Default |
|---|---|---|
| `throwOnError` / `raise_on_error` | Propagate a Cortadel failure to the caller instead of degrading to "this turn has no memory". | `false` / `False` — fail open |
| `onError` / `on_error` | A **callback**, handed the exception when a Cortadel call fails. Never a mode string, never a bool. Set none and a swallowed failure is logged as a warning instead. | unset |
| `topK` / `top_k` | How many memories to retrieve. | `5` for automatic per-turn injection; `10` for an explicit `search_memory` tool, matching the SDK's own `SearchOptions` default |
| `awaitPersist` / `await_persist` | Wait for the write to land before the turn returns. | `false` where a detached write is safe — `true` in frameworks that end the run (and often the process) the moment the last hook returns, which would silently drop the memory |
| `scopeRecallToSession` / `scope_recall_to_session` | Recall only what was stored under this session, instead of everything Cortadel knows about the user. | `false` / `False` |

The propagate flag is the one row whose *verb* changes with the language rather than just its casing:
TypeScript and .NET spell it `throwOnError` / `ThrowOnError` because those languages throw, Python
spells it `raise_on_error` because Python raises. One concept, one stem per language family, so the
option reads like the code around it — every package follows it, with no survivals of the other
spelling.

Not every package exposes all five, and that is deliberate rather than an omission: a package whose
writes are always blocking has no `awaitPersist` to offer, and the two configured entirely through
JSON — n8n and OpenClaw — cannot accept a callback at all, so they fail open unconditionally and
warn through their host's own logger. OpenClaw's scope knob is a four-value enum (`recallScope`:
`fixed`, `agent`, `session`, `sender`) rather than a boolean, because it genuinely has four scopes.

Everything else — rerank, memory type, tags, dedupe windows, timeouts — is per-package and
documented in that package's README.

:::note
**Memory failures degrade, they don't escalate.** Every integration treats an unreachable or slow
Cortadel server as "this turn has no memory", never as a failed agent run. Escalating is opt-in
and uniformly named: `throwOnError` / `raise_on_error` / `ThrowOnError`, off everywhere by
default. The one failure that is *not* deferred is bad connection settings in a package that
builds its client **eagerly**: `@cortadel/claude-agent-sdk` constructs the Cortadel client inside
`new CortadelMemory(...)`, and the SDK validates `baseUrl` / `userId` in its own constructor, so a
typo throws at wiring time instead of becoming silently dead memory. Packages that resolve a
client per run — `@cortadel/deepagents`, for one — cannot do that, and disable memory for the run
with a one-time warning instead.
:::

## TypeScript packages

### Claude Agent SDK

```bash
npm install @cortadel/claude-agent-sdk
```

Gives a programmatic Claude agent long-term memory through both of the SDK's native seams: an
in-process MCP server (`createSdkMcpServer`) exposing `mcp__cortadel__search_memory` and
`mcp__cortadel__add_memories`, plus `UserPromptSubmit` / `Stop` hooks that recall relevant memories
into the turn and persist the finished exchange without the agent asking. One line wires it up —
`memory.apply(options)` returns a **copy** of your `Options` with the server, the allowed tool names
and both hooks merged in; `apply(options, { tools: false })` or `{ autoMemory: false }` takes one
half. `CortadelMemory.fromEnv()` reads the same `CORTADEL_URL` / `CORTADEL_USER_ID` variables as the
plugin, and `fromClient()` accepts a Cortadel client you already own. For *interactive* Claude Code,
use the [`cortadel-memory` plugin](/plugin/) instead; this package is for agents you build in
TypeScript.

**Limits.** `@anthropic-ai/claude-agent-sdk` (≥ 0.3.0, < 0.4.0 — developed against 0.3.231) and
`zod` ^4 are **peer** dependencies; Node ≥ 20. Two hooks are wired and no more: the TypeScript SDK's
`HookEvent` union *does* include `SessionStart`, but priming memory at session start remains the
plugin's job. `awaitPersist` defaults to `true`, against the repo-wide fire-and-forget default,
because `Stop` fires as the turn winds down — hand the write to a floating promise and `query()` can
close its transports, often the process with them, before it lands; `awaitPersist: false` needs
`flush()` to drain. One `topK` (default 5) serves both the recall hook and the `search_memory` tool
rather than the tool's usual 10, because automatic injection spends context on every turn.
`scopeRecallToSession` applies to the hook only — a tool handler is handed its arguments and no
session id. Tools always report a failure to the model as an `isError` result, so `throwOnError`
changes hook behaviour only. A client is bound to one user id at construction, so multi-user apps
build one `CortadelMemory` per user — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/claude-agent-sdk).

### DeepAgents

```bash
npm install @cortadel/deepagents deepagents langchain @langchain/core
```

`createCortadelMemoryMiddleware()` returns a LangChain v1 `AgentMiddleware` — built with
`createMiddleware`, the same primitive DeepAgents uses for its own built-ins — that you drop into
`createDeepAgent({ middleware: [...] })`. It hooks three points: `beforeAgent` hybrid-searches once
per turn, `wrapModelCall` renders the hits into the system message for each model call (a deep agent
makes many per turn, so searching per call would multiply latency for no new information), and
`afterAgent` hands the turn's new messages to `addConversation`. The injection rides on a per-call
copy of the `ModelRequest`, so recalled memory can never accumulate in the transcript or be stored
back as if the user had said it. `createCortadelTools()` builds the same `search_memory` /
`add_memories` pair standalone; the middleware registers them by default (`exposeTools`).

**Limits.** Peer dependencies `deepagents` ≥ 1.12, `langchain` ≥ 1.5, `@langchain/core` ≥ 1.2;
Node ≥ 20. `awaitPersist` defaults to `true`, against the repo-wide default: `afterAgent` is the last
node of the run, and the middleware only advances its persisted-message cursor on a confirmed write
— a failed write leaves the cursor unadvanced so the next turn retries that suffix. Don't stack this
with `@cortadel/langgraph`'s `CortadelMemory` nodes; both recall and persist, and you would pay for
each twice (the store and this middleware *do* compose — the middleware never touches
`runtime.store`). Per-run user ids come from `runtime.context[userIdKey]` or
`runtime.configurable[userIdKey]`, and the middleware declares that key in its **own**
`contextSchema` — LangChain hands a middleware only the context keys it declares, so you do not have
to add it to your agent's `contextSchema`, and adding it anyway does not conflict. An id that is not
a non-empty string disables memory for that run with a one-time warning rather than failing it.
Passing `client` pins every run to that client's user; multi-user agents pass `clientFactory` — see
the [package README](https://github.com/cortadel/cortadel/tree/main/integrations/deepagents).

### LangGraph

```bash
npm install @cortadel/langgraph
```

`CortadelStore` **is** a LangGraph `BaseStore` — the JavaScript base class declares exactly one
abstract member, `batch()`, and derives `get` / `search` / `put` / `delete` / `listNamespaces` from
it — so Cortadel drops into anything that already takes a store: `compile({ store })`,
`createReactAgent({ store })`, `getStore()`, a tool's `config.store`. `createMemoryTools()` adds
`search_memory` and `add_memories` as `@langchain/core` tools that talk to whatever store they are
called with (so they still work against an `InMemoryStore` in a unit test). `CortadelMemory` gives
memory with no tool call: `recallNode` writes into **`llmInputMessages`**, the channel
`createReactAgent` hands the model *instead of* `messages`, so the memory block never joins the
durable transcript, and `rememberNode` waits for a final answer before persisting. Namespaces are
templated (`["memories", "{userId}"]`), so one store serves every user of a multi-tenant graph, and
recall can be narrowed to the current thread with `scopeRecallToSession` — which the Python original
had no way to express.

**Limits.** Peers: `@langchain/langgraph` ≥ 1.4.9, `@langchain/langgraph-checkpoint` ≥ 1.1.3,
`@langchain/core` ≥ 1.1.48 and `zod`; Node ≥ 20. Those peer ranges are load-bearing rather than
cosmetic — a second, hoisted copy of `@langchain/langgraph-checkpoint` would make the `BaseStore`
this package extends a *different class* from the one your graph checks against. `put()` cannot
honour a caller-chosen key (Cortadel mints its own ids), so a caller key is bridged through a
process-local alias table that does not survive a restart. `listNamespaces()` reports only the
namespaces this store instance has touched. `memoryType` / `sessionId` filters are pushed to the
server and the rest are applied client-side; an unusable filter key is warned about once rather than
silently dropping results. Calls into the store keep LangGraph's own `limit=` keyword — that is
`BaseStore.search()`'s signature, not this package's — so only the surface this package owns uses
`topK`. `awaitPersist` defaults to `true`: a graph node has no lifetime of its own, and LangGraph is
free to tear the process down once the run ends. LangGraph wraps a compiled store in
`AsyncBatchedStore`, which forwards only the four `BaseStore` operations, so a store-less
`CortadelMemory` looks **through** that wrapper to persist against the `CortadelStore` inside it (a
wrapper of your own keeping its inner store on `.store` is seen through too); reading through a
node's `config.store` after `invoke()` has returned will hang, so keep your own reference for
outside-the-graph reads. Namespace labels cannot contain a period and the first cannot be
`"langgraph"` — `BaseStore.put`'s own validation, worth knowing if your user ids are email
addresses. `createReactAgent` is deprecated as of LangGraph 1.0 in favour of `createAgent`; both
paths are covered. The JavaScript `BaseStore` has no TTL, so unlike the Python one there is nothing
to opt out of. `CortadelStore` and `CortadelMemory` carry one `throwOnError` each, independently, and
the memory node's detached write is past the point of throwing — that failure reaches `onError` or
the logger instead — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/langgraph).

### Mastra

```bash
npm install @cortadel/mastra
```

Gives a Mastra agent long-term memory as native primitives: a `Processor` that recalls relevant
memories into the system prompt before every model call and persists the finished turn afterwards,
plus `search_memory` and `add_memories` tools the model can call itself. Mastra's
`resourceId` becomes the Cortadel user id and its `threadId` becomes the Cortadel session, with
per-user clients pooled automatically so one agent can serve many users.

**Limits.** Mastra only propagates `resourceId` when a `threadId` is present, so
`agent.generate(text)` with no `memory` option has nothing to scope to — pass
`memory: { resource, thread }`, set the resource on the request context, or pin `userId`. Recall
runs once per turn, not per step of the agentic loop, and the dedupe/repeat guards are in-process,
so a horizontally-scaled deployment re-injects a memory once per instance. It is deliberately a
`Processor` and not a `MastraMemory` subclass — that class is a 13-method *storage* interface
Cortadel would have to fake most of. `awaitPersist` defaults to `true`, unlike the repo-wide `false`:
Mastra ships first-party deployers for Cloudflare Workers, Vercel and Netlify, runtimes free to
freeze the isolate the moment the response returns, which is exactly where an un-awaited write dies.
In Mastra the model-facing tool name is the key a tool is registered under, not its `id`, so renaming
one means re-keying it (`tools: { my_recall: cortadel.tools.search_memory }`) — the `idPrefix` option
prefixes ids only and does not change what the model calls — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/mastra).

### n8n

Install from **Settings → Community nodes → Install**:

```
n8n-nodes-cortadel
```

Two nodes. A **Cortadel Memory** sub-node plugs into the AI Agent's memory port and, on every turn,
runs a fresh hybrid BM25 + vector search across everything Cortadel knows about that user before
handing the finished turn back for fact extraction. A **Cortadel** action node exposes all six REST
operations and doubles as an agent tool. It ships zero run-time dependencies (n8n's verified-node
rule), degrades to empty context rather than breaking the agent, and never deletes memories when a
chat window is cleared.

**Limits.** On the AI Agent's **streaming** path n8n never passes the turn's input to a memory
sub-node, so recall there degrades to recent memories instead of a query-relevant search (the custom
memory key is ignored on that path too). **Context Role** defaults to `user`, the only role that
cannot fail — Anthropic permits a system message in first position only, and recalled context always
lands after the agent's own System Message. Choose `system` if you are on an OpenAI-style model and
want the context read as instructions; on the Anthropic Chat Model it throws. Node parameters are
JSON values set in a UI, so there is no `onError` callback and no `throwOnError`: memory failures
always degrade, and are warned through n8n's own logger. The action node's operations keep n8n's
`search` / `addConversation` naming rather than the canonical tool stems, because n8n derives an
agent-facing tool name from the node's workflow name and gives operations no naming hook — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/n8n-nodes-cortadel).

### OpenAI Agents SDK

```bash
npm install @cortadel/openai-agents @openai/agents zod
```

`CortadelSession` implements the SDK's `Session` interface, keeping verbatim history in a transcript
session while distilling each finished turn into long-term memory. `session.runOptions()` installs
**both** halves in one object — the session *and* a `callModelInputFilter` that searches Cortadel for
the latest user message and injects the hits — so `run(agent, input, session.runOptions())` is the
entire wiring, and it copies any options you hand it rather than clobbering them. For agents that
should decide when to remember, `cortadelMemoryTools()` returns `search_memory` and `add_memories` as
ordinary `FunctionTool`s, and `session.tools()` returns the same pair bound to the session's own
settings.

**Limits.** Peers `@openai/agents` ≥ 0.15.0, < 1.0.0 (verified against 0.15.0) and `zod` ^4;
Node ≥ 20. Cortadel is not the transcript — it deduplicates and does not preserve item order — so
`CortadelSession` *wraps* a transcript `Session` (the SDK's in-memory `MemorySession` by default;
pass `transcript:` any `Session` to survive restarts). The TypeScript runner **persists whatever
`callModelInputFilter` produced back into the session**, which would replay the injected block as
history next turn and suppress fresh recall, so the package strips its own block in `addItems` —
injection stays ephemeral in both `injectAs` modes. Sessions are mutually exclusive with
`conversationId` / `previousResponseId` at the SDK level; use tools-only mode there.
`clearSession()` clears the transcript, not Cortadel, and `popItem()` rewinds history, not memory.
Recall is keyed on the latest user message, so an image-only or tool-only turn injects nothing.
`awaitPersist` defaults to **`false`** here, where the Python original defaulted to `True`: a pending
`fetch` keeps Node's event loop alive, so even a script that falls off the end lands its write — set
it to `true`, or `await session.flush()`, on serverless runtimes and before `process.exit()`.
`cortadelMemoryTools()` defaults to `topK` 10, while `session.tools()` inherits the session's 5 so an
explicit search and an automatic recall can't disagree in the same turn — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/openai-agents).

### OpenClaw

```bash
openclaw plugins install clawhub:cortadel/openclaw
```

Wires Cortadel into OpenClaw at three seams: Cortadel becomes an additive memory corpus behind
OpenClaw's own `memory_search` / `memory_get`, the agent gets two dedicated tools
(`cortadel_search_memory`, `cortadel_add_memories` — OpenClaw mandates the plugin prefix, so the
canonical stems are kept behind it), and optional hooks recall relevant memories
before each model call and capture every completed turn afterwards. It composes with OpenClaw's
built-in memory-core rather than replacing it. The same code is published to npm as
`@cortadel/openclaw` if you manage plugin directories yourself.

**Limits.** Verified against `openclaw` 2026.7.1-2 only, and never loaded by a live gateway — the
load path is reproduced from OpenClaw's own shipped validators and manifest loader, not executed by
the CLI. Auto-captured facts carry no app label (Cortadel's conversation API has no app field); only
facts written through `cortadel_add_memories` do. Configuration is plain JSON in `openclaw.json`,
so there is no `onError` callback and no `throwOnError`: failures always degrade and are warned
through OpenClaw's own `PluginLogger`. `recallScope` picks the Cortadel *user id* for the turn, so
narrowing it narrows capture as well as recall, and one `topK` (default 5) serves both automatic
injection and the search tool — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/openclaw).

### Vercel AI SDK

```bash
npm install @cortadel/vercel-ai-provider
```

Two ways in. `cortadelMemory()` is a `LanguageModelMiddleware` for `wrapLanguageModel` that searches
Cortadel before every model call, injects the hits as a system message, and stores the finished turn
afterwards — no change to your `generateText` / `streamText` code. `cortadelTools()` adds
`search_memory` and `add_memories` as native tools for when you want the agent deciding what to
remember. Model-agnostic, and it composes with `wrapProvider` and `createProviderRegistry` too.

**Limits.** Requires `ai` ≥ 7 and Node ≥ 22. `awaitPersist` defaults to `false`, so on
serverless/edge runtimes set it to `true` or the background write dies when your handler returns —
and because a fire-and-forget write has already returned, `throwOnError` cannot apply to it, so its
failure reaches `onError` only. Tools are single-user by design — the user id never enters a tool's
input schema, so multi-tenant callers build a tool set per request, while the middleware takes a
per-request user via `providerOptions.cortadel.userId`. There is no `scopeRecallToSession` here:
`sessionId` is passed straight through to the SDK, where today it both groups writes *and* restricts
recall. Persistence stores the final user↔assistant exchange, not the
whole history — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/vercel-ai-sdk).

## Python packages

### CrewAI

```bash
pip install cortadel-crewai
```

Makes Cortadel a drop-in `crewai.Memory`, so a crew recalls from and writes to your Cortadel server
instead of a local vector store — hybrid retrieval, dedup, entity extraction and bi-temporal
versioning all happen server-side. It also ships `search_memory` / `add_memories` as native CrewAI
tools for agents that should decide when to remember, and an event-bus listener that hands each
completed task to Cortadel's extraction pipeline via `add_conversation`.

**Limits.** Requires `crewai >= 1.10.0` — the release that introduced the unified memory surface —
and that floor is derived from published wheel contents, not tested below 1.15.x. Python
≥ 3.11, < 3.14: one rung above crewai's own floor, because a transitive dependency ships no 3.10
wheel and no sdist to fall back on. Recall keeps CrewAI's inherited `limit=` parameter rather than
`top_k` — the framework calls it by keyword in four places, so renaming it would break the
integration outright; the `search_memory` tool does use `top_k`. `Crew.copy()`
(used by `kickoff_for_each`, `train`, `test`) downgrades *agent-level* memory back to a plain
`crewai.Memory`; crew-level memory is unaffected. CrewAI's own auto-save path runs an LLM extraction
hop and silently no-ops without an LLM key, which recall does not — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/crewai).

### Google ADK

```bash
pip install cortadel-google-adk
```

Implements ADK's own `BaseMemoryService`, so a single `CortadelMemoryService` passed to
`Runner(memory_service=...)` gives every agent in the tree persistent, hybrid-search memory and
makes ADK's built-in `load_memory` and `preload_memory` tools work against Cortadel with no other
changes. Because ADK's runner never writes to memory on its own, the package also ships
`CortadelMemoryPlugin`, which persists each finished turn (sending only that invocation's events),
plus model-callable `search_memory` / `add_memories` tools.

**Limits.** ADK's `app_name` has no Cortadel filter equivalent, so two ADK apps sharing a `user_id`
share memory unless you pass a `user_id_resolver`. The optional `inject=True` prompt injection
appends to the system instruction rather than ADK's own private transient-content slot, which is why
`preload_memory` is the recommended route and injection defaults to off. Ingestion writes are always
awaited at the end of a turn and there is no `await_persist` knob — ADK's `Runner` neither tracks nor
awaits a task created in `after_run_callback`, so a detached write would outlive the run that owns it.
One `top_k` (default 5) governs both automatic injection and the explicit `search_memory` tool — see
the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/google-adk).

### Pydantic AI

```bash
pip install cortadel-pydantic-ai
```

Cortadel plugs in as a native capability: add `CortadelMemory(base_url=..., user_id=...)` to your
agent's `capabilities=[...]` and it contributes `search_memory` and `add_memories` tools, recalls
relevant memories into the prompt before each run, and persists the turn afterwards. Recall runs
once per *run* (not once per model request) and injects nothing when there is nothing to recall;
multi-tenant apps pass a callable `user_id` to scope memory per user from `ctx.deps`.

**Limits.** Persistence is awaited inside `after_run` by default (`await_persist=True`), so it adds
one round-trip to run latency. That default is deliberate: `after_run` is the last hook in a run, and
the usual `asyncio.run(main())` shape cancels a detached write the moment `main()` returns.
`await_persist=False` takes it off the critical path, but then you must call `aclose()` to drain what
is still in flight, and a backgrounded failure reaches `on_error` only — `raise_on_error` has no
caller left to raise into. Recalled memories are recorded on each historical
`ModelRequest.instructions`: they are *not* re-sent to the provider, but a serialized transcript dump
will contain the recalled text. The capability is deliberately not spec-serializable, so
`Agent.from_file()` can't express it — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/pydantic-ai).

## .NET package

### Microsoft Agent Framework

```bash
dotnet add package Cortadel.AgentFramework
```

`CortadelContextProvider` is a real `Microsoft.Agents.AI.AIContextProvider` — the framework's own
memory seam. `ProvideAIContextAsync` hybrid-searches your memory with the turn's input and returns an
`AIContext` the framework merges into the invocation, as a user-role context message by default or as
system instructions (`InjectAs`); `StoreAIContextAsync` hands the completed turn to Cortadel's
conversation pipeline. Attach it through `ChatClientAgentOptions.AIContextProviders`.
`CortadelMemoryTools.CreateAll(client)` exposes `search_memory` and `add_memories` as
`Microsoft.Extensions.AI.AIFunction`s built with `AIFunctionFactory.Create`, so their JSON schema
comes from the method signature — or set `IncludeMemoryTools = true` and one attachment gives both
capabilities. Per-session state (already-injected memory ids, the Cortadel session id) lives in
`AgentSession.StateBag`, so one provider instance safely serves many sessions and the state survives
`SerializeSessionAsync`.

**Limits.** The framework's **.NET** flavour only — its Python flavour has no Cortadel package.
Targets `net8.0`, and needs `Microsoft.Agents.AI` ≥ 1.17.0 plus a `Microsoft.Extensions.AI` chat
client to reach a model. Options are the shared vocabulary in PascalCase (`TopK`, `AwaitPersist`,
`ThrowOnError`, `OnError`, `ScopeRecallToSession`). `AwaitPersist` defaults to `true`, against the
repo-wide fire-and-forget default, because the framework never disposes a provider: a program that
returns from `RunAsync` and exits would drop an in-flight write — set it to `false` and dispose the
provider (`await using`) to flush, after which a failed write can only be seen through `OnError`.
Streaming runs are not driven by a test: the suite's fake chat client implements the streaming path,
but every end-to-end test goes through `RunAsync`. `OperationCanceledException` is always rethrown
untouched — cancellation is your intent, not a Cortadel failure. Attaching more than one provider to
the same agent needs a distinct `StateKeyPrefix` on each, or they collide in the state bag — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/microsoft-agent-framework).

## Not seeing your framework?

Two options that need no integration package at all:

- **[MCP](/mcp/)** — any MCP-capable client or agent framework can read and write memory over the
  Streamable-HTTP endpoint with no glue code.
- **The SDKs** — [.NET](/sdk-dotnet/), [Python](/sdk-python/), and
  [TypeScript](/sdk-typescript/) are thin typed clients over the REST API; every integration above
  is built on one of them, in a few hundred lines.

## Building one

Integrations live in
[`integrations/`](https://github.com/cortadel/cortadel/tree/main/integrations), one directory per
publishable package. That folder's
[README](https://github.com/cortadel/cortadel/tree/main/integrations#readme) is the contributor
guide: how a package is laid out, how to build and test one in each of the three toolchains, and what
a new integration has to include before it can be merged. Start there, and read
[CONTRIBUTING.md](https://github.com/cortadel/cortadel/blob/main/CONTRIBUTING.md) for the general
workflow.

## Next steps

- [Getting started](/getting-started/) — run a server and store your first memory.
- [Authentication](/authentication/) — mint the API key your integration will need.
- [MCP integration](/mcp/) — the no-code path for any MCP-capable client.
- [Claude Code & Codex plugin](/plugin/) — ambient memory for interactive Claude Code sessions.
