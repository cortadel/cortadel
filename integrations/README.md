# Cortadel integrations

First-party packages that make [Cortadel](https://github.com/cortadel/cortadel) — self-hosted
long-term temporal graph memory for AI agents — feel **native** inside a host agent framework.

Each subdirectory here is a **standalone, publishable package**: its own manifest, its own lockfile
or solution, its own tests, released under its own name to npm, PyPI or NuGet. Nothing in this
folder is a workspace member, and no package imports another. They all build on the published
Cortadel SDK for their language ([`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk) on
npm, [`cortadel`](https://pypi.org/project/cortadel/) on PyPI,
[`Cortadel.Sdk`](https://www.nuget.org/packages/Cortadel.Sdk) on NuGet) exactly the way a
third-party package would.

The user-facing version of this page — install commands, what each one does, and its known limits —
is [`docs/integrations.md`](../docs/integrations.md). This page is for people **writing** one.

## Three languages: 8 TypeScript, 3 Python, 1 .NET

**The language of an integration is decided by what its host framework publishes, not by
preference.** The rule, in order:

1. **Does the framework ship a first-party TypeScript package?** Then the integration is
   TypeScript — even if the framework also ships Python. LangGraph, DeepAgents, the OpenAI Agents
   SDK and the Claude Agent SDK all publish both, and all four integrations are TypeScript, built
   against the framework's own npm types.
2. **Is the framework .NET-first?** Then the integration is .NET. That is the Microsoft Agent
   Framework, and only that.
3. **Otherwise, Python** — because the framework ships nothing else. CrewAI, Google ADK and Pydantic
   AI publish to PyPI only. (`@iqai/adk` on npm is a *third-party* port of Google ADK, not Google's;
   building on it would make our integration a dependant of someone else's reimplementation.)

That is the whole answer to "why is CrewAI Python but LangGraph TypeScript?" — LangChain publishes
`@langchain/langgraph` itself; CrewAI publishes nothing outside PyPI.

## What's here

| Framework | Package | Language | What you get | Folder |
|---|---|---|---|---|
| **Claude Agent SDK** | `@cortadel/claude-agent-sdk` | TypeScript | Memory tools via an in-process MCP server, plus `UserPromptSubmit` / `Stop` hooks | [`claude-agent-sdk/`](./claude-agent-sdk) |
| **DeepAgents** | `@cortadel/deepagents` | TypeScript | An `AgentMiddleware` that recalls and persists, plus native tools | [`deepagents/`](./deepagents) |
| **LangGraph** | `@cortadel/langgraph` | TypeScript | A `BaseStore` implementation, memory tools, and recall/persist graph nodes | [`langgraph/`](./langgraph) |
| **Mastra** | `@cortadel/mastra` | TypeScript | A `Processor` that recalls and persists, plus `createTool` memory tools | [`mastra/`](./mastra) |
| **n8n** | `n8n-nodes-cortadel` | TypeScript | A Cortadel Memory sub-node for the AI Agent's `ai_memory` port, and a six-operation action node | [`n8n-nodes-cortadel/`](./n8n-nodes-cortadel) |
| **OpenAI Agents SDK** | `@cortadel/openai-agents` | TypeScript | A `Session` implementation, recall via `callModelInputFilter`, and function tools | [`openai-agents/`](./openai-agents) |
| **OpenClaw** | `@cortadel/openclaw` | TypeScript | A memory corpus supplement, two agent tools, and recall/capture hooks | [`openclaw/`](./openclaw) |
| **Vercel AI SDK** | `@cortadel/vercel-ai-provider` | TypeScript | A `LanguageModelMiddleware` that recalls and persists, plus AI SDK tools | [`vercel-ai-sdk/`](./vercel-ai-sdk) |
| **CrewAI** | `cortadel-crewai` | Python | A drop-in `crewai.Memory`, native crew tools, and a task-completed listener | [`crewai/`](./crewai) |
| **Google ADK** | `cortadel-google-adk` | Python | A `BaseMemoryService` (so ADK's own `load_memory` / `preload_memory` work), an auto-persist plugin, and tools | [`google-adk/`](./google-adk) |
| **Pydantic AI** | `cortadel-pydantic-ai` | Python | An `AbstractCapability` that recalls, persists, and contributes a memory toolset | [`pydantic-ai/`](./pydantic-ai) |
| **Microsoft Agent Framework** | `Cortadel.AgentFramework` | .NET (`net8.0`) | An `AIContextProvider` (`ProvideAIContextAsync` / `StoreAIContextAsync`) plus native `AIFunction` tools | [`microsoft-agent-framework/`](./microsoft-agent-framework) |

All twelve are at `0.1.0` and **not yet published** — the install commands in each README are the
ones that will work once they are.

## How a package is laid out

```
integrations/<slug>/
  .gitignore          # per-package, written first — see "Traps" below
  README.md           # the package's own docs (sections listed further down)
  LICENSE             # Apache-2.0, copied verbatim from the repo-root LICENSE
  package.json        # TypeScript (ESM-only, `exports` map, tsc build) …
  pyproject.toml      # … or Python (hatchling) …
  <Name>.slnx         # … or .NET (a solution local to the folder, plus one .csproj per project)
  pnpm-lock.yaml | uv.lock   # committed (the .NET package has no lockfile — see below)
  src/ | cortadel_<framework>/ | <Name>/   # the integration itself
  test/ | tests/ | <Name>.Tests/           # offline unit tests
  examples/                                # at least one runnable, commented end-to-end script
```

Match the closest existing in-repo package for style: TypeScript →
[`sdk/typescript/`](../sdk/typescript) (`"type": "module"`, single entry point in the `exports` map,
`tsc` build, `vitest`); Python → [`sdk/python/`](../sdk/python) (hatchling,
`from __future__ import annotations`, fully typed, `py.typed`); .NET →
[`sdk/dotnet/`](../sdk/dotnet) (nullable enabled, XML docs generated, SourceLink under
`GITHUB_ACTIONS` only).

Manifest conventions, all twelve packages: version `0.1.0`, license `Apache-2.0`, homepage
`https://cortadel.ai`, repository `https://github.com/cortadel/cortadel` with the package
subdirectory recorded (npm's `repository.directory`; PEP 621 has no equivalent, so Python packages
carry a `Source` URL instead, and the .NET package carries `RepositoryUrl` +
`PublishRepositoryUrl`), issues `https://github.com/cortadel/cortadel/issues`. Python import paths
are `cortadel_<framework>` with underscores; the .NET `PackageId`, root namespace and folder name
all match (`Cortadel.AgentFramework`). The **host framework is a real dependency with a floor
version** — or a peer dependency where that is the framework's own convention, as it is for n8n
community nodes, AI SDK providers and the LangChain ecosystem.

## Building and testing one

Each package is self-contained; there is no root workspace and no root solution, so `cd` into the
one you're changing. Three toolchains:

```bash
# TypeScript (pnpm, like sdk/typescript/) — 8 packages
cd integrations/langgraph
pnpm install
pnpm test           # vitest run
pnpm run typecheck  # tsc --noEmit && tsc -p tsconfig.test.json  — NOT a bare tsc --noEmit
pnpm run build      # tsc -> dist/

# Python (uv-managed, like sdk/python/) — 3 packages
cd integrations/crewai
uv sync --extra test
uv run pytest -q

# .NET (like sdk/dotnet/) — 1 package
cd integrations/microsoft-agent-framework
dotnet test                       # restores + builds the whole .slnx, then runs xUnit (81 tests)
dotnet pack -c Release            # -> Cortadel.AgentFramework/bin/Release/*.nupkg (+ .snupkg)
```

Notes that will save you time:

- **`pnpm run typecheck`, never a bare `pnpm exec tsc --noEmit`.** Every TypeScript package's
  `typecheck` script chains a second pass over `tsconfig.test.json`, so `test/` (and, in some
  packages, `examples/`) is type-checked too. CI runs the script; the bare command covers `src/`
  only and will pass locally while the gate fails your PR.
- **`dotnet test` builds `examples/` as well.** `examples/BasicMemoryAgent` is a real project in
  `Cortadel.AgentFramework.slnx`, which is how the sample code in the README stays compilable. The
  test project sets `NoWarn=MAAI001` because `Microsoft.Agents.AI` marks the public constructors of
  `AIContextProvider.InvokingContext` / `.InvokedContext` experimental and the tests construct them;
  the library itself only ever *receives* them and needs no suppression.
- **The .NET package has no committed lockfile.** npm and PyPI packages commit `pnpm-lock.yaml` /
  `uv.lock`; NuGet's equivalent (`packages.lock.json`) is opt-in and this package does not enable
  it, matching `sdk/dotnet/`. Its dependency versions are pinned exactly in the `.csproj`
  (`Microsoft.Agents.AI` 1.17.0, `Cortadel.Sdk` 1.0.0) instead.
- **Interpreter and runtime floors differ, legitimately** — each package's floor is the one its host
  framework (and its own lockfile) can actually resolve, so they are expected to vary and are *not*
  something to unify. Node floors: `>=20` for `claude-agent-sdk`, `deepagents`, `langgraph`,
  `openai-agents` and the n8n nodes, `>=22` upward for `mastra`, `openclaw` and `vercel-ai-sdk`.
  Python floors: `>=3.10` for `cortadel-google-adk` and `cortadel-pydantic-ai`, `>=3.11,<3.14` for
  `cortadel-crewai` — one rung above crewai's own floor, because a transitive dependency publishes
  no 3.10 wheel and no sdist to build from. The .NET package targets `net8.0` (so it runs on .NET 8
  and later). `pnpm`, `uv` and `dotnet` fetch whatever the manifest asks for — do that rather than
  lowering a floor to suit the box you're on.
- **pnpm has no workspace root here.** A bare `pnpm install` inside a package works; pass
  `--ignore-workspace` if pnpm's search up the tree annoys you. The same is true of `dotnet`: build
  `microsoft-agent-framework/Cortadel.AgentFramework.slnx`, never the repo-root `Cortadel.slnx`,
  which does not include it.
- **Every suite is offline** — no network, no Cortadel server, no LLM or API keys, no `CORTADEL_*`
  environment variables. If a suite needs any of those to pass, it is wrong.
- Exact commands, expected counts and per-package caveats live in each package's own
  **Running the tests** section.

## What a new integration must include

**Two capabilities**, wherever the host framework supports both:

1. **Memory tools** — at minimum `search_memory` and `add_memories`, built with the framework's own
   tool primitive (`tool()`, `createTool`, `FunctionTool`, `AIFunctionFactory.Create`, a `BaseTool`
   subclass, an n8n node operation, …) — never a raw HTTP call the user has to wire up.
2. **Automatic memory** — the framework's own extension point, which *without the agent asking*
   (a) searches Cortadel before the model call and injects the hits at that framework's idiomatic
   injection point, and (b) hands the finished turn to `add_conversation` afterwards.

If the framework has a first-class memory abstraction — a `BaseStore`, `Session`,
`AIContextProvider`, `Memory`, `BaseMemoryService` — **implement that interface**. It is always more
idiomatic than a bolt-on callback and is the single most important design decision to get right;
research it from primary sources (the framework's actual source, not its blog posts) before writing
code. If a framework genuinely supports only one of the two capabilities, ship that one and say why
in the README.

**A README** with these sections: `# Cortadel × <Framework>` · one paragraph of what-and-why ·
**Install** (the real command with the real package name — `npm install`, `pip install` or
`dotnet add package`) · **Quickstart** (a complete, copy-pasteable snippet that would actually run) ·
**What you get** (the tools and/or the hook, named) · **Configuration** (a table of option / type /
default / meaning, including `baseUrl`, `userId`, `apiKey`, `appName` in that language's casing) ·
**Running the tests** · **Requirements** (framework floor, runtime floor, and that it needs a running
Cortadel server — hosted `https://app.cortadel.ai` or self-hosted `docker compose up` →
`http://localhost:3001`). Write for a developer who has never heard of Cortadel; one sentence of
positioning is enough.

**Tests that actually run**, offline, stubbed at the Cortadel client boundary (or the HTTP layer) —
never at the framework boundary, which is the half worth proving. Cover tool registration and schema
shape, the retrieve→inject path, the persist-after-turn path, user-id scoping, and error
propagation.

**Honest limits.** Every package here documents what it cannot do (see the "Limits" paragraphs in
[`docs/integrations.md`](../docs/integrations.md)). A framework concept with no Cortadel equivalent
gets written down, not papered over.

## Canonical option names

Twelve packages built in parallel produced up to five different names for the same knob, and
`on_error` meaning two incompatible things. The names below are **binding across every package**,
and a review pass exists to keep them that way. Use them even
where a different word reads better in isolation: someone who has learned one integration should be
able to configure the next one without re-reading its README.

TypeScript uses `camelCase`, Python `snake_case`, .NET `PascalCase`. Where a row gives more than one
spelling, each is canonical for its language — **it is one vocabulary in three casings, not three
vocabularies.** Exactly one row also changes its verb between languages; the first rule below says
which, and why that is deliberate.

| Concept | Canonical name | Type | Canonical default |
|---|---|---|---|
| Propagate a Cortadel failure to the caller instead of degrading | `throwOnError` / `raise_on_error` / `ThrowOnError` | `bool` | `false` / `False` — **fail open** |
| Observe a failure | `onError` / `on_error` / `OnError` | **callback** taking the exception | unset |
| How many memories to retrieve | `topK` / `top_k` / `TopK` | `int` | `5` for automatic injection; `10` for an explicit `search_memory` tool |
| Wait for the write before the turn returns | `awaitPersist` / `await_persist` / `AwaitPersist` | `bool` | `false` / `False` — fire-and-forget |
| Recall only from the current session/thread | `scopeRecallToSession` / `scope_recall_to_session` / `ScopeRecallToSession` | `bool` | `false` / `False` |
| …when there are genuinely more than two scopes | `recallScope` / `recall_scope` | enum | document every value |
| Model-facing tool names | `search_memory`, `add_memories` | — | plural on add, matching Cortadel's own MCP surface; `snake_case` in every language, because the *model* reads them |
| Label recorded on writes and in access logs | `appName` / `app_name` / `AppName` | `str` | the integration's **own published package name** (`@cortadel/langgraph`, `cortadel-crewai`, `Cortadel.AgentFramework`) |

Rules that come with the table:

- **The propagate flag is one concept with one stem per language family — settled, not an accident.**
  `throwOnError` in TypeScript, `raise_on_error` in Python, `ThrowOnError` in .NET: the stem follows
  the verb the language itself uses, because TypeScript and C# *throw* while Python *raises*, so the
  option reads like the code that reacts to it. The casing rule above still applies on top. This one
  was genuinely contested — `raiseOnError` and `RaiseOnError` shipped in three packages before the
  final review — and it is now closed in every package. Copy the stem for your language; do not
  reopen it, and do not read the split as drift left in by mistake.
- **`onError` is always a callback.** Never a mode string (`"warn"` / `"raise"` / `"ignore"`), never
  a bool. `throwOnError` decides control flow; `onError` only observes. When a failure is
  swallowed and no callback is set, log a warning through the language's standard mechanism
  (`console.warn`, `logging.getLogger(__name__).warning`, an injected `ILogger`, or the host
  framework's own logger).
- **Fail open is non-negotiable as the default.** A memory outage must never take an agent run down.
- **Tool names stay `snake_case` in every language**, including .NET — `search_memory`, not
  `SearchMemory`. The name is part of the model-facing contract, not the host language's API.
- **Where the host framework mandates a tool prefix, keep the stem**: OpenClaw requires
  `cortadel_search_memory` / `cortadel_add_memories`, not a new name.
- **A package may deviate on a *default*; it may never deviate on a *name*.** If your framework makes
  a different default genuinely necessary — a lifecycle that kills a detached write, a host that
  passes the count itself — keep it, and say so in one sentence in your README next to the option.
  That sentence is the price of the deviation. Renaming an option because it reads better in your
  package is what this table exists to prevent.
- **Not every package has every concept, and inventing one is worse than omitting it.** A package
  whose writes are always blocking has no `awaitPersist` to expose (a flag whose only safe value is
  `true` is a lie); a package configured through JSON — n8n, OpenClaw — cannot accept a callback at
  all. Document the absence and why, rather than shipping a dead knob.
- **A name the host framework owns stays the host's.** LangGraph's `BaseStore.search(limit=)` and
  CrewAI's `Memory.recall(limit=)` keep `limit`, because renaming a parameter the framework calls by
  keyword breaks the integration outright. Canonical names govern the surface *this repo* defines.
- **Runtime floors are the exception that proves the rule: they legitimately vary per framework.**
  Each package's Node/Python/.NET floor is whatever its host framework and lockfile can actually
  resolve, so do not unify them — unify names, not versions.

Test and example ids are `e2e-`-prefixed everywhere, including throwaway ids inside assertions, and
no source file may contain a literal NUL byte (write the six characters `\u0000` instead — a real NUL
makes the file binary to git: no diff in the PR, invisible to `git grep`).

## Traps

- **The Cortadel SDK surface is fixed and small**: `add`, `addConversation` / `add_conversation`,
  `search`, `list`, `get`, `delete`, `health` (Python also ships a blocking `SyncCortadelClient` —
  most Python frameworks need it). There is no `update` and no upsert-by-key: edits are bi-temporal
  supersessions that mint a new id. Never invent a method to make a framework concept fit.
- **Scoping is per client, not per call.** A Cortadel client binds one user id for its lifetime, so
  "per-user memory" means **one client per user id** — pool them, and close them. Set the app name
  to the integration's own package name; it is recorded for access logging.
- **Write `.gitignore` before you run any install or build.** Without it `node_modules/`, `.venv/`
  or `bin/` + `obj/` land in `git status --untracked-files=all`, which this repo's CI treats as
  drift. Copy [`sdk/typescript/.gitignore`](../sdk/typescript/.gitignore),
  [`sdk/python/.gitignore`](../sdk/python/.gitignore), or — for a .NET package —
  [`microsoft-agent-framework/.gitignore`](./microsoft-agent-framework/.gitignore), which also
  excludes `*.nupkg`, `*.snupkg` and `TestResults/`.
- **Test and example identities use the `e2e-*` prefix** (e.g. `e2e-langgraph-integration`) — the
  repo-wide convention marking data as disposable. Never a real name, and never a key in any file.
- **Don't stack two integrations that both auto-recall.** `@cortadel/deepagents` and
  `@cortadel/langgraph` overlap by design (DeepAgents is built on LangGraph); pick one auto-recall
  path. Their *other* halves compose fine — the middleware never touches `runtime.store`.
- **Peer dependencies in the LangChain ecosystem are load-bearing.** `@cortadel/langgraph` peers on
  `@langchain/langgraph-checkpoint` so the `BaseStore` it extends is the same class the host graph
  checks against; a duplicate hoisted copy would fail that identity check for reasons nothing in the
  error message would explain.

## See also

- [`docs/integrations.md`](../docs/integrations.md) — the user-facing page these packages appear on.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — PR workflow, commit conventions, CI.
- [`AGENTS.md`](../AGENTS.md) — repository layout and the rules for AI coding agents working here.
- [`sdk/typescript/`](../sdk/typescript), [`sdk/python/`](../sdk/python),
  [`sdk/dotnet/`](../sdk/dotnet) — the clients every package here is built on, and the style to
  match.
