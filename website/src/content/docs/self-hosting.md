---
title: Self-hosting the server
description: Run the Cortadel container with FalkorDB or Memgraph, and every configuration knob.
---

Cortadel runs as **one container, one port**. The ASP.NET Core process serves the REST API, the MCP
endpoint, Swagger, and the React dashboard on `:3001`. It needs three things reachable from the
container:

1. a **graph database** — FalkorDB or Memgraph,
2. an **embedding provider** — Ollama, LM Studio, or Azure OpenAI (external; there is no built-in
   embedding model), and
3. an **LLM provider** — Azure OpenAI or any OpenAI-compatible endpoint (LM Studio, Ollama), used
   only at **write time** (fact extraction, dedup, entity/community summaries); reads never call it.

The **cross-encoder reranker** (bge-reranker-v2-m3, int8) ships **inside the image** and runs on
CPU, so it needs no external service.

## One-command quickstart (batteries included)

Want the whole stack with **zero external setup**? The repo ships a root
[`docker-compose.yml`](https://github.com/cortadel/cortadel/blob/main/docker-compose.yml) that
bundles a graph database, an embedding model, and an LLM — and wires them together for you:

- **Memgraph** — the graph database
- **Ollama** — auto-pulls a lightweight embedding model
  ([intelli-embed-v3](https://huggingface.co/serhiiseletskyi/intelli-embed-v3), 1024-dim) and an
  on-device LLM ([`gemma4:e4b`](https://ollama.com/library/gemma4:e4b))
- **Cortadel** — API + MCP + dashboard, with the CPU reranker (`ms-marco-MiniLM-L-6-v2`) baked in

Everything runs **on CPU — no GPU required** (it's happy on a laptop):

```bash
curl -O https://raw.githubusercontent.com/cortadel/cortadel/main/docker-compose.yml
docker compose up
```

…or clone the repo and run it in place:

```bash
git clone https://github.com/cortadel/cortadel.git
cd cortadel && docker compose up
```

Then open the dashboard at <http://localhost:3001>. **First run downloads a few GB** (images plus the
two models), so give it a few minutes; later starts are instant.

Swap models without editing the file — set env vars (or a `.env` beside the compose):

```bash
LLM_MODEL=gemma4:12b docker compose up            # bigger LLM
LLM_MODEL=gemma4:e2b docker compose up            # lighter LLM
EMBED_MODEL=nomic-embed-text docker compose up    # lighter embedding (then set Dimensions=768)
```

:::note
Keep `MEMFORGE_Embedding__Dimensions` in sync with your embedding model's output dimension
(intelli-embed-v3 = 1024, nomic-embed-text = 768) — a mismatch hard-fails startup on the dimension guard.
:::

Prefer to **bring your own** graph DB and providers? Use one of the composes below instead.

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
      MEMFORGE_FalkorDb__Host: "falkordb:6379"     # host:port in ONE value (there is no __Port key)
      MEMFORGE_FalkorDb__GraphName: cortadel
      # MEMFORGE_FalkorDb__Password: "..."          # only if your FalkorDB requires AUTH

      # Embeddings — an external provider is required (example: Ollama on the host, OpenAI-compatible /v1).
      MEMFORGE_Embedding__Provider: ollama
      MEMFORGE_Embedding__Ollama__Endpoint: "http://host.docker.internal:11434/v1"
      MEMFORGE_Embedding__Ollama__Model: "snowflake-arctic-embed2"
      MEMFORGE_Embedding__Dimensions: "1024"        # MUST match your model's output dimension

      # LLM (write-time only). There is no 'ollama' LLM provider — point 'lmstudio' at any
      # OpenAI-compatible /v1 (LM Studio or Ollama), or use 'azure'.
      MEMFORGE_Llm__Provider: lmstudio
      MEMFORGE_Llm__LmStudioEndpoint: "http://host.docker.internal:11434/v1"
      MEMFORGE_Llm__LmStudioModel: "qwen2.5:7b-instruct"

      # Auth — empty = OPEN (every REST + MCP endpoint is unauthenticated). Set a secret on any shared network.
      MEMFORGE_Auth__Secret: ""
    volumes:
      - cortadel-cache:/app/cache                   # persist embedding/LLM disk cache + backups

volumes:
  falkordb-data:
  cortadel-cache:
```

```bash
docker compose up
# dashboard  http://localhost:3001
# REST       http://localhost:3001/api/v1
# MCP        http://localhost:3001/mcp/{client}
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
      MEMFORGE_Memgraph__Url: "bolt://memgraph:7687"   # a full bolt URL — there is no __Host/__Port
      # MEMFORGE_Memgraph__Username: "..."
      # MEMFORGE_Memgraph__Password: "..."
```

:::note
Memgraph's BM25 full-text search needs `--experimental-enabled=text-search`.
:::

## Dependencies at a glance

| Component | In the image? | You provide |
|---|---|---|
| .NET 10 runtime, dashboard SPA | ✅ | — |
| **Reranker** — bge-reranker-v2-m3 (int8, CPU) | ✅ baked in | *(optional)* a GPU rerank endpoint |
| **Graph database** | ❌ | FalkorDB **or** Memgraph |
| **Embedding provider** | ❌ | Ollama, LM Studio, or Azure OpenAI |
| **LLM provider** (write-time only) | ❌ | Azure OpenAI or any OpenAI-compatible endpoint |

## Configuration reference

Every setting binds from `appsettings.json`, then from environment variables prefixed **`MEMFORGE_`**
with `__` (double underscore) as the section separator. Nested keys chain the separator:
`Embedding:Ollama:Endpoint` → `MEMFORGE_Embedding__Ollama__Endpoint`.

### Database

| Setting → env var | Default | Notes |
|---|---|---|
| `Database:Provider` → `MEMFORGE_Database__Provider` | `memgraph` | `falkordb` or `memgraph` |

### FalkorDB — when `Database:Provider=falkordb`

| Setting → env var | Default | Notes |
|---|---|---|
| `FalkorDb:Host` → `MEMFORGE_FalkorDb__Host` | `localhost:6379` | **`host:port` in one value** (no separate `Port` key) |
| `FalkorDb:Password` → `MEMFORGE_FalkorDb__Password` | *(empty)* | only if AUTH is enabled |
| `FalkorDb:GraphName` → `MEMFORGE_FalkorDb__GraphName` | `memforge` | graph key name |

### Memgraph — when `Database:Provider=memgraph`

| Setting → env var | Default | Notes |
|---|---|---|
| `Memgraph:Url` → `MEMFORGE_Memgraph__Url` | `bolt://localhost:7687` | **a full bolt URL** (no separate host/port) |
| `Memgraph:Username` / `Memgraph:Password` | *(empty)* | Bolt credentials |
| `Memgraph:MaxPoolSize` | `50` | connection pool size |

:::note
Memgraph needs `--experimental-enabled=text-search` for BM25 full-text search.
:::

### Embeddings — required (no built-in model)

| Setting → env var | Default | Notes |
|---|---|---|
| `Embedding:Provider` → `MEMFORGE_Embedding__Provider` | *(unset → errors)* | `ollama`, `lmstudio`, or `azure` |
| `Embedding:Dimensions` → `MEMFORGE_Embedding__Dimensions` | `1024` | **must match your model and the vector index** |

Then set the block for your chosen provider:

| Provider | Endpoint | Model |
|---|---|---|
| `ollama` | `Embedding:Ollama:Endpoint` (e.g. `http://host:11434/v1`) | `Embedding:Ollama:Model` |
| `lmstudio` | `Embedding:LmStudio:Endpoint` (e.g. `http://host:1234/v1`) | `Embedding:LmStudio:Model` |
| `azure` | `Embedding:Azure:Endpoint` + `Embedding:Azure:ApiKey` | `Embedding:Azure:Deployment` (+ `Embedding:Azure:ApiVersion`) |

### LLM — write-time only

Used for fact extraction, dedup verdicts, and entity/community summaries. **Reads never call the LLM.**

| Setting → env var | Default | Notes |
|---|---|---|
| `Llm:Provider` → `MEMFORGE_Llm__Provider` | *(auto)* | `azure` or `lmstudio` — **no `ollama` provider**; use `lmstudio` against Ollama's `/v1` |

| Provider | Endpoint / credentials | Model |
|---|---|---|
| `lmstudio` (LM Studio, Ollama, any OpenAI-compatible) | `Llm:LmStudioEndpoint` (e.g. `http://host:11434/v1`) | `Llm:LmStudioModel` |
| `azure` | `Llm:AzureEndpoint` + `Llm:AzureApiKey` | `Llm:AzureDeployment` (+ `Llm:AzureApiVersion`) |

### Reranker

Ships **inside the image** (bge-reranker-v2-m3, int8, CPU) — no external service needed.

| Setting → env var | Default | Notes |
|---|---|---|
| `Rerank:Provider` → `MEMFORGE_Rerank__Provider` | `onnx` | `onnx` (CPU, baked in) or `http` (GPU) |
| `Rerank:HttpEndpoint` → `MEMFORGE_Rerank__HttpEndpoint` | *(empty)* | a llama.cpp `/v1/reranking` server; setting it selects `http` |

### Auth

| Setting → env var | Default | Notes |
|---|---|---|
| `Auth:Secret` → `MEMFORGE_Auth__Secret` | *(empty = OPEN)* | HMAC key secret; empty leaves every endpoint unauthenticated |

Mint a user's API key:

```bash
docker run --rm -e MEMFORGE_Auth__Secret="your-secret" ghcr.io/cortadel/cortadel mint-key alice
```

### Caching & backups (optional)

`Cache:Enabled` toggles the embedding/LLM disk cache (`Cache:EmbeddingPath`, `Cache:LlmPath`).
`Backup:Enabled` turns on nightly per-user backups (`Backup:Hour`, `Backup:Directory`, `Backup:Keep`).
Mount a volume at `/app/cache` to persist both across restarts.

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
