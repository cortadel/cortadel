---
name: cortadel
description: Cortadel is a self-hosted, bi-temporal graph memory server for AI agents — one .NET container exposing a REST API and an MCP endpoint over FalkorDB or Memgraph, with intent-aware writes (store/invalidate/delete-entity/touch/resolve), LLM-verified dedup with a negation guard, and hybrid BM25+vector+RRF retrieval (optional local cross-encoder rerank) that makes zero LLM calls on the read path. Use this skill when adding persistent, evolving memory to an agent or app — wiring the MCP endpoint into Claude Code/Desktop/Cursor for zero-code recall, calling the REST API directly, or integrating the published .NET (Cortadel.Sdk), TypeScript (@cortadel/sdk), or Python (cortadel) SDKs to store, search, list, or delete memories.
---

# Cortadel: Bi-Temporal Graph Memory for AI Agents

Cortadel is a memory *engine*, not a vector-store-plus-LLM stapled together. It runs as one
self-hosted container (API + MCP + dashboard on `:3001`) backed by a graph database — FalkorDB or
Memgraph — and does the expensive work (fact extraction, dedup, entity/community summarization) at
**write time, off the request path**, so reads stay fast and call **no LLM at all**.

This repository ships the open extension surface: three published SDKs, this skill, docs, and
examples — all Apache-2.0. The server itself is a closed-core container image
(`ghcr.io/cortadel/cortadel`), free to self-host for personal/dev use.

## When to Use Cortadel

Reach for Cortadel when an agent or app needs memory that:

- **Persists across sessions** — recall what a user said last week, not just this context window.
- **Evolves instead of accumulating** — "forget the old address" should mutate the graph, not leave
  a stale fact sitting next to a new one.
- **Needs zero-glue-code wiring into an agent** — point Claude Code, Claude Desktop, Cursor, or any
  MCP client at one URL and it can read/write memory immediately.
- **Needs auditable history** — bi-temporal edges mean you can still ask what was true as of a past
  date, because superseded facts are invalidated, not deleted.
- **Must run on your own infrastructure** — self-hosted, dual graph backends, lossless per-user
  backup/export/import.

Do not reach for it as a general document/RAG store for arbitrary large files — the write path is
built around atomic, entity-centric facts (short memory text, conversation turns), not bulk
document ingestion.

## What Makes It Different

- **Bi-temporal graph, not append-only.** Every memory carries `valid_at`/`invalid_at`/
  `is_current`/`superseded_by`; edits supersede a memory instead of overwriting it, and the default
  view hides superseded history unless you ask for it (`include_superseded`) or query as of a past
  date (`as_of`) — see `references/architecture.md`.
- **Intent-aware writes.** Plain language is classified into one of five verbs — store, invalidate,
  delete-entity, touch, resolve — so "I moved to Berlin" and "forget my old address" both do the
  right thing without you picking an API for each.
- **Deduplication with a negation guard.** Near-duplicate candidates get an LLM verdict rather than
  a blind cosine cutoff, and a negation guard keeps "I like X" and "I don't like X" from collapsing
  into one memory.
- **Hybrid retrieval, zero-LLM reads.** BM25 + vector search fused with Reciprocal Rank Fusion, with
  an optional local cross-encoder rerank pass — all enrichment happened earlier, at write time.
- **Two ways in.** A typed REST API (and three SDKs over it) for direct integration, and an MCP
  Streamable-HTTP endpoint for zero-code agent wiring.

## Two Ways In

### 1. MCP — zero code, point an agent at a URL

```
http://<host>:3001/mcp/{clientName}/{userId}
```

No `/sse` segment. `{clientName}` becomes the memory's app name; `{userId}` must match the API
key's user or the server returns 403. Auth via `Authorization: Bearer <token>`, the `API_KEY`
header, or `?api_key=<token>` — omit entirely when the server has auth disabled (the default).

```json
{
  "mcpServers": {
    "cortadel": {
      "url": "http://localhost:3001/mcp/claude/alice",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Eight tools, no MCP resources or prompts: `add_memories`, `add_conversation`, `search_memory`,
`get_skill`, `add_media`, `reconcile_memories`, `reconcile_status`, `list_merge_suggestions`. See
`references/architecture.md` for what each does. For Claude Code specifically, this repo also ships
a zero-dependency hooks plugin (`clients/claude-code-plugin`) that auto-recalls on each prompt and
auto-captures at the end of a turn.

### 2. REST API + SDKs — typed, direct integration

Seven public operations (`spec/openapi.json`): health check, create/list/get/delete a memory,
search, and distill-a-conversation. All three SDKs are thin, typed wrappers over the same seven
calls, published at `1.0.0`:

| Language | Install | Client |
|---|---|---|
| .NET | `dotnet add package Cortadel.Sdk` | `new CortadelClient(baseUrl, userId, apiKey)` — positional |
| TypeScript | `npm install @cortadel/sdk` | `new CortadelClient({ baseUrl, userId, apiKey })` — options object |
| Python | `pip install cortadel` | `CortadelClient(base_url, user_id, ...)` (async) or `SyncCortadelClient` (blocking) — same seven methods on both |

## Quick Integration Examples

**.NET**
```csharp
using Cortadel.Sdk;

