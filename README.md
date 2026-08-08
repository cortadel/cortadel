<div align="center">

# Cortadel

**Self-hosted long-term temporal graph memory for AI agents.**
MCP, REST, and a dashboard in one container — on .NET 10, backed by FalkorDB or Memgraph.

[![SDK: Apache-2.0](https://img.shields.io/badge/SDK-Apache--2.0-blue)](LICENSE)
[![.NET SDK](https://img.shields.io/badge/NuGet-Cortadel.Sdk-512BD4)](https://www.nuget.org/packages/Cortadel.Sdk)
[![Docs](https://img.shields.io/badge/docs-cortadel-black)](docs/)

</div>

> **Status — early access.** This repository is the **open extension surface**: the official **SDK, docs, and examples** (Apache-2.0). The Cortadel **server** (memory engine + dashboard) is the product, shipped as a container image (see [Self-hosting](docs/self-hosting.md)). The engine and dashboard source are **not** in this repo. SDKs for TypeScript and Python are on the roadmap.

---

## What is Cortadel?

Cortadel gives an AI agent a **durable, queryable memory** that survives across sessions — not a vector blob, but a **temporal knowledge graph**:

- **Remembers facts, entities, and how they relate** — and *when* they were true (bi-temporal: nothing is overwritten, memories are superseded).
- **Hybrid retrieval** — BM25 + vector fused with RRF, then a local cross-encoder reranker. No LLM call on the read path.
- **Understands intent** — "remember X", "forget X", "X is resolved" all do the right thing.
- **Reconciles itself** — a reviewable, reversible engine merges duplicate entities and supersedes stale ones.
- **Two ways in** — a **REST API** and a **Model Context Protocol (MCP)** endpoint, so any agent (Claude, Cursor, your own) can use it with zero glue.
- **One container** — the API, the MCP endpoint, and the dashboard run in a single process on `:3001`, over **FalkorDB** or **Memgraph**.

Built **.NET-first** — the agent-memory engine the .NET ecosystem was missing.

## Quick start

**1. Run the server** (container — see [Self-hosting](docs/self-hosting.md) for compose + graph DB):

```bash
docker run -p 3001:3001 ghcr.io/cortadel/cortadel:latest
# dashboard: http://localhost:3001 · REST: /api/v1 · MCP: /mcp/{client}/{userId}
```

**2. Install the .NET SDK:**

```bash
dotnet add package Cortadel.Sdk
```

**3. Remember and recall:**

```csharp
using Cortadel.Sdk;

var cortadel = new CortadelClient("http://localhost:3001", userId: "alice", apiKey: null);

await cortadel.AddAsync("Alice prefers dark mode and ships on Fridays.");

var hits = await cortadel.SearchAsync("what are alice's preferences?", new() { TopK = 5 });
foreach (var h in hits.Results)
    Console.WriteLine($"{h.RrfScore:F2}  {h.Content}");
```

See the [.NET SDK guide](docs/sdk-dotnet.md) and the [runnable example](examples/dotnet-quickstart/).

## Use it from any agent (MCP)

Point any MCP client at the endpoint — no SDK needed:

```
http://localhost:3001/mcp/claude/alice
```

Tools: `add_memories`, `add_conversation`, `search_memory`, `get_skill`, `add_media`, `reconcile_memories`, and more. See [MCP](docs/mcp.md).

## What's in this repo

| Path | What |
|------|------|
| [`sdk/dotnet`](sdk/dotnet) | Official **.NET SDK** (`Cortadel.Sdk`) — a thin, typed client over the REST API |
| [`docs`](docs) | Getting started, authentication, self-hosting, MCP, SDK reference |
| [`examples`](examples) | Runnable samples |

*Coming:* TypeScript + Python SDKs, connector API, and a community-integrations registry.

## Documentation

- [Getting started](docs/getting-started.md)
- [Authentication](docs/authentication.md)
- [Self-hosting the server](docs/self-hosting.md)
- [MCP integration](docs/mcp.md)
- [.NET SDK reference](docs/sdk-dotnet.md)

## Licensing

- **This repo** — the SDK, docs, and examples — is **Apache-2.0**. Use it freely.
- **The Cortadel server** (engine + dashboard container) is **free to self-host for personal and development use**; a **commercial license** is required for business use. See [cortadel.ai](https://cortadel.ai) for terms and managed **Cortadel Cloud**.

## Links

- Website: https://cortadel.ai
- Issues & discussions: use this repo's tracker.
