# Cortadel REST API Reference

The contract in `spec/openapi.json` — **seven public operations**, source of the three published
SDKs. Every field name below is verified against that file; the wire is **snake_case**.

## Base URL

There is no hosted public API — Cortadel is self-hosted. Point requests at wherever you run the
container, e.g. `http://localhost:3001`. Every path below is relative to that base.

## Authentication

Two security schemes, either accepted on every operation except health:

| Scheme | How |
|---|---|
| `bearerAuth` | `Authorization: Bearer <key>` |
| `apiKeyHeader` | `API_KEY: <key>` header |

(`?api_key=<key>` also works per `docs/authentication.md`, though it isn't modeled as a distinct
OpenAPI security scheme.) When the server's auth secret is empty (the default), no credentials are
required at all. `GET /api/health` carries no `security` requirement in the spec — it is always
open. A key is bound to one `userId`; a request whose `user_id` doesn't match the key's user is
rejected.

## Operations

### `Health_Check` — `GET /api/health`

Check service health including the graph database and embedding provider.

- **Auth**: none.
- **Response** `200` or `503` (both return the same `HealthResponse` shape — a degraded system
  still answers with useful detail, it just uses 503 as the status code):

```json
{
  "status": "ok",
  "checked_at": "2026-08-12T09:00:00Z",
  "checks": {
    "memgraph": { "ok": true, "url": "bolt://localhost:7687", "user": "", "latency_ms": 4, "error": null },
    "embeddings": { "ok": true, "provider": "ollama", "model": "intelli-embed-v3", "dim": 1024, "latency_ms": 12, "error": null },
    "indexes": { "ok": true, "model": "intelli-embed-v3", "provider_dim": 1024, "vector_indexes": ["Memory.embedding@1024"], "mismatches": [], "error": null }
  }
}
```

`status` is `"ok"` when every check passed, `"degraded"` otherwise. **The `checks` map key is
literally `"memgraph"`**, even when `Database:Provider=falkordb` — the schema doesn't rename the
key per backend. `HealthChecks` and every individual check schema declare
`additionalProperties: false`, so a client parsing strictly against the schema drops any check
key or field it doesn't already know about.

### `Memories_Create` — `POST /api/v1/memories`

Create a new memory for a user, with automatic deduplication.

