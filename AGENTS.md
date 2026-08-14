# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, or any other agent) working in this
repository. `CLAUDE.md` in this repo is a one-line pointer to this file — there is no second copy
of these rules to keep in sync.

## What this repo is

`cortadel/cortadel` is Cortadel's **open extension surface**: three published SDKs, a Claude
Code/Codex plugin, an agent skill, and the docs/website that describe them — all Apache-2.0. The
Cortadel **server** (the memory engine + dashboard, a bi-temporal graph store over FalkorDB or
Memgraph) is a separate, closed-core container image (`ghcr.io/cortadel/cortadel`) built from a
private repo; **its source does not live here**. `spec/openapi.json`, the contract every SDK is
generated from, is produced by that private repo and synced in — see "Never hand-edit these"
below.

Two ways to get a running server to point the SDKs/plugin at: the hosted service at
`https://app.cortadel.ai`, or self-host the container (`docker compose up` from the repo root, or
`docker run ghcr.io/cortadel/cortadel:latest` — see `docs/self-hosting.md`).

## Repository layout

| Path | What |
|---|---|
| `sdk/dotnet/` | `Cortadel.Sdk` (NuGet, `1.0.0`) — hand-written facade (`CortadelClient.cs`, `Models.cs`) over a Kiota-generated transport in `Generated/`. Tests in the sibling `Cortadel.Sdk.Tests` / `Cortadel.Sdk.Conformance` projects. |
| `sdk/typescript/` | `@cortadel/sdk` (npm, `1.0.0`) — facade in `src/client.ts` + `src/models.ts` over `src/generated/`. Unit tests in `test/`, conformance in `conformance/`. |
| `sdk/python/` | `cortadel` (PyPI, `1.0.0`) — facade in `cortadel/client.py` (async) and `cortadel/sync_client.py` (blocking) over `cortadel/_generated/`. Unit tests in `tests/`, conformance in `conformance/`. |
| `spec/openapi.json` | The REST contract every SDK generates from. **Synced from a private repo — do not edit.** |
| `packaging/` | `plugin.metadata.json` (hand-written source of truth for the plugin's identity + config) and `generate.mjs` (the only writer of the plugin/marketplace manifests). See "Never hand-edit these". |
| `cortadel-plugin/` | The packaged `cortadel-memory` plugin — Claude Code hooks + inline MCP server + the `cortadel` skill (`skills/cortadel/`); Codex gets the skill only. |
| `integrations/` | Twelve framework integration packages in **three languages** — **TypeScript (8)**: `claude-agent-sdk`, `deepagents`, `langgraph`, `mastra`, `n8n-nodes-cortadel`, `openai-agents`, `openclaw`, `vercel-ai-sdk`; **Python (3)**: `crewai`, `google-adk`, `pydantic-ai`; **.NET (1)**: `microsoft-agent-framework` (`Cortadel.AgentFramework`, `net8.0`). The rule is "follow the host framework": first-party TypeScript wins where the framework ships it as well as Python, the three Python ones have no first-party TS package, and Agent Framework is .NET-first. **One standalone publishable package per directory**, each depending on the published `@cortadel/sdk`/`cortadel`/`Cortadel.Sdk` package like any third party would. No workspace root and no root solution; own manifest and tests each (the .NET one has a folder-local `Cortadel.AgentFramework.slnx` and no lockfile). Contributor contract: `integrations/README.md`. |
| `docs/` | Hand-written docs; **every page here has a mirror** under `website/` — see below. |
| `website/` | Astro/Starlight docs site built from `website/src/content/docs/`, one file per `docs/*.md` page plus its own frontmatter and root-relative links. |
| `examples/` | Runnable sample projects (currently `dotnet-quickstart/`). |
| `.github/workflows/` | `dotnet.yml`, `typescript.yml`, `python.yml` (build + generation-drift + tiered conformance + publish, one per SDK), `docs.yml` (website build/deploy), `plugin-packaging.yml` (packaging generator drift + `claude plugin validate`), `cortadel-plugin.yml` (plugin's own test suite), `integrations.yml` (the twelve `integrations/` packages — three offline matrices, pnpm/tsc/vitest × 8, uv/pytest × 3 and dotnet build/test/pack × 1, plus a `matrix-coverage` job that re-derives each package's toolchain and floor from the manifest on disk so a language move can't silently keep testing the old one; no conformance tier and no publish job, since none is released yet), `pr.yml` (the always-runs PR gate — the other seven are all `paths:`-filtered, so this one runs the cheap checks on *every* pull request regardless of what it touched). |

## Never hand-edit these — regenerate instead

| Path | Generator | Command |
|---|---|---|
| `sdk/dotnet/Cortadel.Sdk/Generated/` | Kiota, from `spec/openapi.json` | `dotnet tool restore && dotnet tool run kiota generate -l CSharp -c CortadelApiClient -n Cortadel.Sdk.Generated -d ./spec/openapi.json -o ./sdk/dotnet/Cortadel.Sdk/Generated --exclude-backward-compatible --type-access-modifier Internal --clean-output` |
| `sdk/typescript/src/generated/` | Kiota | `dotnet tool run kiota generate -l typescript -c CortadelApiClient -d ./spec/openapi.json -o ./sdk/typescript/src/generated --exclude-backward-compatible -m application/json --clean-output` |
| `sdk/python/cortadel/_generated/` | Kiota | `dotnet tool run kiota generate -l python -c CortadelApiClient -n cortadel._generated -d ./spec/openapi.json -o ./sdk/python/cortadel/_generated --exclude-backward-compatible -m application/json --clean-output` |
| `spec/openapi.json` | The private server repo's `scripts/sync-openapi.sh` | Not run from here — resync from that repo. |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `cortadel-plugin/.claude-plugin/plugin.json`, `cortadel-plugin/.codex-plugin/plugin.json` | `packaging/generate.mjs`, from `packaging/plugin.metadata.json` | `node packaging/generate.mjs` |

Every one of these is CI-gated with `git status --porcelain --untracked-files=all` against the
regenerated output — **including untracked files**, deliberately: a new operation in
`spec/openapi.json` makes Kiota emit a brand-new file, not a diff to an existing one, and plain
`git diff --exit-code` is blind to untracked additions. If your regeneration produces *any* status
(modified, added, or deleted), CI fails. Edit the source (`spec/openapi.json` upstream, or
`packaging/plugin.metadata.json` here) and regenerate — never the output.

## The facade is the public API

Each SDK is a **thin, hand-written facade** over its generated Kiota transport; the generated code
is deliberately unreachable from outside the package, enforced differently per language:

- **.NET**: `--type-access-modifier Internal` on the Kiota generate command above — the generated
  types are `internal`, invisible outside `Cortadel.Sdk.dll`.
- **TypeScript**: `package.json`'s `exports` map only publishes `"."` (`dist/index.js`) — there is
  no subpath export into `dist/generated/`, so `@cortadel/sdk/generated/...` cannot be imported.
- **Python**: `cortadel/_generated/` is underscore-prefixed by convention (Python has no `internal`
  keyword); `cortadel/__init__.py`'s own docstring says not to import from it.

When adding a facade method, follow the existing pattern in that SDK (map generated request/response
types to the facade's own DTOs in `models.py`/`models.ts`/`Models.cs`) rather than exposing a
generated type directly.

## Docs and the website mirror — must change together

Every page in `docs/*.md` has a matching file under `website/src/content/docs/` (same basename;
the website copy adds Starlight frontmatter and root-relative links, e.g. `mcp.md` becomes
`[MCP integration](/mcp/)` instead of `[MCP integration](mcp.md)`). **A change to one without the
other has shipped before** and left the live site teaching a removed or changed API — update both
in the same commit.

This **is** enforced by CI: `pr.yml`'s `docs-website-mirror` job runs
`.github/scripts/check-docs-mirror.mjs` on every PR. That script normalizes away the three
intentional differences (the `# H1` folded into frontmatter `title:`, `> ` blockquotes rewritten as
`:::note` / `:::tip[…]` asides, relative `foo.md` links rewritten to root-relative `/foo/`) and
fails if the remaining text still diverges, naming the file pair and the first divergent line. Run
it locally before pushing: `node .github/scripts/check-docs-mirror.mjs`. Note that
`.github/workflows/docs.yml` does **not** do this — it only builds the Starlight site, and its own
header comment says the build "does not actually read or validate root docs/**/README.md content."

## Build, test, lint (per SDK)

```bash
# .NET
dotnet restore Cortadel.slnx && dotnet build Cortadel.slnx -c Release
dotnet test sdk/dotnet/Cortadel.Sdk.Tests -c Release --nologo

# TypeScript (sdk/typescript/)
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec vitest run "test/"
pnpm run build

# Python (sdk/python/, uv-managed)
uv sync --extra test
uv run pytest tests -q

# Framework integrations (integrations/<slug>/ — self-contained, cd into the one you changed)
cd integrations/langgraph && pnpm install && pnpm run typecheck && pnpm test   # any of the 8 TS integrations
cd integrations/crewai && uv sync --extra test && uv run pytest -q             # any of the 3 Python ones
cd integrations/microsoft-agent-framework && dotnet test                       # the .NET one (81 tests)
# `pnpm run typecheck`, never a bare `tsc --noEmit`: the script chains a second pass over
# tsconfig.test.json so test/ is type-checked too. CI runs the script; the bare command misses test/.
# `dotnet test` builds the folder-local .slnx, examples/ included — never the repo-root Cortadel.slnx,
# which does not contain this package.
```

Every integration suite is offline — no server, no network, no keys, no `CORTADEL_*` env. Runtime
floors differ per package and are not to be unified: Node ≥ 20 for five TS packages and ≥ 22 for
`mastra`/`openclaw`/`vercel-ai-sdk`, Python ≥ 3.10 for `google-adk`/`pydantic-ai` and ≥ 3.11 < 3.14
for `crewai`, `net8.0` for the .NET one. Let `pnpm`/`uv`/`dotnet` fetch what the manifest asks for
rather than lowering a floor. What a new integration must contain is in `integrations/README.md`;
the user-facing page it lands on is `docs/integrations.md` (which has a website mirror — see above).

Windows note (Node test runner): a bare `node --test packaging/test/` or
`node --test cortadel-plugin/test/` doesn't expand the directory on some Node builds — use
the explicit glob, e.g. `node --test "packaging/test/*.test.mjs"`.

## Conformance suites — gated on env vars, not mocks

Each SDK also ships a `conformance/` (TS/Python) or `*.Conformance` (.NET) suite that talks to a
**real** Cortadel server — no mocks. It self-skips unless `CORTADEL_CONFORMANCE_URL` is set to a
reachable server (`http://localhost:3001` for a local `docker compose up`), and a second tier of
LLM/embedding-dependent tests additionally requires `CORTADEL_CONFORMANCE_LLM=1`:

```bash
CORTADEL_CONFORMANCE_URL=http://localhost:3001 dotnet test sdk/dotnet/Cortadel.Sdk.Conformance
CORTADEL_CONFORMANCE_URL=http://localhost:3001 pnpm exec vitest run conformance   # sdk/typescript/
CORTADEL_CONFORMANCE_URL=http://localhost:3001 uv run pytest conformance -q       # sdk/python/
```

CI runs the base tier (no `CORTADEL_CONFORMANCE_LLM`) against a bare Memgraph on every PR, and the
full tier (`CORTADEL_CONFORMANCE_LLM=1`, the full `docker compose up` stack with Ollama) only on a
weekly schedule or manual dispatch — it pulls ~9.6 GB of models, too slow/expensive for every PR.

**Every conformance test's `userId`/`user_id` uses the `e2e-*` prefix** (e.g.
`e2e-py-sdk-conformance`, `e2e-ts-sdk-conformance`) — this is the project-wide convention marking
data as disposable test/E2E data. **Never use `serhii` or any other real identity** in test data;
these suites write real data to whatever server `CORTADEL_CONFORMANCE_URL` points at.

## Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) —
`feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test(scope): ...`, `ci(scope): ...` — check
`git log` for the established scope names (`sdk-ts`, `sdk-py`, `plugin`, `skill`, `ci`, …) before
inventing a new one.

## Also read

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — full contributor workflow, one section per SDK.
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting; note the engine/repo scope split.
- [`LLM.md`](LLM.md) — a self-contained orientation for any LLM integrating *with* Cortadel (not
  contributing to this repo) — what it is, both deployment paths, the REST/MCP surface, and real
  SDK install + constructor snippets.
