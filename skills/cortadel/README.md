---
name: cortadel
description: "Teaches Claude to integrate Cortadel — a self-hosted, bi-temporal graph memory server for AI agents — via its MCP endpoint, REST API, or published .NET/TypeScript/Python SDKs."
---

# Cortadel Claude Skill

A skill that teaches Claude how to integrate [Cortadel](https://cortadel.ai), a self-hosted
bi-temporal graph memory engine for AI agents, into an application or agent — via MCP, the REST
API, or the published SDKs.

## What is Cortadel?

Cortadel is one self-hosted container (API + MCP + dashboard on `:3001`, backed by FalkorDB or
Memgraph) that turns raw text and conversations into a graph of facts with intent-aware writes,
LLM-verified deduplication, and hybrid BM25+vector+RRF retrieval. It is not a vector-store wrapper:
edits supersede rather than overwrite, "forget X" mutates the graph instead of appending a note, and
the expensive work happens at write time so reads never call an LLM.

This repository (`cortadel/cortadel`) is Cortadel's open extension surface — the official SDKs,
docs, examples, and this skill, all Apache-2.0. The memory engine itself ships as a closed-core
container image.

## What This Skill Does

This skill enables Claude to:

1. **Recognize when Cortadel fits** a task — persistent agent memory, MCP wiring, or direct REST
   integration — and reach for the right layer instead of reinventing a memory store.
2. **Write correct integration code** in .NET, TypeScript, or Python against the real published
   SDKs (all `1.0.0`), including the TypeScript options-object constructor and the Python
   async/sync client split.
3. **Wire the MCP endpoint** into Claude Code, Claude Desktop, Cursor, or any MCP-capable client
   with the exact URL shape, auth headers, and tool list.
4. **Call the REST API directly** with the correct snake_case field names, request/response shapes,
   and error handling for all seven public operations.
5. **Explain the honest limitations** of each SDK surface — what's `null` today, what fields the
   wire has that the SDK doesn't expose — instead of promising capabilities that don't exist yet.

## Available SDKs

All three are published and versioned at `1.0.0`:

- **.NET**: `dotnet add package Cortadel.Sdk` ([NuGet](https://www.nuget.org/packages/Cortadel.Sdk))
- **TypeScript**: `npm install @cortadel/sdk` ([npm](https://www.npmjs.com/package/@cortadel/sdk))
- **Python**: `pip install cortadel` ([PyPI](https://pypi.org/project/cortadel/))

## When Claude Uses This Skill

Claude applies this skill when:

- A user is building an agent, chatbot, or app that needs to remember things across sessions.
- A user asks about connecting an MCP client (Claude Code, Claude Desktop, Cursor, …) to a memory
  server.
- A user is integrating the `Cortadel.Sdk`, `@cortadel/sdk`, or `cortadel` package, or calling the
  Cortadel REST API directly.
- A user asks how Cortadel's write pipeline, dedup, or hybrid search actually behaves.

## Skill Contents

```
cortadel/
├── SKILL.md                    # Decision layer: what it is, when to reach for it, minimal examples
├── README.md                   # This file
└── references/
    ├── quickstart.md           # Server + SDK setup, store/recall walkthrough, auth
    ├── sdk-guide.md            # Full SDK reference: methods, options, models, per-language caveats
    ├── api-reference.md        # Full REST reference: every endpoint, field, and error shape
    ├── architecture.md         # Write pipeline, event vocabulary, search pipeline, graph model
    └── use-cases.md            # Concrete integration patterns with working code
```

## Installation

### For Claude Code

Place this skill in your Claude Code skills directory:

```bash
# Project-level (this repo already has it at skills/cortadel/)
.claude/skills/cortadel/    # or reference skills/cortadel/ directly if working in this repo

# Personal (available in all projects)
~/.claude/skills/cortadel/
```

Claude Code discovers and loads skills under either location automatically.

### For Claude.ai

1. Zip the `cortadel/` directory (the one containing `SKILL.md`).
2. Go to Settings → Capabilities in Claude.ai.
3. Upload the ZIP file.

### For Claude API

Use the Skills API to manage the skill programmatically:

```bash
curl -X POST https://api.anthropic.com/v1/skills \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -F "skill=@cortadel.zip"
```

## Usage

Once installed, Claude references this skill automatically when relevant. You can also invoke it
directly:

```
/cortadel
```

Or ask a specific question:

```
How do I add persistent memory to my agent with Cortadel?
Show me the TypeScript SDK constructor for Cortadel.
How does Cortadel's "forget X" behavior work?
```

## Key Features Covered

### 1. Quick Integration Examples
Store-then-search snippets for .NET, TypeScript, Python, and raw REST — the same round trip in
every surface.

### 2. Complete SDK Reference
All seven methods per language (`add`, `add_conversation`, `search`, `list`, `get`, `delete`,
`health`), their option types, error types (`CortadelException` / `CortadelError`), and the
model caveats that differ per language (metadata gaps, wire-name mismatches, extension-data traps).

### 3. REST API Reference
Every operation from `spec/openapi.json` — `Health_Check`, `Memories_List`, `Memories_Create`,
`Memories_BulkDelete`, `Memories_Get`, `Memories_Search`, `Memories_FromConversation` — with
request/response fields, security schemes, and status codes.

### 4. Architecture Deep Dive
The write pipeline (classify intent → dedup check → atomic insert → background extraction), the
event vocabulary (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, `TOUCH`, `RESOLVE`, `INVALIDATE`,
`DELETE_ENTITY`, `ERROR`), and the read pipeline (BM25 + vector + RRF, optional cross-encoder,
zero LLM calls).

### 5. Real-World Use Cases
Concrete patterns: MCP-wired coding agent, direct REST integration in a backend service,
correcting/forgetting a fact, conversation-to-memory ingestion, multi-user scoping, and browsing
history with pagination.

## Best Practices Highlighted

- **User scoping**: every call is scoped to a `userId`/`user_id` bound to the API key; construct
  one client per user and keep it for the app's lifetime.
- **Plain-language intent**: write "I moved to Berlin" or "forget my old address" as plain text —
  the server classifies intent, don't pre-route it yourself.
- **Never store secrets**: don't write API keys, tokens, or passwords into memory text; store the
  fact that a secret exists and where to find it instead.
- **Auth defaults to open**: an empty auth secret leaves every REST and MCP endpoint unauthenticated
  — fine for local development, not for exposing an instance to the internet.
- **Check `event`, not just success**: a 200 from `add`/`AddAsync` can still carry
  `SKIP_DUPLICATE` — inspect the returned `event` before assuming a new memory was written.

## Resources Linked

- **Getting started**: [`docs/getting-started.md`](../../docs/getting-started.md)
- **Self-hosting**: [`docs/self-hosting.md`](../../docs/self-hosting.md)
- **MCP integration**: [`docs/mcp.md`](../../docs/mcp.md)
- **SDK references**: [`docs/sdk-dotnet.md`](../../docs/sdk-dotnet.md) ·
  [`docs/sdk-typescript.md`](../../docs/sdk-typescript.md) ·
  [`docs/sdk-python.md`](../../docs/sdk-python.md)
- **Website**: [cortadel.ai](https://cortadel.ai)
- **GitHub**: [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel)

## Contributing

To improve this skill: edit the files under `skills/cortadel/`, verify every claim against
`spec/openapi.json` and the SDK source under `sdk/*/`, and open a pull request against this repo.

## License

This skill is part of the `cortadel/cortadel` repository and is licensed under Apache-2.0 — see
the repository [`LICENSE`](../../LICENSE).

## Changelog

### 2026-08-12
- Initial release, covering the `1.0.0` .NET/TypeScript/Python SDKs and the seven public REST
  operations in `spec/openapi.json`.
