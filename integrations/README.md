# Cortadel integrations

First-party packages that make [Cortadel](https://github.com/cortadel/cortadel) — self-hosted
long-term temporal graph memory for AI agents — feel **native** inside a host agent framework.

Each subdirectory here is a **standalone, publishable package**: its own manifest, its own lockfile,
its own tests, released under its own name to PyPI or npm. Nothing in this folder is a workspace
member, and no package imports another. They all build on the published Cortadel SDK for their
language ([`cortadel`](https://pypi.org/project/cortadel/) on PyPI,
[`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk) on npm) exactly the way a third-party
package would.

The user-facing version of this page — install commands, what each one does, and its known limits —
is [`docs/integrations.md`](../docs/integrations.md). This page is for people **writing** one.

## What's here

| Framework | Package | Language | What you get | Folder |
|---|---|---|---|---|
| **Claude Agent SDK** | `cortadel-claude-agent-sdk` | Python | Memory tools via an in-process MCP server, plus `UserPromptSubmit` / `Stop` hooks | [`claude-agent-sdk/`](./claude-agent-sdk) |
| **CrewAI** | `cortadel-crewai` | Python | A drop-in `crewai.Memory`, native crew tools, and a task-completed listener | [`crewai/`](./crewai) |
| **DeepAgents** | `cortadel-deepagents` | Python | An `AgentMiddleware` that recalls and persists, plus native tools | [`deepagents/`](./deepagents) |
| **Google ADK** | `cortadel-google-adk` | Python | A `BaseMemoryService` (so ADK's own `load_memory` / `preload_memory` work), an auto-persist plugin, and tools | [`google-adk/`](./google-adk) |
| **LangGraph** | `cortadel-langgraph` | Python | A `BaseStore` implementation, memory tools, and recall/persist graph nodes | [`langgraph/`](./langgraph) |
| **Microsoft Agent Framework** | `cortadel-agent-framework` | Python | A `ContextProvider` (`before_run` / `after_run`) plus native `FunctionTool`s | [`microsoft-agent-framework/`](./microsoft-agent-framework) |
| **OpenAI Agents SDK** | `cortadel-openai-agents` | Python | A `Session` implementation, recall via `call_model_input_filter`, and function tools | [`openai-agents/`](./openai-agents) |
| **Pydantic AI** | `cortadel-pydantic-ai` | Python | An `AbstractCapability` that recalls, persists, and contributes a memory toolset | [`pydantic-ai/`](./pydantic-ai) |
| **Mastra** | `@cortadel/mastra` | TypeScript | A `Processor` that recalls and persists, plus `createTool` memory tools | [`mastra/`](./mastra) |
| **n8n** | `n8n-nodes-cortadel` | TypeScript | A Cortadel Memory sub-node for the AI Agent's `ai_memory` port, and a six-operation action node | [`n8n-nodes-cortadel/`](./n8n-nodes-cortadel) |
| **OpenClaw** | `@cortadel/openclaw` | TypeScript | A memory corpus supplement, two agent tools, and recall/capture hooks | [`openclaw/`](./openclaw) |
| **Vercel AI SDK** | `@cortadel/vercel-ai-provider` | TypeScript | A `LanguageModelMiddleware` that recalls and persists, plus AI SDK tools | [`vercel-ai-sdk/`](./vercel-ai-sdk) |

All twelve are at `0.1.0` and **not yet published** — the install commands in each README are the
ones that will work once they are.

## How a package is laid out

```
integrations/<slug>/
  .gitignore          # per-package, written first — see "Traps" below
  README.md           # the package's own docs (sections listed further down)
  LICENSE             # Apache-2.0, copied verbatim from the repo-root LICENSE
  pyproject.toml      # Python (hatchling) …
  package.json        # … or TypeScript (ESM-only, `exports` map, tsc build)
  uv.lock | pnpm-lock.yaml   # committed
  cortadel_<framework>/ | src/    # the integration itself
  tests/ | test/                  # offline unit tests
  examples/                       # at least one runnable, commented end-to-end script
```

Match the closest existing in-repo package for style: Python → [`sdk/python/`](../sdk/python)
(hatchling, `from __future__ import annotations`, fully typed, `py.typed`); TypeScript →
[`sdk/typescript/`](../sdk/typescript) (`"type": "module"`, single entry point in the `exports` map,
`tsc` build, `vitest`).

Manifest conventions, all twelve packages: version `0.1.0`, license `Apache-2.0`, homepage
`https://cortadel.ai`, repository `https://github.com/cortadel/cortadel` with the package
subdirectory recorded (npm's `repository.directory`; PEP 621 has no equivalent, so Python packages
carry a `Source` URL instead), issues `https://github.com/cortadel/cortadel/issues`. Python import
paths are `cortadel_<framework>` with underscores. The **host framework is a real dependency with a
floor version** — or a peer dependency where that is the framework's own convention, as it is for
n8n community nodes and AI SDK providers.

## Building and testing one

Each package is self-contained; there is no root workspace, so `cd` into the one you're changing.

```bash
# Python (uv-managed, like sdk/python/)
cd integrations/langgraph
uv sync --extra test
uv run pytest -q

# TypeScript (pnpm, like sdk/typescript/)
cd integrations/mastra
pnpm install
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm run build
```

Notes that will save you time:

- **Interpreter and runtime floors differ, legitimately** — each package's floor is the one its host
  framework (and its own lockfile) can actually resolve, so they are expected to vary and are *not*
  something to unify. Most Python packages declare `>=3.10`; `cortadel-deepagents` requires `>=3.11`
  because DeepAgents does, and `cortadel-crewai` declares `>=3.11,<3.14` — one rung above crewai's
  own floor, because a transitive dependency publishes no 3.10 wheel and no sdist to build from.
  Node floors vary the same way (`>=20` for the n8n nodes, `>=22` upward for the rest). `uv` and
  `pnpm` fetch whatever the manifest asks for — do that rather than lowering a floor to suit the box
  you're on.
- **pnpm has no workspace root here.** A bare `pnpm install` inside a package works; pass
  `--ignore-workspace` if pnpm's search up the tree annoys you.
- **Every suite is offline** — no network, no Cortadel server, no LLM or API keys, no `CORTADEL_*`
  environment variables. If a suite needs any of those to pass, it is wrong.
- Exact commands, expected counts and per-package caveats live in each package's own
  **Running the tests** section.

## What a new integration must include

**Two capabilities**, wherever the host framework supports both:

1. **Memory tools** — at minimum `search_memory` and `add_memories`, built with the framework's own
   tool primitive (`@tool`, `FunctionTool`, `StructuredTool`, a `BaseTool` subclass, `createTool`,
   an n8n node operation, …) — never a raw HTTP call the user has to wire up.
2. **Automatic memory** — the framework's own extension point, which *without the agent asking*
   (a) searches Cortadel before the model call and injects the hits at that framework's idiomatic
   injection point, and (b) hands the finished turn to `add_conversation` afterwards.

If the framework has a first-class memory abstraction — a `BaseStore`, `Memory`, `Session`,
`BaseMemoryService`, `ContextProvider` — **implement that interface**. It is always more idiomatic
than a bolt-on callback and is the single most important design decision to get right; research it
from primary sources (the framework's actual source, not its blog posts) before writing code. If a
framework genuinely supports only one of the two capabilities, ship that one and say why in the
README.

**A README** with these sections: `# Cortadel × <Framework>` · one paragraph of what-and-why ·
**Install** (the real command with the real package name) · **Quickstart** (a complete,
copy-pasteable snippet that would actually run) · **What you get** (the tools and/or the hook, named)
· **Configuration** (a table of option / type / default / meaning, including `base_url`, `user_id`,
`api_key`, `app_name`) · **Running the tests** · **Requirements** (framework floor, runtime floor,
and that it needs a running Cortadel server — hosted `https://app.cortadel.ai` or self-hosted
`docker compose up` → `http://localhost:3001`). Write for a developer who has never heard of
Cortadel; one sentence of positioning is enough.

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

Python uses `snake_case`, TypeScript `camelCase`. Where a row gives both, each is canonical for its
language.

| Concept | Canonical name | Type | Canonical default |
|---|---|---|---|
| Propagate a Cortadel failure to the caller instead of degrading | `raise_on_error` / `throwOnError` | `bool` | `False` / `false` — **fail open** |
| Observe a failure | `on_error` / `onError` | **callback** taking the exception | unset |
| How many memories to retrieve | `top_k` / `topK` | `int` | `5` for automatic injection; `10` for an explicit `search_memory` tool |
| Wait for the write before the turn returns | `await_persist` / `awaitPersist` | `bool` | `False` / `false` — fire-and-forget |
| Recall only from the current session/thread | `scope_recall_to_session` / `scopeRecallToSession` | `bool` | `False` / `false` |
| …when there are genuinely more than two scopes | `recall_scope` / `recallScope` | enum | document every value |
| Model-facing tool names | `search_memory`, `add_memories` | — | plural on add, matching Cortadel's own MCP surface |
| Label recorded on writes and in access logs | `app_name` / `appName` | `str` | the integration's **own published package name**, verbatim (`cortadel-langgraph`, `@cortadel/mastra` → `cortadel-mastra`) |

Rules that come with the table:

- **`on_error` is always a callback.** Never a mode string (`"warn"` / `"raise"` / `"ignore"`), never
  a bool. `raise_on_error` decides control flow; `on_error` only observes. When a failure is
  swallowed and no callback is set, log a warning through the language's standard mechanism
  (`logging.getLogger(__name__).warning`, `console.warn`, or the host framework's own logger).
- **Fail open is non-negotiable as the default.** A memory outage must never take an agent run down.
- **Where the host framework mandates a tool prefix, keep the stem**: OpenClaw requires
  `cortadel_search_memory` / `cortadel_add_memories`, not a new name.
- **A package may deviate on a *default*; it may never deviate on a *name*.** If your framework makes
  a different default genuinely necessary — a lifecycle that kills a detached write, a host that
  passes the count itself — keep it, and say so in one sentence in your README next to the option.
  That sentence is the price of the deviation. Renaming an option because it reads better in your
  package is what this table exists to prevent.
- **Not every package has every concept, and inventing one is worse than omitting it.** A package
  whose writes are always blocking has no `await_persist` to expose (a flag whose only safe value is
  `True` is a lie); a package configured through JSON — n8n, OpenClaw — cannot accept a callback at
  all. Document the absence and why, rather than shipping a dead knob.
- **A name the host framework owns stays the host's.** LangGraph's `BaseStore.search(limit=)` and
  CrewAI's `Memory.recall(limit=)` keep `limit`, because renaming a parameter the framework calls by
  keyword breaks the integration outright. Canonical names govern the surface *this repo* defines.
- **Runtime floors are the exception that proves the rule: they legitimately vary per framework.**
  Each package's Python/Node floor is whatever its host framework and lockfile can actually resolve,
  so do not unify them — unify names, not versions.

Test and example ids are `e2e-`-prefixed everywhere, including throwaway ids inside assertions, and
no source file may contain a literal NUL byte (write the six characters `\u0000` instead — a real NUL
makes the file binary to git: no diff in the PR, invisible to `git grep`).

## Traps

- **The Cortadel SDK surface is fixed and small**: `add`, `add_conversation`, `search`, `list`,
  `get`, `delete`, `health` (Python also ships a blocking `SyncCortadelClient` — most Python
  frameworks need it). There is no `update` and no upsert-by-key: edits are bi-temporal
  supersessions that mint a new id. Never invent a method to make a framework concept fit.
- **Scoping is per client, not per call.** `CortadelClient(base_url, user_id, api_key=…,
  app_name=…)` binds one user id for its lifetime, so "per-user memory" means **one client per user
  id** — pool them, and close them. Set `app_name` to the integration's own package name; it is
  recorded for access logging.
- **Write `.gitignore` before you run any install.** Without it `node_modules/` and `.venv/` land in
  `git status --untracked-files=all`, which this repo's CI treats as drift. Copy
  [`sdk/python/.gitignore`](../sdk/python/.gitignore) or
  [`sdk/typescript/.gitignore`](../sdk/typescript/.gitignore).
- **Test and example identities use the `e2e-*` prefix** (e.g. `e2e-langgraph-integration`) — the
  repo-wide convention marking data as disposable. Never a real name, and never a key in any file.
- **Don't stack two integrations that both auto-recall.** `cortadel-deepagents` and
  `cortadel-langgraph` overlap by design (DeepAgents is built on LangGraph); pick one.

## See also

- [`docs/integrations.md`](../docs/integrations.md) — the user-facing page these packages appear on.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — PR workflow, commit conventions, CI.
- [`AGENTS.md`](../AGENTS.md) — repository layout and the rules for AI coding agents working here.
- [`sdk/python/`](../sdk/python), [`sdk/typescript/`](../sdk/typescript) — the clients every package
  here is built on, and the style to match.
