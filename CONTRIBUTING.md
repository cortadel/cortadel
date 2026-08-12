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
`clients/cortadel-plugin/` (which also carries the `cortadel` skill), docs in `docs/` mirrored
into `website/`, the shared REST contract at `spec/openapi.json`, and the plugin/marketplace
manifest generator under `packaging/`.

## Generated code — read this before touching anything under `Generated/`, `generated/`, or `_generated/`

`spec/openapi.json` is synced from a private repo — **do not edit it here**. Each SDK's
`sdk/*/**/{Generated,generated,_generated}/` tree is generated from that contract by
[Kiota](https://github.com/microsoft/kiota); the plugin/marketplace manifests
(`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`,
`clients/cortadel-plugin/.claude-plugin/plugin.json`, `clients/cortadel-plugin/.codex-plugin/plugin.json`)
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

### Plugin & packaging (`clients/cortadel-plugin/`, `packaging/`)

```bash
node --test "clients/cortadel-plugin/test/*.test.mjs"
node --test "packaging/test/*.test.mjs"
claude plugin validate ./clients/cortadel-plugin --strict
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
the website copy adds Starlight frontmatter and root-relative links instead of relative `.md`
links). **Update both in the same commit.** This is not CI-enforced — `docs.yml` only rebuilds the
website, it does not diff the two trees — so it's on you to keep them in sync; a past change that
touched only one left the live site describing a removed API.

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
  the base-tier conformance suite on every PR.
- Never commit secrets, API keys, or real user data — test fixtures use `e2e-*` ids (see above).

## Releasing

Each SDK publishes independently, triggered by pushing a tag with its own prefix:
`sdk-dotnet-v*` → NuGet, `sdk-ts-v*` → npm, `sdk-py-v*` → PyPI. See the `publish-*` job in the
matching workflow file for the exact mechanism (NuGet/npm use OIDC trusted publishing; PyPI uses a
stored API token).

Thank you for contributing to Cortadel!
