# Integrations

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
  capability, processor, plugin, or lifecycle hook) that searches Cortadel before each model call,
  injects what it finds, and hands the finished turn to `add_conversation` afterwards. The agent
  doesn't have to cooperate, or even know.

Where a framework already has a first-class memory abstraction, the integration implements **that**
— LangGraph's `BaseStore`, CrewAI's `Memory`, Google ADK's `BaseMemoryService`, the OpenAI Agents
SDK's `Session` — rather than bolting a callback onto the side.

All of them talk to a running Cortadel server: the hosted service at `https://app.cortadel.ai`, or
your own (`docker compose up` → `http://localhost:3001`, see [Self-hosting](self-hosting.md)).

> **Status — `0.1.0`, in this repo, not yet on the registries.** Every package below is versioned
> `0.1.0` and lives in
> [`integrations/`](https://github.com/cortadel/cortadel/tree/main/integrations) — the install
> commands are the ones that will work, but nothing is published to PyPI or npm yet. Each package
> ships an offline test suite that drives the real host framework (fake model, stubbed Cortadel
> client); none is exercised against a live Cortadel server in CI, so wire-level behaviour rests on
> the [SDKs](sdk-python.md) and their own conformance suites.

## The integrations

| Framework | Package | Language | What you get | Folder |
|---|---|---|---|---|
| **Claude Agent SDK** | `cortadel-claude-agent-sdk` | Python | Memory tools via an in-process MCP server, plus `UserPromptSubmit` / `Stop` hooks | [`integrations/claude-agent-sdk`](https://github.com/cortadel/cortadel/tree/main/integrations/claude-agent-sdk) |
| **CrewAI** | `cortadel-crewai` | Python | A drop-in `crewai.Memory`, native crew tools, and a task-completed listener | [`integrations/crewai`](https://github.com/cortadel/cortadel/tree/main/integrations/crewai) |
| **DeepAgents** | `cortadel-deepagents` | Python | An `AgentMiddleware` that recalls and persists, plus native tools | [`integrations/deepagents`](https://github.com/cortadel/cortadel/tree/main/integrations/deepagents) |
| **Google ADK** | `cortadel-google-adk` | Python | A `BaseMemoryService` (so ADK's own `load_memory` / `preload_memory` work), an auto-persist plugin, and tools | [`integrations/google-adk`](https://github.com/cortadel/cortadel/tree/main/integrations/google-adk) |
| **LangGraph** | `cortadel-langgraph` | Python | A `BaseStore` implementation, memory tools, and recall/persist graph nodes | [`integrations/langgraph`](https://github.com/cortadel/cortadel/tree/main/integrations/langgraph) |
| **Microsoft Agent Framework** | `cortadel-agent-framework` | Python | A `ContextProvider` (`before_run` / `after_run`) plus native `FunctionTool`s | [`integrations/microsoft-agent-framework`](https://github.com/cortadel/cortadel/tree/main/integrations/microsoft-agent-framework) |
| **OpenAI Agents SDK** | `cortadel-openai-agents` | Python | A `Session` implementation, recall via `call_model_input_filter`, and function tools | [`integrations/openai-agents`](https://github.com/cortadel/cortadel/tree/main/integrations/openai-agents) |
| **Pydantic AI** | `cortadel-pydantic-ai` | Python | An `AbstractCapability` that recalls, persists, and contributes a memory toolset | [`integrations/pydantic-ai`](https://github.com/cortadel/cortadel/tree/main/integrations/pydantic-ai) |
| **Mastra** | `@cortadel/mastra` | TypeScript | A `Processor` that recalls and persists, plus `createTool` memory tools | [`integrations/mastra`](https://github.com/cortadel/cortadel/tree/main/integrations/mastra) |
| **n8n** | `n8n-nodes-cortadel` | TypeScript | A Cortadel Memory sub-node for the AI Agent's `ai_memory` port, and a six-operation action node | [`integrations/n8n-nodes-cortadel`](https://github.com/cortadel/cortadel/tree/main/integrations/n8n-nodes-cortadel) |
| **OpenClaw** | `@cortadel/openclaw` | TypeScript | A memory corpus supplement, two agent tools, and recall/capture hooks | [`integrations/openclaw`](https://github.com/cortadel/cortadel/tree/main/integrations/openclaw) |
| **Vercel AI SDK** | `@cortadel/vercel-ai-provider` | TypeScript | A `LanguageModelMiddleware` that recalls and persists, plus AI SDK tools | [`integrations/vercel-ai-sdk`](https://github.com/cortadel/cortadel/tree/main/integrations/vercel-ai-sdk) |

Every package is Apache-2.0 and built on the published Cortadel SDK for its language —
[`cortadel`](https://pypi.org/project/cortadel/) on PyPI, or
[`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk) on npm.

## Common configuration

Whatever the framework's naming convention, every integration is configured with the same four
Cortadel values (`snake_case` in Python, `camelCase` in TypeScript; on n8n they are split between
the credential and the node):

| Setting | Meaning |
|---|---|
| `base_url` / `baseUrl` | Your Cortadel origin — `https://app.cortadel.ai` hosted, or `http://localhost:3001` self-hosted. |
| `user_id` / `userId` | The memory namespace. Every SDK call is scoped to it, so per-user memory means a client per user id — integrations that serve many tenants resolve the id per run and pool clients for you. |
| `api_key` / `apiKey` | The bearer token (see [Authentication](authentication.md)). Omit it when the server runs with auth disabled. |
| `app_name` / `appName` | The label recorded on writes and in access logs. Defaults to the integration's own published package name (`cortadel-langgraph`, `cortadel-google-adk`, …; the npm-scoped ones drop the scope, so `@cortadel/mastra` records `cortadel-mastra` and `@cortadel/vercel-ai-provider` records `cortadel-vercel-ai-provider`). The n8n nodes fix theirs to `n8n-nodes-cortadel` rather than exposing it. |

### The shared vocabulary

Beyond those four, five more knobs mean the same thing in every package that has the concept, and
are spelled the same way. The **names** are fixed repo-wide; a package may ship a different
**default** where its framework forces one, and its README says why.

| Setting | Meaning | Default |
|---|---|---|
| `raise_on_error` / `throwOnError` | Propagate a Cortadel failure to the caller instead of degrading to "this turn has no memory". | `False` / `false` — fail open |
| `on_error` / `onError` | A **callback**, handed the exception when a Cortadel call fails. Never a mode string, never a bool. Set none and a swallowed failure is logged as a warning instead. | unset |
| `top_k` / `topK` | How many memories to retrieve. | `5` for automatic per-turn injection; `10` for an explicit `search_memory` tool, matching the SDK's own `SearchOptions` default |
| `await_persist` / `awaitPersist` | Wait for the write to land before the turn returns. | `false` where a detached write is safe — `true` in frameworks that end the run (and often the process) the moment the last hook returns, which would silently drop the memory |
| `scope_recall_to_session` / `scopeRecallToSession` | Recall only what was stored under this session, instead of everything Cortadel knows about the user. | `False` / `false` |

Not every package exposes all five, and that is deliberate rather than an omission: a package whose
writes are always blocking has no `await_persist` to offer, and the two configured entirely through
JSON — n8n and OpenClaw — cannot accept a callback at all, so they fail open unconditionally and
warn through their host's own logger. OpenClaw's scope knob is a four-value enum (`recallScope`:
`fixed`, `agent`, `session`, `sender`) rather than a boolean, because it genuinely has four scopes.

Everything else — rerank, memory type, tags, dedupe windows, timeouts — is per-package and
documented in that package's README.

> **Memory failures degrade, they don't escalate.** Every integration treats an unreachable or slow
> Cortadel server as "this turn has no memory", never as a failed agent run. Escalating is opt-in
> and uniformly named: `raise_on_error` / `throwOnError`, off everywhere by default. The one failure
> that is *not* deferred is the Claude Agent SDK package's construction-time validation of
> `base_url` / `user_id` — with everything else failing open, a typo there would otherwise mean
> silently dead memory.

## Python packages

### Claude Agent SDK

```bash
pip install cortadel-claude-agent-sdk
```

Gives a programmatic Claude agent long-term memory through both of the SDK's native seams: an
in-process MCP server exposing `mcp__cortadel__search_memory` and `mcp__cortadel__add_memories`,
plus `UserPromptSubmit` / `Stop` hooks that recall relevant memories into the turn and persist the
finished exchange without the agent asking. One line wires it up — `memory.apply(options)` merges
the server, the tool names and both hooks into your `ClaudeAgentOptions`. For *interactive* Claude
Code, use the [`cortadel-memory` plugin](plugin.md) instead; this package is for agents you build in
Python.

**Limits.** The Python SDK's `HookEvent` union has no `SessionStart`, so memory can't be primed at
session start the way the plugin does. The `Stop` hook awaits its capture by default
(`await_persist=True`), so the end of a session waits on Cortadel — `await_persist=False` takes it
off the critical path, but then `aclose()` is what drains the write, and a backgrounded failure can
only be observed through `on_error`, never raised. `scope_recall_to_session` applies to the hook
only: a tool handler here is handed its arguments and no session id, so the `search_memory` tool
cannot be session-scoped. A client is bound to one user id at construction, so multi-user apps build
one `CortadelMemory` per user — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/claude-agent-sdk).

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

### DeepAgents

```bash
pip install cortadel-deepagents
```

`CortadelMemoryMiddleware` is an `AgentMiddleware` you drop into
`create_deep_agent(middleware=[...])`. It hybrid-searches Cortadel once per turn and injects the
hits into the system prompt, then persists the turn with `add_conversation` when it ends — so an
agent remembers across threads, processes and deployments without you writing a retrieval step. It
also registers native `search_memory` / `add_memories` tools and resolves the Cortadel user per run
from LangGraph's `runtime.context`, for multi-tenant agents.

**Limits.** Python ≥ 3.11 (DeepAgents' own floor). It deliberately does *not* implement a
`BackendProtocol` filesystem backend: Cortadel has no in-place update — edits are bi-temporal
supersessions that mint a new id — so `edit_file` could not honour its own contract. Don't stack
this with `cortadel-langgraph`'s memory nodes; both recall and persist, and you would pay for each
twice. Persistence always awaits and there is no `await_persist` knob: `after_agent` is the last node
of a run, and the middleware only advances its persisted-turn cursor on a confirmed write — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/deepagents).

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

### LangGraph

```bash
pip install cortadel-langgraph
```

Implements LangGraph's own `BaseStore`, so Cortadel drops into anything that already takes a store:
`compile(store=…)`, `create_react_agent(store=…)`, `get_store()`, `InjectedStore`. It adds
`search_memory` and `add_memories` as LangChain tools the agent can call itself, plus
`CortadelMemory` — a pair of graph nodes that recall relevant memories before each model call and
hand the finished turn to Cortadel's fact-extraction pipeline afterwards, with no tool call
required. Namespaces are templated (`("memories", "{user_id}")`), so one store serves every user of
a multi-tenant graph.

**Limits.** `put()` cannot honour a caller-chosen key — Cortadel mints its own memory ids, so a
caller key is bridged through a process-local alias table that does not survive a restart, and the
store's real key space is Cortadel ids. `list_namespaces()` reports only the namespaces the current
process has touched. Search filters beyond `memory_type` / `session_id` are applied client-side, and
Mongo-style operator filters are unsupported. Calls into the store keep LangGraph's own `limit=`
keyword rather than `top_k` — `BaseStore.search()` and `SearchOp.limit` are the framework's
signature, not this package's, so only the surface this package owns (`CortadelMemory`, the tool
factories) uses the canonical name. There is no `scope_recall_to_session`:
`session_from_thread` records the LangGraph thread id on the *write*, it does not narrow recall. Nor
is there an `await_persist` — the recall/persist nodes await, since LangGraph is free to close the
loop once the run ends — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/langgraph).

### Microsoft Agent Framework

```bash
pip install cortadel-agent-framework
```

`CortadelContextProvider` is a real `agent_framework.ContextProvider`: its `before_run` hook
hybrid-searches your memory and injects the hits before every model call, and its `after_run` hook
hands the finished turn to Cortadel's conversation pipeline — no agent cooperation needed.
`cortadel_memory_tools()` additionally exposes `search_memory` and `add_memories` as native
`FunctionTool`s for when you want the agent to go looking on its own.

**Limits.** The framework's Python flavour only — its .NET flavour has no Cortadel package yet. The
`agent-framework-core >= 1.13.0` floor is conservative by at least one minor: it is the version the
suite actually runs against, not a tested compatibility boundary. Streaming runs (`stream=True`) are
covered by source reading, not by a test. `await_persist` defaults to `True`: a `ContextProvider`
gets no shutdown hook, and the idiomatic `async with provider: await agent.run(...)` exits right
after `after_run`, so a detached write would routinely lose the turn it carries — set it to `False`
and `aclose()` / `__aexit__` drains, but that write can then only be reported through `on_error` —
see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/microsoft-agent-framework).

### OpenAI Agents SDK

```bash
pip install cortadel-openai-agents
```

`CortadelSession` implements the SDK's `Session` protocol, keeping verbatim history in a transcript
session while distilling each finished turn into long-term memory, and its `run_config()` installs a
`call_model_input_filter` that recalls relevant memories into every model call automatically. For
agents that should decide when to remember, `cortadel_memory_tools()` returns `search_memory` and
`add_memories` as ordinary `FunctionTool`s.

**Limits.** Two wiring points, not one: recall lives on `RunConfig` and storage on `Session`, so you
need `Runner.run(..., session=s, run_config=s.run_config())` — passing only `session=` silently
gives storage without recall. Cortadel is not the transcript (it deduplicates and does not preserve
item order), so `CortadelSession` wraps a transcript `Session`, in-memory SQLite by default. Sessions
are mutually exclusive with `conversation_id` / `previous_response_id` at the SDK level; use
tools-only mode there. `await_persist` defaults to `True` because the runner awaits `add_items` as
the last thing before `Runner.run()` returns, which is very often the last thing the process does;
`False` needs `flush()`, `aclose()` or `async with` to drain, and a backgrounded write can only be
observed, never raised. `cortadel_memory_tools()` defaults to `top_k=10`, but tools built from
`CortadelSession.tools()` inherit the session's `top_k` (5) so an explicit search and an automatic
recall can't disagree in the same turn — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/openai-agents).

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

## TypeScript packages

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
JSON values set in a UI, so there is no `on_error` callback and no `throwOnError`: memory failures
always degrade, and are warned through n8n's own logger. The action node's operations keep n8n's
`search` / `addConversation` naming rather than the canonical tool stems, because n8n derives an
agent-facing tool name from the node's workflow name and gives operations no naming hook — see the
[package README](https://github.com/cortadel/cortadel/tree/main/integrations/n8n-nodes-cortadel).

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

## Not seeing your framework?

Two options that need no integration package at all:

- **[MCP](mcp.md)** — any MCP-capable client or agent framework can read and write memory over the
  Streamable-HTTP endpoint with no glue code.
- **The SDKs** — [.NET](sdk-dotnet.md), [Python](sdk-python.md), and
  [TypeScript](sdk-typescript.md) are thin typed clients over the REST API; every integration above
  is built on one of them, in a few hundred lines.

## Building one

Integrations live in
[`integrations/`](https://github.com/cortadel/cortadel/tree/main/integrations), one directory per
publishable package. That folder's
[README](https://github.com/cortadel/cortadel/tree/main/integrations#readme) is the contributor
guide: how a package is laid out, how to build and test one, and what a new integration has to
include before it can be merged. Start there, and read
[CONTRIBUTING.md](https://github.com/cortadel/cortadel/blob/main/CONTRIBUTING.md) for the general
workflow.

## Next steps

- [Getting started](getting-started.md) — run a server and store your first memory.
- [Authentication](authentication.md) — mint the API key your integration will need.
- [MCP integration](mcp.md) — the no-code path for any MCP-capable client.
- [Claude Code & Codex plugin](plugin.md) — ambient memory for interactive Claude Code sessions.
