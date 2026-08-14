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

**This page is the index.** Every framework in the table below has its own page — install command,
a quickstart you can run, the full configuration table, how it works, and that package's honest
limits. Pick yours and click through; what stays here is only what is true of all twelve.

:::note
**Status — published at `0.1.0`.** Every package below went live on its registry on 2026-08-14
(npm ×8, PyPI ×3, NuGet ×1) and its source lives in
[`integrations/`](https://github.com/cortadel/cortadel/tree/main/integrations) — the install
commands work as written, and every npm package carries a Sigstore provenance attestation. Each
package ships an offline test suite that drives the real host framework (fake model, stubbed
Cortadel client); none is exercised against a live Cortadel server in CI, so wire-level behaviour
rests on the [SDKs](/sdk-python/) and their own conformance suites.
:::

## The integrations

| Framework | Package | Language | What you get |
|---|---|---|---|
| **[Claude Agent SDK](/integrations/claude-agent-sdk/)** | `@cortadel/claude-agent-sdk` | TypeScript | Memory tools on an in-process MCP server (`createSdkMcpServer`), plus `UserPromptSubmit` / `Stop` hooks that recall and capture without the agent asking. |
| **[DeepAgents](/integrations/deepagents/)** | `@cortadel/deepagents` | TypeScript | An `AgentMiddleware` that recalls before the turn and persists after it, plus native `search_memory` / `add_memories` tools. |
| **[LangGraph](/integrations/langgraph/)** | `@cortadel/langgraph` | TypeScript | A `BaseStore` implementation, `search_memory` / `add_memories` tools, and recall/persist nodes that plug in as `createReactAgent`'s `preModelHook` / `postModelHook`. |
| **[Mastra](/integrations/mastra/)** | `@cortadel/mastra` | TypeScript | A `Processor` that recalls memories into the system prompt before every model call and persists the finished turn afterwards, plus `search_memory` / `add_memories` `createTool` tools, with per-user clients pooled automatically. |
| **[n8n](/integrations/n8n-nodes-cortadel/)** | `n8n-nodes-cortadel` | TypeScript | A Cortadel Memory sub-node for the n8n AI Agent's `ai_memory` port that recalls and persists on every turn, plus a six-operation Cortadel action node that doubles as an agent tool. |
| **[OpenAI Agents SDK](/integrations/openai-agents/)** | `@cortadel/openai-agents` | TypeScript | A `Session` implementation, automatic recall via `callModelInputFilter`, and `search_memory` / `add_memories` function tools. |
| **[OpenClaw](/integrations/openclaw/)** | `@cortadel/openclaw` | TypeScript | An additive memory corpus behind OpenClaw's own `memory_search` / `memory_get`, two agent tools, and optional recall/capture hooks around every turn. |
| **[Vercel AI SDK](/integrations/vercel-ai-sdk/)** | `@cortadel/vercel-ai-provider` | TypeScript | A `LanguageModelMiddleware` for `wrapLanguageModel` that recalls before every model call and persists each finished turn, plus `search_memory` and `add_memories` as native AI SDK tools. |
| **[CrewAI](/integrations/crewai/)** | `cortadel-crewai` | Python | A drop-in `crewai.Memory` for CrewAI 1.10+ unified memory, `search_memory` / `add_memories` as native crew tools, and a `TaskCompletedEvent` listener that distils each finished task via `add_conversation`. |
| **[Google ADK](/integrations/google-adk/)** | `cortadel-google-adk` | Python | A `BaseMemoryService` implementation (so ADK's own `load_memory` / `preload_memory` work), an auto-persist `BasePlugin`, and model-callable `search_memory` / `add_memories` tools. |
| **[Pydantic AI](/integrations/pydantic-ai/)** | `cortadel-pydantic-ai` | Python | An `AbstractCapability` that contributes `search_memory` / `add_memories` as a `FunctionToolset`, recalls memories into the prompt once per run via `get_instructions()`, and persists the turn in `after_run()`. |
| **[Microsoft Agent Framework](/integrations/microsoft-agent-framework/)** | `Cortadel.AgentFramework` | .NET | An `AIContextProvider` that recalls before every model call and persists after every turn, plus `search_memory` / `add_memories` as native `AIFunction` tools. |

Every package is Apache-2.0 and built on the published Cortadel SDK for its language —
[`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk) on npm,
[`cortadel`](https://pypi.org/project/cortadel/) on PyPI, or
[`Cortadel.Sdk`](https://www.nuget.org/packages/Cortadel.Sdk) on NuGet. Each page above ends with a
link to that package's registry listing and to its source under
[`integrations/`](https://github.com/cortadel/cortadel/tree/main/integrations), one directory per
package.

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

## Common configuration

Whatever the framework's naming convention, every integration is configured with the same four
Cortadel values (`camelCase` in TypeScript, `snake_case` in Python, `PascalCase` in .NET; on n8n
they are split between the credential and the node):

| Setting | Meaning |
|---|---|
| `baseUrl` / `base_url` / `BaseUrl` | Your Cortadel origin — `https://app.cortadel.ai` hosted, or `http://localhost:3001` self-hosted. |
| `userId` / `user_id` / `UserId` | The memory namespace. Every SDK call is scoped to it, so per-user memory means a client per user id — integrations that serve many tenants resolve the id per run and pool clients for you. |
| `apiKey` / `api_key` / `ApiKey` | The bearer token (see [Authentication](/authentication/)). Omit it when the server runs with auth disabled. |
| `appName` / `app_name` / `AppName` | The label recorded on searches and, where the API accepts one, on writes. Defaults to the integration's own published package name: `@cortadel/langgraph`, `@cortadel/deepagents` and `@cortadel/claude-agent-sdk` record the scoped npm name verbatim, `@cortadel/mastra`, `@cortadel/openai-agents`, `@cortadel/openclaw` and `@cortadel/vercel-ai-provider` record the de-scoped form (`cortadel-mastra`, …), the Python packages record `cortadel-crewai` / `cortadel-google-adk` / `cortadel-pydantic-ai`, and the .NET package records `Cortadel.AgentFramework`. The n8n nodes fix theirs to `n8n-nodes-cortadel` rather than exposing it. Cortadel's conversation API has no app field, so facts distilled from an automatically captured turn carry no app label — each package's page says exactly where its own name does and does not land. |

### The shared vocabulary

Beyond those four, five more knobs mean the same thing in every package that has the concept, and
are spelled the same way. The **names** are fixed repo-wide; a package may ship a different
**default** where its framework forces one, and its page says why. TypeScript uses `camelCase`
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
Which of the five a package exposes, what it defaults to, and what each one actually reaches —
`scopeRecallToSession`, in several packages, gates automatic recall but not the `search_memory`
tool — is on that package's own page.

Everything else — rerank, memory type, tags, dedupe windows, timeouts — is per-package and
documented on that package's page.

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

## Don't stack two auto-recall integrations

`@cortadel/deepagents` and `@cortadel/langgraph` overlap by design — DeepAgents is built on
LangGraph — so running both automatic paths in one agent recalls and persists each turn twice, at
twice the latency and twice the token cost. Pick one. Their *other* halves compose fine: the
DeepAgents middleware never touches `runtime.store`, so a `CortadelStore` and the middleware can
coexist.

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
guide: how a package is laid out, how to build and test one in each of the three toolchains, the
canonical option names above, and what a new integration has to include before it can be merged.
Start there, and read
[CONTRIBUTING.md](https://github.com/cortadel/cortadel/blob/main/CONTRIBUTING.md) for the general
workflow.

## Next steps

- [Getting started](/getting-started/) — run a server and store your first memory.
- [Authentication](/authentication/) — mint the API key your integration will need.
- [MCP integration](/mcp/) — the no-code path for any MCP-capable client.
- [Claude Code & Codex plugin](/plugin/) — ambient memory for interactive Claude Code sessions.
