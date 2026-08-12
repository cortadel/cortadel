# Cortadel — LLM orientation

A single-file, self-contained brief for any LLM/agent that wants to **use** Cortadel — add memory
to an app or agent — as opposed to contributing to this repository (for that, see
[`AGENTS.md`](AGENTS.md) / [`CONTRIBUTING.md`](CONTRIBUTING.md)). Every code example below is
checked against the actual SDK source under `sdk/*/`, not hand-typed from memory.

## What Cortadel is

Cortadel is a **bi-temporal graph memory engine** for AI agents — not a vector store with an LLM
stapled on top. It runs as one server (REST API + MCP endpoint + dashboard) backed by a graph
database (FalkorDB or Memgraph). Facts are extracted from text/conversations at **write time**,
off the request path: intent classification (store / invalidate / delete-entity / touch /
resolve), LLM-verified deduplication with a negation guard, and entity/relationship extraction.
Reads are BM25 + vector search fused with Reciprocal Rank Fusion, with an optional local
cross-encoder rerank — **zero LLM calls on the read path**.

This repository (`cortadel/cortadel`) is Cortadel's open extension surface — three published
SDKs, a Claude Code/Codex plugin, an agent skill, and docs — all Apache-2.0. The server itself
(the engine + dashboard container) is closed-core; free to self-host for personal/dev use, a
commercial license is required for business use (see `docs/self-hosting.md`).

## Two deployment paths

Everything below — REST, MCP, all three SDKs — takes a `base_url`/`baseUrl` and is identical
against either target; only the URL changes:

1. **Hosted** — `https://app.cortadel.ai`, the live Cortadel service. Get an API key from its
   dashboard.
2. **Self-hosted** — run the container yourself:
   ```bash
   docker run -p 3001:3001 ghcr.io/cortadel/cortadel:latest
   ```
   or the batteries-included compose (graph DB + embeddings + LLM, CPU-only):
   ```bash
   curl -O https://raw.githubusercontent.com/cortadel/cortadel/main/docker-compose.yml
   docker compose up
   ```
   Default `base_url`: `http://localhost:3001`. See `docs/self-hosting.md` for bringing your own
   graph DB / embedding / LLM providers.

Auth (both paths): `Authorization: Bearer <token>`, the `API_KEY` header, or `?api_key=<token>` —
self-hosted defaults to auth **disabled** (empty secret); the hosted service requires a key.

## REST API — seven operations

Defined in `spec/openapi.json`. Every request/response field is `snake_case` on the wire.

| Method | Path | Operation | What it does |
|---|---|---|---|
| `GET` | `/api/health` | `Health_Check` | Unauthenticated health probe. Returns `ok` \| `degraded`; body has a `checks` map (e.g. `checks.memgraph.ok`, `checks.embeddings.ok`) — a `degraded`/503 response is a normal, non-exceptional outcome to handle, not necessarily an error. |
| `POST` | `/api/v1/memories` | `Memories_Create` | Store one memory. Body: `{"user_id": "...", "text": "..."}` plus optional `app`, `infer`, `memory_type`, `metadata`. Response includes `event` (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, `TOUCH`, `RESOLVE`, `INVALIDATE`, `DELETE_ENTITY`, `ERROR`) — a `200` does **not** always mean a new memory was written; check `event`. |
| `GET` | `/api/v1/memories` | `Memories_List` | Paginated browse: `{items, page, pages, size, total}` — a **different envelope** from search. Filters include `categories`, `include_superseded`, `memory_type`, and (wire-only, not yet in any SDK) `as_of` for a point-in-time view. |
| `GET` | `/api/v1/memories/{memoryId}` | `Memories_Get` | Fetch one memory's full detail, including `superseded_by` if it's been superseded. |
| `DELETE` | `/api/v1/memories` | `Memories_BulkDelete` | Delete by id list. |
| `POST` | `/api/v1/memories/search` | `Memories_Search` | Hybrid search: `{query, results, total}` — the **other** envelope, not the same shape as list. Options include `top_k`, `mode`, `session_id`, `rerank` (`"cross_encoder"` for the local reranker), `memory_type`. |
| `POST` | `/api/v1/memories/from-conversation` | `Memories_FromConversation` | Distill atomic facts from a chat transcript (`messages: [{role, content}, ...]`) instead of hand-writing memory text. Empty extraction returns `{"no_facts_extracted": true}` instead of `results` — the two are mutually exclusive on the wire. |

## MCP — zero-code agent wiring

One Streamable-HTTP endpoint, **no `/sse` segment**:

```
<base_url>/mcp/{clientName}/{userId}
```

`{clientName}` becomes the memory's app name; `{userId}` is the memory namespace and must match
the API key's user (403 otherwise). Example (self-hosted):

