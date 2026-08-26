# Cortadel Architecture

How Cortadel turns raw text into a queryable graph, and why reads never touch an LLM.

## One Container, One Port

The server is a single .NET 10 process (per `docs/self-hosting.md`) that serves the REST API, the
MCP endpoint, Swagger, and the dashboard on `:3001`, backed by one of two pluggable graph
databases — **FalkorDB** or **Memgraph**. Three external dependencies are required (none of them
bundled unless you use the batteries-included `docker-compose.yml`): a graph database, an
embedding provider (Ollama, LM Studio, or Azure OpenAI), and an LLM provider used **only at write
time** (fact extraction, dedup verdicts, entity/community summaries) — reads never call it. The
cross-encoder reranker (`bge-reranker-v2-m3`, int8) ships **inside the image** and runs on CPU, so
it needs no external service.

This `cortadel/cortadel` repository ships the SDKs, docs, and this skill — the memory engine itself
is a closed-core container image (`ghcr.io/cortadel/cortadel`).

## Write Pipeline

Per the repo's own architecture summary (`README.md`): a write — a single memory or a whole
conversation — moves through **classify intent → dedup + contradiction check → write to the
temporal graph → background entity/relation extraction → community + reconciliation updates**. The
last two stages run asynchronously; the write call itself returns as soon as the memory is durably
stored, before extraction runs.

### Intent Classification

Plain-language text is classified into an intent rather than always appending. The repo's
comparison table (`README.md`) advertises **five verbs**: **store**, **invalidate**, **delete**
(entity), **touch**, and **resolve** — so "I moved to Berlin" stores a fact, while "forget my old
address" or "the bug is resolved" mutate the graph instead of leaving a stale fact next to a new
one.

The `event` field on `Memories_Create`'s and `Memories_FromConversation`'s responses surfaces which
branch fired. `spec/openapi.json` names three literal values directly in its schema descriptions —
`ADD`, `SKIP_DUPLICATE`, and `ERROR` — as the confirmed examples for that field; it's declared as a
plain nullable string, not a closed enum, so the exact tokens the other four intent branches emit
are not spelled out in the public contract. Always branch on the string you actually get back
rather than assuming a fixed set at compile time — and never assume a `200`/`event: ADD` pair means
a *new* memory was created; `SKIP_DUPLICATE` is also a normal, successful outcome.

### Deduplication

Per the repo's own capability comparison (`README.md`): dedup is **vector + LLM verdict + negation
guard** — not a hash or a blind cosine cutoff. A vector-similar candidate gets an LLM judgment
rather than an automatic merge, and a negation guard exists specifically so that semantically
similar-but-opposite facts (e.g., a preference and its negation) don't collapse into one memory.

### Entity Reconciliation

A separate, later-stage process merges duplicate entities and supersedes stale ones. It's
described as **reversible and human-in-the-loop** (`README.md`) — an LLM judge proposes merges,
some are auto-approved, and the rest sit in a review queue. This is driven over **REST**, not MCP —
it was exposed as three MCP tools until 2026-08-21, when the MCP surface was folded to two.
`EntitiesController` (`[Route("api/v1/entities")]`) carries the routes: `POST`/`GET`/`DELETE
/api/v1/entities/reconcile` to start, poll and cancel a run, `GET /api/v1/entities/suggestions` to
review the queue, `POST /api/v1/entities/suggestions/{id}/approve|reject` to act on one, and
`POST /api/v1/entities/merges/{loserId}/unmerge` to reverse a merge. The plugin's `reconcile` skill
drives these through `scripts/reconcile.mjs`.

## Bi-Temporal Data Model

`MemoryDetailResponse` (per `spec/openapi.json`) carries `valid_at`, `invalid_at`,
`superseded_by`, and `is_current` on every memory — the schema-level evidence for the bi-temporal
claim in `README.md`: edits **supersede** a memory (set `invalid_at` and point `superseded_by` at
the replacement) rather than overwriting it in place, so a superseded fact is still retrievable,
just no longer current. `Memories_List` accepts an `as_of` query parameter for a "temporal filter
for valid-at date," and an `include_superseded` flag to opt into seeing history instead of only the
live view — both directly in the contract, giving API-level support for "what did the graph
believe as of a past date."

## Read / Search Pipeline

