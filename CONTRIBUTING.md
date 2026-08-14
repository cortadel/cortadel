# Contributing to Cortadel

Thanks for your interest in contributing! This repository is Cortadel's **open extension
surface** — the three published SDKs, the Claude Code/Codex plugin, the `cortadel` skill, and the
docs/website that describe them (all Apache-2.0). The Cortadel **server** (the memory engine +
dashboard container, `ghcr.io/cortadel/cortadel`) is closed-core and lives in a separate, private
repository — you cannot patch the engine here. If you've found a bug in the running server or the
hosted service, see [`SECURITY.md`](SECURITY.md) for vulnerabilities, or open an issue here
describing the observed behavior so it can be routed to the maintainers.

## Before you start

- Search [existing issues](https://github.com/cortadel/cortadel/issues) first.
- For anything beyond a small fix (typo, doc correction, a clearly-scoped bug), open an issue
  describing what you want to change before investing time in a PR — it saves rework if the
  approach needs discussion.
- There is no CLA to sign; a normal fork-and-PR workflow is all that's needed.

## Repository layout

See [`AGENTS.md`](AGENTS.md#repository-layout) for the full table. The short version: one
directory per published package under `sdk/` (`dotnet`, `typescript`, `python`), the plugin under
`cortadel-plugin/` (which also carries the `cortadel` skill), one standalone publishable framework
integration package per directory under `integrations/`, docs in `docs/` mirrored into `website/`,
the shared REST contract at `spec/openapi.json`, and the plugin/marketplace manifest generator
under `packaging/`.

## Generated code — read this before touching anything under `Generated/`, `generated/`, or `_generated/`

`spec/openapi.json` is synced from a private repo — **do not edit it here**. Each SDK's
`sdk/*/**/{Generated,generated,_generated}/` tree is generated from that contract by
[Kiota](https://github.com/microsoft/kiota); the plugin/marketplace manifests
(`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`,
`cortadel-plugin/.claude-plugin/plugin.json`, `cortadel-plugin/.codex-plugin/plugin.json`)
are generated from `packaging/plugin.metadata.json`. **Never hand-edit any of these** — CI
regenerates each one and fails the build on *any* resulting diff, including newly-created
untracked files (a schema addition emits a brand-new file, which a hand-edit-then-forget-to-run-
the-generator PR would otherwise miss). See [`AGENTS.md`](AGENTS.md#never-hand-edit-these--regenerate-instead)
for the exact regenerate command for each tree. If the generated output looks wrong, fix the
source (`spec/openapi.json` upstream, or `packaging/plugin.metadata.json` here) and regenerate —
don't patch the output.

## Building and testing each SDK

### .NET SDK (`sdk/dotnet/`)

Requires the .NET 10 SDK (the `.slnx` solution format needs it, even though the SDK itself
targets `net8.0`).

```bash
dotnet restore Cortadel.slnx
dotnet build Cortadel.slnx -c Release
dotnet test sdk/dotnet/Cortadel.Sdk.Tests -c Release --nologo
```

### TypeScript SDK (`sdk/typescript/`)

Requires `pnpm` (v10+) and Node ≥ 20 (the package's own `engines.node` floor).

```bash
cd sdk/typescript
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec vitest run "test/"
pnpm run build
```

### Python SDK (`sdk/python/`)

Requires [`uv`](https://docs.astral.sh/uv/) — `uv.lock` is committed.

```bash
cd sdk/python
uv sync --extra test
uv run pytest tests -q
```

### Framework integrations (`integrations/`)

Each directory under `integrations/` is a standalone, publishable package — its own manifest,
lockfile (or solution) and tests — built on the published `@cortadel/sdk` / `cortadel` /
`Cortadel.Sdk` package the way any third party would. There is no workspace root and no root
solution, so `cd` into the one you're changing.

**Twelve packages, three languages: 8 TypeScript, 3 Python, 1 .NET.** The language follows the host
framework — first-party TypeScript wherever the framework ships it (LangGraph, DeepAgents, the
OpenAI Agents SDK and the Claude Agent SDK ship both TS and Python, and all four integrations are
TS), Python for CrewAI / Google ADK / Pydantic AI because they publish nothing else, and .NET for
the Microsoft Agent Framework. `integrations/README.md` states the rule; don't switch a package's
language without it.

```bash
# TypeScript integrations (pnpm, like sdk/typescript/) — claude-agent-sdk, deepagents, langgraph,
# mastra, n8n-nodes-cortadel, openai-agents, openclaw, vercel-ai-sdk
cd integrations/langgraph
pnpm install
pnpm test            # vitest run
pnpm run typecheck   # not a bare `tsc --noEmit` — see below

# Python integrations (uv-managed, like sdk/python/) — crewai, google-adk, pydantic-ai
cd integrations/crewai
uv sync --extra test
uv run pytest -q

# The .NET integration (like sdk/dotnet/) — microsoft-agent-framework
cd integrations/microsoft-agent-framework
dotnet test            # builds the folder-local .slnx (examples/ included) and runs xUnit
dotnet pack -c Release # proves it still packs to a .nupkg
```

Use `pnpm run typecheck`, not `pnpm exec tsc --noEmit`, for the eight TypeScript packages. Each
one's `typecheck` script chains a second pass over `tsconfig.test.json` so the `test/` tree is
type-checked too. CI runs the full script; a bare `tsc --noEmit` covers only `src/`, so it can pass
locally while the gate that judges your PR fails on a type error in a test file. On the .NET side
build `integrations/microsoft-agent-framework/Cortadel.AgentFramework.slnx`, never the repo-root
`Cortadel.slnx` — it does not include this package.

Every integration suite is offline — no Cortadel server, no network, no API keys, no `CORTADEL_*`
env vars. Runtime floors differ per package, legitimately: each one is whatever its host framework
and lockfile can actually resolve (`@cortadel/claude-agent-sdk`, `@cortadel/deepagents`,
`@cortadel/langgraph`, `@cortadel/openai-agents` and the n8n nodes run on Node ≥ 20 while
`@cortadel/mastra`, `@cortadel/openclaw` and `@cortadel/vercel-ai-provider` want ≥ 22;
`cortadel-crewai` declares Python ≥ 3.11 and < 3.14 while the other two declare ≥ 3.10; the .NET
package targets `net8.0`). Let `pnpm`, `uv` and `dotnet` fetch what the manifest declares rather
than lowering a floor to match your machine.

**Public option names are canonical across all twelve.** In every row the three spellings are
TypeScript / Python / .NET: `throwOnError` / `raise_on_error` / `ThrowOnError`, `onError` /
`on_error` / `OnError` (always a callback), `topK` / `top_k` / `TopK`, `awaitPersist` /
`await_persist` / `AwaitPersist`, `scopeRecallToSession` / `scope_recall_to_session` /
`ScopeRecallToSession`, the tool names `search_memory` / `add_memories`
(`snake_case` in every language — the model reads them), and an app name defaulting to the package's
own published name. One vocabulary, one casing per language — and on the first row one *verb* per
language too, because TypeScript and C# throw where Python raises. The table and its rules live in
[`integrations/README.md`](integrations/README.md#canonical-option-names) — a package may deviate on
a *default* when its framework forces one, provided its README says why in a sentence, but never on
a *name*. A PR that introduces a synonym will be asked to rename it.

Adding a new one? [`integrations/README.md`](integrations/README.md) is the contract — the two
capabilities every package ships, the required file set, the manifest/naming conventions, the
canonical options, and the README sections. Its user-facing counterpart is
[`docs/integrations.md`](docs/integrations.md), which like every docs page needs its `website/`
mirror updated in the same commit.

### Plugin & packaging (`cortadel-plugin/`, `packaging/`)

```bash
node --test "cortadel-plugin/test/*.test.mjs"
node --test "packaging/test/*.test.mjs"
claude plugin validate ./cortadel-plugin --strict
claude plugin validate ./.claude-plugin/marketplace.json --strict
claude plugin validate ./.agents/plugins/marketplace.json --strict
```

(Windows: some Node builds don't expand a bare directory for `--test` — use the explicit glob
shown above, not `node --test packaging/test/`.)

### Conformance suites (all three SDKs)

Each SDK also has a `conformance/` (TS/Python) or `*.Conformance` (.NET) project that exercises a
**real** running server — set `CORTADEL_CONFORMANCE_URL` to a reachable Cortadel instance (a local
`docker compose up` serves `http://localhost:3001`); without it, these suites self-skip rather
than fail. A second env var, `CORTADEL_CONFORMANCE_LLM=1`, additionally enables tests that need a
working LLM + embedding provider.

```bash
docker compose up -d   # from the repo root — Memgraph + Ollama + Cortadel

CORTADEL_CONFORMANCE_URL=http://localhost:3001 dotnet test sdk/dotnet/Cortadel.Sdk.Conformance
CORTADEL_CONFORMANCE_URL=http://localhost:3001 pnpm exec vitest run conformance   # sdk/typescript/
CORTADEL_CONFORMANCE_URL=http://localhost:3001 uv run pytest conformance -q       # sdk/python/
```

**Always scope test data to an `e2e-*` user id** (e.g. `e2e-my-feature-test`) — never a real
identity. These suites write real memories to whatever server `CORTADEL_CONFORMANCE_URL` points
at, and `e2e-*` is this project's convention for marking data as disposable.

## Docs — update both copies

Every page in `docs/*.md` has a matching file under `website/src/content/docs/` (same basename;
the website copy adds Starlight frontmatter, converts `> ` blockquotes to `:::note`/`:::tip[...]`
asides, and uses root-relative links instead of relative `.md` links). **Update both in the same
commit.** `pr.yml`'s `docs-website-mirror` job enforces this on every PR — it normalizes away those
three known formatting differences and fails if the remaining text still diverges, naming the
specific file pair — but the check only runs on what you push; it can't write the second copy for
you. A past change that touched only one copy left the live site describing a removed API, twice.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) — `feat(scope): ...`,
`fix(scope): ...`, `docs: ...`, `test(scope): ...`, `ci(scope): ...`. Check `git log` for the
scope names already in use (`sdk-ts`, `sdk-py`, `plugin`, `skill`, `ci`, …) rather than inventing
a new one for an existing area.

## Pull requests

- Keep PRs focused — one logical change per PR.
- Add or update tests for any behavior change; update `docs/` **and** its `website/` mirror for
  any user-facing change.
- Make sure the relevant SDK's build/test commands above pass locally. CI mirrors them (see
  `.github/workflows/dotnet.yml`, `typescript.yml`, `python.yml`) plus a generation-drift check and
  the base-tier conformance suite when your PR touches that SDK's paths — see "Continuous
  integration" below for exactly what runs where.
- Never commit secrets, API keys, or real user data — test fixtures use `e2e-*` ids (see above).
- Use the PR template's checklist — it names the traps this section (and the ones above it) covers.

## Continuous integration

What runs on every PR, what only runs when you touch certain paths, and what a fork PR can and
can't trigger.

### Always runs: the PR gate (`.github/workflows/pr.yml`)

Every pull request, regardless of which files it touches, runs five fast jobs with no service
containers and no repository secrets (target: under two minutes):

1. **Workflow & manifest integrity** — every `.github/workflows/*.yml` parses, and the Claude Code
   plugin + marketplace manifests validate (best-effort: if the validator CLI can't be installed,
   e.g. the npm registry is unreachable, this step is skipped with a warning rather than failing
   the job on an unrelated network issue).
2. **Generated-content drift** — regenerates the plugin/marketplace manifests from
   `packaging/plugin.metadata.json` and fails on any resulting diff, including newly-created files
   (`git status --untracked-files=all`, not a bare `git diff` — see that job's own comment).
3. **docs/website mirror parity** — every `docs/*.md` has a matching, content-equal
   `website/src/content/docs/*.md` (see "Docs — update both copies" above).
4. **Fast unit tests** — the plugin's `node --test` suite, the packaging generator's `node --test`
   suite, and the TypeScript SDK's `vitest` unit tests. Deliberately not conformance (next section).
5. **Supply-chain sanity on the diff** — fails if the PR *adds* a workflow using
   `pull_request_target`, an unpinned `uses: ...@vN`-style action reference, or something that
   looks like a committed credential (fixed, high-signal patterns only — an AWS access key id, a
   PEM private key header, a GitHub/Slack token — not a generic entropy scanner). Only flags lines
   the PR itself introduces, never pre-existing content on `main`.

### Path-filtered: the per-SDK/area workflows

`dotnet.yml`, `typescript.yml`, `python.yml`, `docs.yml`, `cortadel-plugin.yml`,
`plugin-packaging.yml`, and `integrations.yml` each run only when a PR touches the paths they own
(see each file's own `on.pull_request.paths`). `integrations.yml` is the three-toolchain one — a
pnpm/tsc/vitest matrix over the eight TypeScript packages, a uv/pytest matrix over the three Python
ones, and a dotnet build/test/pack leg for the .NET one, plus a `matrix-coverage` job that re-derives
every package's toolchain and runtime floor from the manifest on disk, so moving a package between
languages without updating that workflow fails the PR instead of quietly testing the old toolchain.
It has no conformance tier (every integration suite is offline). It *does* have a release path —
`release-plan` plus one publish job per registry — but that path only exists on tag pushes and is
invisible to a PR (see [Releasing](#releasing)). Most of the others also run a `conformance-base`
job that starts a real Memgraph container plus a real `ghcr.io/cortadel/cortadel:latest` server and
exercises the SDK against it — heavier than the always-on gate (containers, a health-gate wait
loop), so it's scoped to PRs that actually touch that SDK rather than running for everyone.

### What a fork PR can and can't trigger

No workflow in this repository uses `pull_request_target` — everything, including `pr.yml` and the
path-filtered workflows above, triggers on plain `pull_request`, which GitHub runs with **no
repository secrets** and a **read-only** `GITHUB_TOKEN` regardless of whether the PR is from a
fork. Concretely:

- Everything above **does** run automatically on a fork PR, including the conformance-base suites
  when their paths match — they need Docker (the Memgraph/Cortadel images are public), not a
  secret.
- The one thing a fork PR can never trigger is a `publish-*` job (npm/PyPI/NuGet) — those need
  either a repository secret or trusted-publishing OIDC, gated behind a tag push, which a
  `pull_request` event can't produce. In `integrations.yml` there is a second, independent barrier:
  every publish job depends on `release-plan`, which itself only runs on a `refs/tags/integration-*`
  ref, and a skipped dependency skips its dependents.
- The weekly `conformance-full` tier (LLM + embeddings via Ollama, ~9.6 GB of models) never runs on
  any PR, fork or not — see each SDK workflow's own header comment for why.

If a maintainer wants conformance results for your fork PR sooner than a path-filtered workflow
would otherwise give them, they can `workflow_dispatch` the relevant file against your branch.

## Releasing

Nothing publishes on a merge to `main`. Every release is a tag push, and each publishable unit has its
own tag prefix so a bare `v1.0.0` can never leave you guessing what it released.

### The three SDKs (`sdk/`)

| Tag | Publishes | Registry | Auth |
| --- | --- | --- | --- |
| `sdk-dotnet-v*` | `Cortadel.Sdk` | NuGet | OIDC trusted publishing (`NuGet/login`) — no stored secret |
| `sdk-ts-v*` | `@cortadel/sdk` | npm | the `NPM_TOKEN` repository secret. `id-token: write` on that job is for **provenance** (the Sigstore attestation `--provenance` produces), *not* for authentication |
| `sdk-py-v*` | `cortadel` | PyPI | the `PYPI_TOKEN` repository secret |

### The twelve integrations (`integrations/`)

One tag per package, because the twelve version independently:

```
integration-<directory-slug>-v<version>      e.g.  integration-langgraph-v0.1.0
```

The slug is the **directory** under `integrations/`, not the registry package name — the two are not
always the same (`integrations/vercel-ai-sdk` publishes as `@cortadel/vercel-ai-provider`). The
workflow reads the package name out of the manifest rather than deriving it from the tag.

Three things the `integrations.yml` release path guarantees, all of which fail the run *before* any
registry is contacted:

- **The tag resolves to exactly one package.** `release-plan` enumerates every possible `-v` split of
  the tag and keeps only splits whose left half is a real `integrations/` directory that also has a
  matrix leg, then requires exactly one survivor — so a slug that shadows another slug's tag fails
  loudly instead of releasing the wrong thing.
- **The tag cannot publish a version other than the manifest's.** The version segment must equal
  `package.json`'s `version` / `pyproject.toml`'s `project.version` / the csproj's `<Version>`
  exactly. Worth internalising: the .NET package's version is hard-coded in the csproj and is *not*
  derived from the tag, so without this gate the two could silently disagree.
- **That package's own tests passed on that exact commit.** Each publish job depends on its
  toolchain's whole test matrix plus `matrix-coverage`. Releasing an npm package needs all eight
  TypeScript legs green; it does not need the Python or .NET legs.

Auth differs per registry, deliberately: PyPI and NuGet use OIDC trusted publishing and store no
secret, while npm uses the `NPM_TOKEN_INTEGRATIONS` secret **temporarily** — npm trusted publishing
cannot bootstrap a package that does not yet exist, so the first publish of each package has to be
token-authenticated. `publish-npm` carries the exact edit that removes the token afterwards.

**Maintainers: the registry-side setup is not in this repo and must be done by a human before the
first tag.** It is written out step by step, split into one-time-per-registry and one-time-per-package
work, in **[`.github/RELEASING.md`](.github/RELEASING.md)** — which also covers what to do when a
release goes wrong (short version: all three registries are append-only and none lets a version be
reused, so you fix forward).

Thank you for contributing to Cortadel!