- **Auth**: `bearerAuth` or `apiKeyHeader`.
- **Request body** (`CreateMemoryRequest`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string (1–50,000 chars) | yes | memory text to store |
| `user_id` | string (min 1 char) | yes | owning user |
| `app` | string, nullable | no | application name creating the memory |
| `infer` | boolean | no | `false` stores verbatim and skips background entity/category extraction; dedup still applies |
| `memory_type` | string, nullable | no | `episodic`\|`semantic`\|`procedural`; invalid/blank values are ignored and the server falls back to auto-classification |
| `metadata` | object, nullable | no | arbitrary key-value pairs |

```bash
curl -X POST http://localhost:3001/api/v1/memories \
  -H "content-type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"user_id":"alice","text":"Alice prefers dark mode.","infer":true}'
```

- **Response** `200` (`MemoryCreatedResponse`): `id`, `content`, `state`, `created_at` (ISO 8601
  string), `event`, `app_name`, and `metadata` — note this endpoint's `metadata` is a **plain
  nullable string** ("Metadata JSON string" per the schema description), unlike the untyped
  `metadata_` object field returned by list/get below.
- **Errors**: `400` `ValidationProblemDetails`, `401` `ErrorResponse`, `403` `ErrorResponse`
  (the only create-path-specific status besides the common three — a Forbidden case exists here
  that isn't modeled on list/search/delete), `500` `ErrorResponse`.

### `Memories_List` — `GET /api/v1/memories`

List memories with pagination, filtering, and optional text search. **This is the browse
endpoint** — a different envelope from `Memories_Search` below.

- **Auth**: `bearerAuth` or `apiKeyHeader`.
- **Query parameters**:

| Param | Required | Default | Notes |
|---|---|---|---|
| `user_id` | yes | — | |
| `app_id` | no | — | filter by application id |
| `categories` | no | — | comma-separated category names |
| `search_query` | no | — | optional text query for hybrid search *within* the list |
| `page` | no | `1` | |
| `size` | no | `10` | max 100 |
| `include_superseded` | no | — | `"true"` to include superseded memories |
| `as_of` | no | — | temporal filter for valid-at date |
| `memory_type` | no | — | `episodic`\|`semantic`\|`procedural`; invalid values ignored (no filter) |

- **Response** `200` (`MemoryListPagedResponse`): `items: MemoryListItemResponse[]`, `page`,
  `pages`, `size`, `total`. Each item: `id`, `content`, `created_at` (int64, Unix seconds), `state`,
  `app_id`, `app_name`, `categories`, `memory_type`, `is_current` (nullable), `is_global`,
  `valid_at`, `invalid_at`, `extraction_status` (`done`\|`pending`\|`failed`), `metadata_`
  (untyped — see the SDK reference for the per-language gap around this field).
- **Errors**: `400` `ValidationProblemDetails`, `401`, `500` (both `ErrorResponse`).

### `Memories_Get` — `GET /api/v1/memories/{memoryId}`

Get a single memory by its identifier.

- **Auth**: `bearerAuth` or `apiKeyHeader`.
- **Path**: `memoryId` (required). **Query**: `user_id` (optional here — falls back to a header if
  omitted, unlike every other operation where `user_id` is a required body/query field).
- **Response** `200` (`MemoryDetailResponse`): `id`, `text` (not `content` — this response uses a
  different field name than the list item), `state`, `app_id`, `app_name`, `categories`,
  `created_at` (int64, non-nullable), `is_current` (non-nullable here, unlike the list item's
  nullable version), `is_global`, `valid_at`, `invalid_at`, `superseded_by` (present here; absent
  from the list item shape), `metadata_`.
- **Errors**: `400` `ErrorResponse` — **note this operation uses `ErrorResponse` for its 400, not
  `ValidationProblemDetails` like every other operation in this spec** — `401`, `404`, `500`.

### `Memories_BulkDelete` — `DELETE /api/v1/memories`

Delete one or more memories by their identifiers.

- **Auth**: `bearerAuth` or `apiKeyHeader`.
- **Request body** (`DeleteMemoriesRequest`): `memory_ids` (array of string, min 1 item, required),
  `user_id` (required).
- **Response** `200` (`DeleteMemoriesResponse`): `message` — a confirmation string with the delete
  count, not a structured count field.
- **Errors**: `400` `ValidationProblemDetails`, `401`, `500` (both `ErrorResponse`).

### `Memories_Search` — `POST /api/v1/memories/search`

Search memories using hybrid vector + keyword search. **A different envelope from
`Memories_List`** — always returns ranked results, never a paginated browse shape.

- **Auth**: `bearerAuth` or `apiKeyHeader`.
- **Request body** (`SearchMemoriesRequest`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string (1–5,000 chars) | yes | natural-language search query |
| `user_id` | string (min 1) | yes | |
| `top_k` | int32 (1–50) | no | max results |
| `mode` | string, nullable | no | `hybrid`\|`text`\|`vector` |
| `rerank` | string, nullable | no | `cross_encoder` for LLM-free local reranking, or null/empty to skip |
| `app_name` | string, nullable | no | for access logging |
| `session_id` | string, nullable | no | restrict to a specific session |
| `memory_type` | string, nullable | no | invalid/blank values ignored (no filter) |
| `expand_query` | boolean | no | expand with LLM-generated synonyms before text search |
| `include_faded` | boolean | no | include normally-hidden faded/stale memories; no-op unless fading is enabled server-side |
| `include_session_arm` | boolean | no | also vector-search session summaries and expand top matches to member memories |
| `token_budget` | int32 (0–200,000) | no | `0` = unbounded (server may still apply its own default); a positive value trims the lowest-ranked results to fit, order never changed |

Note: **there is no `tags` field on this request** and **no `detail` field** — search cannot be
scoped by tag or asked for a shorter summary/headline tier on this surface (see
`SKILL.md`'s Honest Limitations).

```bash
curl -X POST http://localhost:3001/api/v1/memories/search \
  -H "content-type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"user_id":"alice","query":"working preferences","top_k":5,"rerank":"cross_encoder"}'
```

- **Response** `200` (`SearchResponse`): `query`, `results: HybridSearchResult[]`, `total`. Each
  result: `id`, `content`, `rrf_score` (double, non-nullable — the fused relevance score),
  `text_rank` / `vector_rank` (nullable int32, per-arm rank before fusion), `categories`, `tags`,
  `memory_type`, `app_name`, `project_id`, `source`, `global` (boolean — **wire name is `global`
  here**, not `is_global`; see the SDK reference for the cross-schema inconsistency), `gist`,
  `attributes` (object), `member_ids` / `similar_ids` (arrays), `created_at`.
- **Errors**: `400` `ValidationProblemDetails`, `401`, `500` (both `ErrorResponse`).

### `Memories_FromConversation` — `POST /api/v1/memories/from-conversation`

Distill a multi-turn conversation into atomic facts and store each one, applying the same intent
classification, deduplication, and background entity extraction as `Memories_Create`. On empty
extraction, nothing is stored — no raw un-atomized turns are persisted.

- **Auth**: `bearerAuth` or `apiKeyHeader`.
- **Request body** (`AddConversationRequest`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `messages` | array of `ConversationMessageItem` (1–500 items) | yes | conversation turns, in order |
| `user_id` | string (min 1) | yes | |
| `is_agent_memory` | boolean | no | when true, extract facts about the assistant instead of the user; default false |
| `project` | string, nullable | no | optional project scope, e.g. a repo name |
| `session_id` | string, nullable | no | groups these facts under an existing `:CONTAINS` session path |
| `tags` | array of string, nullable | no | applied to *every* fact stored from this conversation — **this is the only create-path operation with a `tags` field**; `Memories_Create` has no `tags` parameter |
| `transcript_path` | string, nullable | no | stored verbatim as the `transcript_path` attribute on every extracted fact |

Each `ConversationMessageItem`: `content` (1–50,000 chars, required), `role` (1–20 chars, required
— `"user"`, `"assistant"`, or `"system"`), `uuid` (nullable — when present, facts extracted from
this turn carry it in `source_turn_uuids`).

- **Response** `200` (`ConversationIngestResponse`): **mutually exclusive on the wire** —
  `no_facts_extracted: true` when nothing was distilled, or `results: ConversationIngestItem[]`
  when facts were stored, never both (both fields are nullable so the server's
  `DefaultIgnoreCondition = WhenWritingNull` drops the unset one). Each `ConversationIngestItem`:
  `id` (empty when the pipeline event carries none, e.g. `ERROR`/`INVALIDATE`), `memory`, `event`,
  `error` (present only when `event` is `ERROR` or another failed branch).
- **Errors**: `400` `ValidationProblemDetails`, `401`, `500` (both `ErrorResponse`).

## Error Shapes

Two distinct error schemas appear across operations — check which one an endpoint returns before
parsing:

**`ErrorResponse`** (RFC 7807-inspired, used for 401/403/404/500, and for `Memories_Get`'s 400):

```json
{ "status": 401, "code": "unauthorized", "message": "...", "detail": null }
```

`code` is a short machine-readable string (e.g. `not_found`, `validation_error`,
`internal_error`); `detail` carries a stack trace only outside production.

**`ValidationProblemDetails`** (standard ASP.NET Core problem-details shape, used for 400 on every
operation except `Memories_Get`):

```json
{ "type": "...", "title": "...", "status": 400, "detail": "...", "instance": "...", "errors": { "text": ["required"] } }
```

`errors` maps field names to arrays of validation messages. The schema allows arbitrary additional
properties beyond the ones listed.

## Status Codes Observed in the Spec

| Code | Meaning | Where |
|---|---|---|
| 200 | OK | every successful operation |
| 400 | Bad Request | validation failure (all operations) |
| 401 | Unauthorized | missing/invalid credentials |
| 403 | Forbidden | `Memories_Create` only |
| 404 | Not Found | `Memories_Get` only |
| 500 | Internal Server Error | any operation |
| 503 | Service Unavailable | `Health_Check` when degraded |

## SDK vs. Direct API

Prefer one of the published SDKs (`references/sdk-guide.md`) for typed request/response models,
built-in error mapping (`CortadelException`/`CortadelError`), and the field-name normalization they
apply (e.g. `isGlobal` unified across the three schemas that spell it differently on the wire).
Call the REST API directly when integrating from a language without a published SDK, or when you
need a capability the SDK's frozen public surface doesn't expose yet.