`Memories_Search` (`POST /api/v1/memories/search`) is hybrid by default: BM25 text search and
vector similarity, fused with **Reciprocal Rank Fusion** — the `rrf_score` field on every
`HybridSearchResult` is that fused score, and `text_rank`/`vector_rank` expose each arm's
pre-fusion position. `mode` narrows this to `text`-only or `vector`-only when you want a single
arm. Setting `rerank: "cross_encoder"` adds a local reranking pass over the fused candidates using
the bundled bge-reranker-v2-m3 model — still no LLM call, since the reranker is a small
cross-encoder, not a generative model. `expand_query` is the one flag that *does* call an LLM
(to generate synonyms before text search); every other search flag stays on the zero-LLM path.
`include_session_arm` additionally vector-searches session summaries and expands top matches to
member memories — useful when memories are fine-grained (per-turn) and the right episode is spread
across many small candidates. `token_budget` trims the ranked result list to an estimated token
ceiling, dropping the lowest-ranked results first without ever reordering what's left.

Because all the expensive semantic work (extraction, dedup, embeddings) already happened at write
time, the search request itself does not need an LLM in the loop — matching the "zero-LLM read
path" claim made throughout `README.md` and `docs/self-hosting.md`.

## Two Distinct Read Envelopes

`Memories_Search` and `Memories_List` are separate operations with separate response shapes — not
one endpoint with a mode switch:

- `POST /api/v1/memories/search` → `{query, results: HybridSearchResult[], total}` — ranked,
  relevance-scored, driven by a natural-language `query`.
- `GET /api/v1/memories` → `{items: MemoryListItemResponse[], page, pages, size, total}` — a
  paginated browse view, newest-first, filterable by `categories`, `app_id`, `memory_type`,
  `include_superseded`, `as_of`, and (confusingly named, but real) an optional `search_query` for
  hybrid search *within* the browse listing.

## Graph Providers

`Database:Provider` selects `falkordb` (the recommended default per `docs/self-hosting.md`) or
`memgraph`. Memgraph needs `--experimental-enabled=text-search` enabled for its BM25 full-text
search. Both backends are wired behind the same REST/MCP surface — nothing about the public
contract in `spec/openapi.json` changes based on which one is running underneath, except that the
health response's dependency-check key is always literally `"memgraph"` regardless of the actual
provider (see `references/api-reference.md`).

## MCP Surface

The MCP endpoint (`http://<host>:3001/mcp/{clientName}`, no `/sse` segment) exposes exactly **two**
tools and no MCP resources or prompts (`docs/mcp.md`). Six earlier tools were folded into them on
2026-08-21; the capabilities did not go away, they moved.

| Tool | What it does |
|---|---|
| `add_memories` | Store one or more memories (intent-aware: remember / forget / resolve). Each item in the array is auto-classified — plain text, a `"role: content"` conversation turn distilled into atomic facts, or an image URL / data-URI / base64. |
| `search_memory` | Hybrid search (BM25 + vector + RRF, optional rerank), or chronological browse with no query. Procedural queries inline the top learned skill as `primary_skill`; `ids: ["skill:<id>"]` expands one. |

| Folded tool | Reach it now via |
|---|---|
| `add_conversation` | `add_memories` — `"role: content"` items |
| `add_media` | `add_memories` — image URL / data-URI / base64 items |
| `get_skill` | `search_memory` — `primary_skill`, or `ids: ["skill:<id>"]` |
| `reconcile_memories` · `reconcile_status` · `list_merge_suggestions` | REST on `/api/v1/entities/*` — never MCP |

## Data Flow Summary

```
Write (async after the call returns):
  text / conversation turns
    -> classify intent (store | invalidate | delete-entity | touch | resolve)
    -> dedup + contradiction check (vector candidates -> LLM verdict -> negation guard)
    -> write/supersede in the temporal graph
    -> [background] extract entities & relations
    -> [background] community + reconciliation updates

Read (synchronous, zero LLM calls unless expand_query is set):
  query
    -> BM25 arm + vector arm
    -> Reciprocal Rank Fusion
    -> optional local cross-encoder rerank
    -> optional token-budget trim
    -> ranked HybridSearchResult[]
```

## What's Not in the Public Contract

Communities (hierarchical Louvain clustering, per `README.md`'s comparison table) and the dashboard
UI are part of the product but have no corresponding operation in `spec/openapi.json`. If you're
integrating purely against a typed SDK, treat those as out of reach.

Reconciliation is **not** in that category: it is fully REST-reachable on `/api/v1/entities/*`
(see Entity Reconciliation above). It is simply absent from `spec/openapi.json` and therefore from
the generated SDKs, so call it directly rather than assuming it is unavailable.
