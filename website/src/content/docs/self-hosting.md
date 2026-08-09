---
title: Self-hosting the server
description: Run the Cortadel container with FalkorDB or Memgraph, and every configuration knob.
---

Cortadel runs as **one container, one port**. The ASP.NET Core process serves the REST API, the MCP
endpoint, Swagger, and the React dashboard on `:3001`. It needs two things reachable from the
container:

1. a **graph database** — FalkorDB or Memgraph, and
2. an **embedding provider** — Ollama, LM Studio, or Azure OpenAI (an external endpoint is required;
   there is no built-in embedding model).

## Docker Compose (FalkorDB)

FalkorDB is the recommended default — it's fast and starts instantly.

```yaml
# docker-compose.yml
services:
  falkordb:
    image: falkordb/falkordb:latest
    ports:
      - "6379:6379"
      - "33000:3000"        # FalkorDB browser UI
    volumes:
      - falkordb-data:/data

  cortadel:
    image: ghcr.io/cortadel/cortadel:latest
    depends_on: [falkordb]
    ports:
      - "3001:3001"
    environment:
      MEMFORGE_Database__Provider: falkordb
      MEMFORGE_FalkorDb__Host: falkordb
      MEMFORGE_FalkorDb__Port: "6379"

      # Embeddings — point at your provider (example: a local Ollama)
      MEMFORGE_Embedding__Provider: ollama
      MEMFORGE_Embedding__Endpoint: http://host.docker.internal:11434
      MEMFORGE_Embedding__Model: nomic-embed-text

      # Optional: enable auth (leave empty to run open on a trusted network)
      MEMFORGE_Auth__Secret: ""

volumes:
  falkordb-data:
```

```bash
docker compose up
# dashboard  http://localhost:3001
# REST       http://localhost:3001/api/v1
# MCP        http://localhost:3001/mcp/{client}/{userId}
```

## Memgraph instead

```yaml
  memgraph:
    image: memgraph/memgraph-mage:latest
    command: ["--experimental-enabled=text-search"]   # required for BM25
    ports: ["7687:7687"]
```

```yaml
    environment:
      MEMFORGE_Database__Provider: memgraph
      MEMFORGE_Memgraph__Host: memgraph
      MEMFORGE_Memgraph__Port: "7687"
```

:::note
Memgraph's BM25 full-text search needs `--experimental-enabled=text-search`.
:::

## Configuration

Config binds from environment variables prefixed **`MEMFORGE_`**, using `__` (double underscore) as
the section separator — so `MEMFORGE_FalkorDb__Host` sets `FalkorDb:Host`.

| Variable | Purpose |
|---|---|
| `MEMFORGE_Database__Provider` | `falkordb` or `memgraph` |
| `MEMFORGE_FalkorDb__Host` / `__Port` | FalkorDB connection |
| `MEMFORGE_Memgraph__Host` / `__Port` | Memgraph connection |
| `MEMFORGE_Embedding__Provider` | `ollama`, `lmstudio`, or `azure` |
| `MEMFORGE_Embedding__Endpoint` | Embedding provider base URL |
| `MEMFORGE_Embedding__Model` | Embedding model name |
| `MEMFORGE_Llm__Provider` | `azure` or `lmstudio` (LLM for extraction/dedup) |
| `MEMFORGE_Auth__Secret` | Enable auth; empty = open |

## Health

```bash
curl http://localhost:3001/api/health
```

Returns overall status plus per-dependency checks (database, embeddings, vector indexes). Use it as
your container health probe.

## Changing embedding provider

The vector index dimension is fixed at first run. If you switch to an embedding model with a
different dimension, startup **hard-fails** on a dimension guard. Re-embed everything via the
maintenance endpoint, or override the guard for a deliberate migration:

```
POST /api/v1/debug/reindex-vectors        # rebuild vectors with the new model
MEMFORGE_Embedding__SkipDimensionGuard=true   # boot past the guard on purpose
```

## Licensing

Self-hosting is **free for personal and development use**. Business use requires a commercial
license. Managed **Cortadel Cloud** removes the ops entirely. See [cortadel.ai](https://cortadel.ai).
