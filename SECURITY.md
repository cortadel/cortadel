# Security Policy

## Scope

This repository is Cortadel's **open extension surface**: the `.NET`/`Python`/`TypeScript` SDKs
under `sdk/`, the Claude Code & Codex plugin under `cortadel-plugin/`, the `cortadel` skill, the docs
(`docs/`, `website/`), and the OpenAPI contract mirror at `spec/openapi.json`. Vulnerability
reports **in scope here** cover that surface — for example, a flaw in a published SDK's request
signing, a plugin hook that leaks a credential, or a docs example that recommends unsafe config.

The Cortadel **server** (the memory engine + dashboard container image,
`ghcr.io/cortadel/cortadel`) is closed-core and does not live in this repository. If your report is
about the running server itself — the API, the MCP endpoint, the dashboard, or the hosted service
at `https://app.cortadel.ai` — please still report it through the channel below; the maintainers
will route it internally rather than as a PR against this repo, since there is no engine source
here to patch.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for a security report.**

Email **security@cortadel.ai** with:

- Affected component (SDK + language, plugin, skill, docs, or the server/hosted service)
- Affected version or commit
- Steps to reproduce, and the impact if exploited

If [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
is enabled on this repository by the time you read this, its Security tab is an equally good
channel — check there first.

We do not currently commit to a fixed response-time SLA or run a bug-bounty program; reports are
reviewed and triaged as they come in.

## Supported Versions

The three SDKs are each at their first stable release (`1.0.0`) and versioned independently
(`Cortadel.Sdk` on NuGet, `cortadel` on PyPI, `@cortadel/sdk` on npm). Security fixes land against
the latest published version of each package — please reproduce against `1.0.0` (or newer, once
later versions exist) before reporting.