```json
{
  "mcpServers": {
    "cortadel": {
      "type": "http",
      "url": "http://localhost:3001/mcp/claude/alice",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

For the hosted service, use `"url": "https://app.cortadel.ai/mcp/claude/alice"` instead — same
shape. Eight tools, no MCP resources or prompts: `add_memories`, `add_conversation`,
`search_memory`, `get_skill`, `add_media`, `reconcile_memories`, `reconcile_status`,
`list_merge_suggestions`. Full detail: `docs/mcp.md`.

For Claude Code/Codex specifically, this repo also ships a packaged plugin
(`cortadel-plugin/`, `cortadel-memory`) with push-recall/session-bootstrap/auto-capture
hooks in addition to this same MCP server — see `docs/plugin.md`.

## Three SDKs — real install commands and constructors

All three are thin, typed facades over a Kiota-generated transport, published at `1.0.0`, and
**intentionally divergent in constructor shape per language's own idiom** — don't assume one
language's calling convention for another:

### .NET — `Cortadel.Sdk` (positional convenience constructor)

```bash
dotnet add package Cortadel.Sdk
```

```csharp
using Cortadel.Sdk;

using var cortadel = new CortadelClient("http://localhost:3001", userId: "alice", apiKey: null);

var created = await cortadel.AddAsync("Alice prefers dark mode and ships on Fridays.");
var hits = await cortadel.SearchAsync("what are alice's working preferences?", new() { TopK = 5 });
foreach (var h in hits.Results)
    Console.WriteLine($"{h.RrfScore:F2}  {h.Content}");
```

A full-options constructor also exists: `new CortadelClient(new CortadelClientOptions { BaseUrl =
..., UserId = ..., ApiKey = ... }, httpClient)`.

### TypeScript — `@cortadel/sdk` (options object — never positional)

```bash
npm install @cortadel/sdk   # ESM-only, Node >= 20
```

```ts
import { CortadelClient } from "@cortadel/sdk";

const cortadel = new CortadelClient({ baseUrl: "http://localhost:3001", userId: "alice" });

const created = await cortadel.add("Alice prefers dark mode and ships on Fridays.");
const hits = await cortadel.search("what are alice's working preferences?", { topK: 5 });
for (const h of hits.results) console.log(h.rrfScore, h.content);
```

`CortadelOptions` also accepts `apiKey`, `appName` (default `"cortadel-typescript"`), and a custom
`fetch` implementation.

### Python — `cortadel` (async client + a separate sync client, same seven methods on both)

```bash
pip install cortadel   # targets Python 3.10+
```

```python
from cortadel import CortadelClient, SearchOptions

async with CortadelClient("http://localhost:3001", "alice") as cortadel:
    await cortadel.add("Alice prefers dark mode and ships on Fridays.")
    hits = await cortadel.search("what are alice's working preferences?", SearchOptions(top_k=5))
    for h in hits.results:
        print(h.rrf_score, h.content)
```

Blocking script, no event loop of your own? Use `SyncCortadelClient` — identical constructor and
method set, backed by its own background event-loop thread (not `asyncio.run()` per call):

```python
from cortadel import SyncCortadelClient

with SyncCortadelClient("http://localhost:3001", "alice") as cortadel:
    cortadel.add("Alice prefers dark mode.")
```

Both Python constructors take `base_url`, `user_id` positionally, then keyword-only `api_key`,
`app_name` (default `"cortadel-python"`), `http_client`, `timeout`.

### All seven SDK methods (same set, per-language naming convention)

`add`/`AddAsync`, `add_conversation`/`AddConversationAsync`, `search`/`SearchAsync`,
`list`/`ListAsync`, `get`/`GetAsync`, `delete`/`DeleteAsync`, `health`/`HealthAsync` — camelCase in
TypeScript, PascalCase+Async in .NET, snake_case in Python.

## Honest gaps (don't overclaim these)

- **SDK `SearchOptions`/`ListOptions` are a strict subset of the wire request.** `top_k`, `mode`,
  `session_id`, `rerank`, `memory_type` are reachable through `search()`; the wire's
  `expand_query`, `include_faded`, `include_session_arm`, `token_budget` (search) and `as_of`
  (list) are not exposed by any `1.0.0` SDK — call `POST /api/v1/memories/search` directly for
  those.
- **Python's `MemoryDetail.metadata`/`MemoryListItem.metadata` are always `None`** — the wire's
  untyped `metadata_` field is dropped by Kiota's Python generator; .NET/TypeScript don't have
  this gap.
- **.NET's `SearchHit.Extra`/`ConversationResult.Raw`/`HealthResult.Extra` are always `null`**,
  and `HealthResult.Checks` silently drops any check key the OpenAPI schema doesn't declare
  (`additionalProperties: false` in the contract) — TypeScript's/Python's `checks` are untyped
  dicts and don't have this gap.
- **List and search are different envelopes** (`{items, page, pages, size, total}` vs.
  `{query, results, total}`) — there's no single `mode` flag that switches one into the other.

## Where things live

| Path | What |
|---|---|
| `sdk/dotnet/`, `sdk/typescript/`, `sdk/python/` | The three published SDKs (facade + generated transport each). |
| `spec/openapi.json` | The REST contract every SDK is generated from. |
| `cortadel-plugin/` | The Claude Code/Codex plugin, including the `cortadel` skill under `skills/cortadel/`. |
| `docs/`, `website/` | Hand-written docs and their Starlight-site mirror (see `AGENTS.md` — they must be updated together). |
| `examples/` | Runnable sample projects. |

For contributing to any of the above — build/test commands, the generated-code rule, docs/website
mirror rule, conformance suites — see [`AGENTS.md`](AGENTS.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md).
