## What changed

<!-- One or two sentences. -->

## Why

<!-- What problem this solves, or what issue it closes (Closes #___). -->

## How this was verified

<!-- Commands you ran and their output, or a description of manual testing. "I read it" is not verification. -->

## Checklist

- [ ] I did not hand-edit a generated file (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `clients/cortadel-plugin/.claude-plugin/plugin.json`, `clients/cortadel-plugin/.codex-plugin/plugin.json`, or any SDK's `Generated`/`generated`/`_generated` tree) — I changed the source (`packaging/plugin.metadata.json` or `spec/openapi.json` upstream) and re-ran the generator instead.
- [ ] If this touches `docs/*.md`, I updated the matching `website/src/content/docs/*.md` file in the same commit (and vice versa) — see [`CONTRIBUTING.md`](../CONTRIBUTING.md#docs--update-both-copies).
- [ ] I ran the relevant tests locally and they pass (see [`CONTRIBUTING.md`](../CONTRIBUTING.md#building-and-testing-each-sdk) for the commands per SDK/package).
- [ ] I did not commit secrets, API keys, or real user data (test fixtures use `e2e-*` ids).

<!--
What runs automatically on this PR (see .github/workflows/pr.yml and docs/contributing-ci.md):
workflow/manifest integrity, generated-manifest drift, docs/website mirror parity, fast unit tests,
and a supply-chain sanity check on the diff itself. Path-filtered suites (dotnet.yml, typescript.yml,
python.yml, docs.yml, cortadel-plugin.yml, plugin-packaging.yml) run too if this PR touches their
paths — conformance suites among them need a running server and do not run on fork PRs without a
maintainer's help; see docs/contributing-ci.md for what that means for you.
-->