using var cortadel = new CortadelClient("http://localhost:3001", userId: "alice");

var created = await cortadel.AddAsync("Alice prefers dark mode and ships on Fridays.");
var hits = await cortadel.SearchAsync("what are alice's working preferences?", new() { TopK = 5 });
foreach (var h in hits.Results)
    Console.WriteLine($"{h.RrfScore:F2}  {h.Content}");
```

**TypeScript** (options object, not positional)
```ts
import { CortadelClient } from "@cortadel/sdk";

const cortadel = new CortadelClient({ baseUrl: "http://localhost:3001", userId: "alice" });

await cortadel.add("Alice prefers dark mode and ships on Fridays.");
const hits = await cortadel.search("what are alice's working preferences?", { topK: 5 });
for (const h of hits.results) console.log(h.rrfScore, h.content);
```

**Python**
```python
from cortadel import CortadelClient, SearchOptions

async with CortadelClient("http://localhost:3001", "alice") as cortadel:
    await cortadel.add("Alice prefers dark mode and ships on Fridays.")
    hits = await cortadel.search("what are alice's working preferences?", SearchOptions(top_k=5))
    for h in hits.results:
        print(h.rrf_score, h.content)
```

**REST directly** — every request is `user_id` (snake_case) on the wire:
```bash
curl -X POST http://localhost:3001/api/v1/memories \
  -H "content-type: application/json" \
  -d '{"user_id":"alice","text":"Alice prefers dark mode."}'
```

## Run a Server to Point At

```bash
curl -O https://raw.githubusercontent.com/cortadel/cortadel/main/docker-compose.yml
docker compose up   # batteries-included: graph DB + embeddings + LLM, CPU-only, dashboard on :3001
```

Bringing your own graph DB/embedding/LLM providers instead? See `references/quickstart.md` and
`docs/self-hosting.md` in this repo.

## Reference Documentation

- `references/quickstart.md` — server + SDK setup, store/recall/list/delete walkthrough, auth
- `references/api-reference.md` — every REST endpoint, request/response field, and error shape
- `references/sdk-guide.md` — every SDK method, option, model, and per-language caveat
- `references/architecture.md` — the write pipeline, event vocabulary, search pipeline, graph model
- `references/use-cases.md` — concrete integration patterns with working code

## Honest Limitations

Include these when advising integrators — they are the difference between a skill an agent can
trust and marketing copy:

- **Python SDK: `MemoryDetail.metadata` / `MemoryListItem.metadata` are always `None`.** The wire's
  `metadata_` field has no declared type in the OpenAPI schema, and Kiota's Python generator drops
  untyped properties instead of falling back to an untyped node the way the .NET/TS generators do.
  The .NET and TypeScript SDKs do not have this gap for these two models.
- **No `detail=summary|headline` search tier on the public surface.** The `token_budget` field's
  description references "whichever field the response's detail tier returns," but
  `SearchMemoriesRequest` has no `detail` parameter and `HybridSearchResult` has one text field
  (`content`) — there is no way to request a shorter summary/headline instead of full content today.
- **SDK `SearchOptions`/`ListOptions` are a strict subset of the wire request.** All three SDKs'
  `search()` only expose `top_k`, `mode`, `session_id`, `rerank`, `memory_type` — the wire-level
  `expand_query`, `include_faded`, `include_session_arm`, and `token_budget` exist in
  `SearchMemoriesRequest` but aren't reachable through any `1.0.0` SDK. Same story for `list()`'s
  `as_of` temporal filter. Call the REST API directly for any of these five fields.
- **`HealthResult.Checks` (.NET) silently drops undeclared check keys.** The OpenAPI contract marks
  the checks map and each check `additionalProperties: false`, so the Kiota-generated type the .NET
  client's pipeline deserializes through discards any check the schema doesn't already declare
  before it reaches `Checks`. TypeScript's and Python's `checks` are untyped dicts and don't have
  this gap.
- **`SearchHit.Extra` / `ConversationResult.Raw` / `HealthResult.Extra` (.NET) are always `null`**
  when the value came from `CortadelClient` — the client's own deserialization pipeline never
  attaches additional-data, even though the DTOs declare a `[JsonExtensionData]` bag.
- **This repo is the open extension surface, not the server.** The Cortadel engine itself ships as
  a closed-core container image; self-hosting is free for personal/dev use, commercial use needs a
  license (see `docs/self-hosting.md#licensing`).
- **REST search and REST list are two different envelopes**, not one search-vs-browse mode toggle —
  `POST /api/v1/memories/search` always returns `{query, results, total}`; `GET /api/v1/memories`
  is the paginated browse endpoint and returns `{items, page, pages, size, total}`. Don't assume a
  `mode` field switches one into the other.
