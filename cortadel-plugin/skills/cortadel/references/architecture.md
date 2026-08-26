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
some are auto-approved, and the rest sit in a review queue. Three MCP tools drive this from an
agent: `reconcile_memories` (kick off a run), `reconcile_status` (poll it), and
`list_merge_suggestions` (review pending duplicate-entity suggestions) — see `docs/mcp.md`. There
is no equivalent REST endpoint in `spec/openapi.json`; reconciliation is reachable via MCP (and
presumably the dashboard), not the public REST/SDK surface.

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

The MCP endpoint (`http://<host>:3001/mcp/{clientName}`, no `/sse` segment) exposes eight
tools and no MCP resources or prompts (`docs/mcp.md`):

| Tool | What it does |
|---|---|
| `add_memories` | Store one or more memories (intent-aware: remember / forget / resolve). |
| `add_conversation` | Distill atomic facts from a transcript and store them. |
| `search_memory` | Hybrid search (BM25 + vector + RRF, optional rerank). |
| `get_skill` | Retrieve a learned procedural skill. |
| `add_media` | Ingest an image/document (multimodal). |
| `reconcile_memories` | Kick off entity reconciliation (merge/supersede duplicates). |
| `reconcile_status` | Poll a running reconciliation. |
| `list_merge_suggestions` | Review pending duplicate-entity suggestions. |

Some of this surface — `get_skill`, `add_media`, and the reconciliation tools — has **no REST/SDK
equivalent** in `spec/openapi.json`. The seven REST operations cover create/list/get/delete/search
for plain memories and conversation ingestion only; multimodal ingestion, skill retrieval, and
reconciliation are MCP-only today. Pick MCP over the SDK when you need one of these.

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

Communities (hierarchical Louvain clustering, per `README.md`'s comparison table), the dashboard
UI, and the reconciliation review flow beyond the three MCP tools above are part of the product but
have no corresponding operation in `spec/openapi.json`. If you're integrating purely against the
REST API or an SDK, treat those as out of reach; they're reachable via MCP or the dashboard, not
the typed client surface documented in `references/sdk-guide.md`.
