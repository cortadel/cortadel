---
title: Python SDK reference
description: Every method, option, and model in the cortadel Python client.
---

`cortadel` is a thin, typed client over the Cortadel REST API. It targets **Python 3.10+** and
ships two facades: a real async client and a real blocking client.

```bash
pip install cortadel
# or: uv add cortadel / poetry add cortadel
```

## Construct a client

Reuse a single client — it wraps one `httpx.AsyncClient`. Every call carries the `user_id` you pass
in; when a key is present the server overwrites it with the key's user, so it is authoritative only
on an auth-disabled server. See [Authentication](/authentication/#user-scoping).

```python
from cortadel import CortadelClient

# as a context manager (recommended)
async with CortadelClient("http://localhost:3001", "alice") as cortadel:
    ...

# or manually
cortadel = CortadelClient(
    "http://localhost:3001",
    "alice",
    api_key=None,          # omit when auth is disabled
    app_name="my-app",     # recorded on searches
    timeout=100.0,         # seconds; default 100
)
...
await cortadel.aclose()

# bring your own httpx.AsyncClient (e.g. custom proxy/TLS)
import httpx
async with httpx.AsyncClient(proxy="http://proxy.internal:8080") as http_client:
    cortadel = CortadelClient("http://localhost:3001", "alice", http_client=http_client)
```

Need a blocking client instead (e.g. a non-async script)? `SyncCortadelClient` exposes the same
seven methods without `async`/`await` — see [Sync vs. async](#sync-vs-async) below.

```python
from cortadel import SyncCortadelClient

with SyncCortadelClient("http://localhost:3001", "alice") as cortadel:
    cortadel.add("Alice prefers dark mode.")
```

Constructor parameters (identical for both clients):

| Parameter | Default | Notes |
|---|---|---|
| `base_url` *(required)* | — | e.g. `http://localhost:3001` |
| `user_id` *(optional)* | — | optional; omit it and the server resolves identity from the API key. Still required on an auth-disabled server, where it selects the namespace. |
| `api_key` | `None` | bearer token; omit when auth is off |
| `app_name` | `cortadel-python` | app label on searches |
| `http_client` | owned `httpx.AsyncClient` | bring your own; **never mutated** — the bearer token is attached per-request instead of on shared headers, so a caller-supplied client stays safe to reuse elsewhere |
| `timeout` | `100.0` seconds | generous for reranked search. **No-op if you pass your own `http_client`** — set the timeout on that client yourself instead |

## Methods

Both clients expose the same seven methods (`async def` on `CortadelClient`, blocking on
`SyncCortadelClient`).

### `add(text, options=None)` → `MemoryCreated`

Store a memory. The server extracts entities/categories in the background and runs dedup.

```python
from cortadel import AddOptions

created = await cortadel.add(
    "Alice prefers dark mode.",
    AddOptions(
        app="my-app",
        metadata={"source": "settings"},
        infer=True,               # False = store verbatim, skip extraction
        memory_type="semantic",   # episodic | semantic | procedural
    ),
)
print(created.id, created.event)   # e.g. ADD or SKIP_DUPLICATE
```

### `add_conversation(messages, options=None)` → `ConversationResult`

Distill atomic facts from a transcript.

```python
from cortadel import ChatMessage, ConversationOptions

result = await cortadel.add_conversation(
    [
        ChatMessage(role="user", content="I moved to Berlin.", uuid="turn-1"),
        ChatMessage(role="assistant", content="Noted — Berlin."),
    ],
    ConversationOptions(session_id="sess-42", tags=["onboarding"]),
)
print(
    "no facts extracted"
    if result.no_facts_extracted
    else f"stored {len(result.results or [])} fact(s)"
)
```

### `search(query, options=None)` → `SearchResults`

Hybrid search (BM25 + vector fused with RRF).

```python
from cortadel import SearchOptions

hits = await cortadel.search(
    "what are alice's preferences?",
    SearchOptions(top_k=10, mode="hybrid", rerank="cross_encoder"),  # omit rerank to skip it
)
for h in hits.results:
    print(h.rrf_score, h.content)
```

### `list(options=None)` → `MemoryList`

Paginated, newest-first. `options.size` defaults to **20** (kept in sync with the .NET/TypeScript
SDKs — the REST contract's own default is 10).

```python
from cortadel import ListOptions

page = await cortadel.list(ListOptions(page=1, size=20, categories="preferences"))
print(page.total, "total,", page.pages, "pages")
```

### `get(memory_id)` → `MemoryDetail | None`

Returns `None` when the memory doesn't exist. The content field is `.text`.

```python
m = await cortadel.get(memory_id)
if m is not None:
    print(m.text)
```

### `delete(memory_ids)` → `str`

```python
message = await cortadel.delete([id1, id2])
```

### `health()` → `HealthResult`

```python
health = await cortadel.health()
print(health.status)   # ok | degraded
```

`health()` does **not** raise when the server reports itself degraded (HTTP 503 with a
`{"status":"degraded",...}` body) — it catches that response and returns it like any other, so a
degraded server is a normal return value, not an exception. `CortadelError` is still raised for
every other non-success response.

## Error handling

Any non-success response — **other than a degraded (503) health check, which `health()` returns
instead of raising (see above)** — raises `CortadelError`:

```python
from cortadel import CortadelClient, CortadelError

async with CortadelClient("http://localhost:3001", "alice") as cortadel:
    try:
        await cortadel.add("")
    except CortadelError as err:
        print(err.status, err.code, err.message)
```

| Attribute | Meaning |
|---|---|
| `status` | HTTP status. `0` when the transport failed before a status was known |
| `code` | machine-readable error code |
| `message` | human-readable message — a `400` model-validation failure folds the per-field errors in |

`asyncio.CancelledError` is a `BaseException`, not caught by the SDK's error handling, so it always
propagates untouched instead of becoming a `CortadelError`.

## Models at a glance

- `MemoryCreated` — `id`, `content`, `state`, `created_at` (ISO 8601 string on this endpoint —
  list/detail return Unix seconds instead), `event`, `app_name`.
- `SearchResults` — `query`, `results: list[SearchHit]`, `total`.
- `SearchHit` — `id`, `content`, `rrf_score`, `categories`, `memory_type`, `tags`, `source`,
  `is_global`, plus `attributes`.
- `MemoryList` / `MemoryListItem` — paginated list (`created_at` is Unix seconds).
- `MemoryDetail` — single memory; note the content field is `.text`. `.metadata` is always `None`
  from `CortadelClient` today — the wire's `metadata_` field has no declared type in the OpenAPI
  schema, and Kiota's Python generator drops properties with no declared type rather than falling
  back to an untyped node the way the .NET/TypeScript generators do.
- `ConversationResult` — `results: list[ConversationIngestItem] | None`, `no_facts_extracted`. The
  two are mutually exclusive on the wire: the server sends `results` when it distilled facts,
  `no_facts_extracted = True` when it didn't, never both.
- `HealthResult` — `status` (`ok` | `degraded`), `checked_at`, `checks` (a loosely-typed dict keyed
  by dependency name — `memgraph`, `embeddings`, `indexes` today).

## Sync vs. async

`SyncCortadelClient` is a *real* blocking client, not `asyncio.run(...)` called once per method. A
single dedicated background thread runs one persistent event loop for the client's entire
lifetime, so keep-alive connections are reused across calls exactly like the async client.
`asyncio.run(...)` per call would tear the connection pool down on every invocation, and would
raise outright if called from a thread that already has a running event loop (e.g. from inside an
async application). `close()` — or exiting the `with` block — closes the client on its own loop
first, then stops the loop and joins the background thread, so nothing outlives it.

## Supported surface

Only `CortadelClient`, `SyncCortadelClient`, and the types exported from `cortadel/__init__.py` are
covered by SemVer. Nothing under `cortadel._generated` is part of the public surface — it's
unversioned Kiota-generated transport code and can change shape (including type removals/renames)
across any release, including patch releases.
