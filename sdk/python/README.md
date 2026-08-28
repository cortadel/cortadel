# cortadel

Official Python SDK for [**Cortadel**](https://github.com/cortadel/cortadel) — self-hosted
long-term temporal graph memory for AI agents. A thin, typed client over the Cortadel REST API.

```bash
pip install cortadel
# or: uv add cortadel / poetry add cortadel
```

Python ≥ 3.10. Ships two facades: an async client and a real blocking client — pick whichever
fits your program.

## Quickstart (async)

```python
import asyncio
from cortadel import ChatMessage, CortadelClient, SearchOptions

async def main() -> None:
    # "alice" is the user_id. It is optional against a server with auth enabled — the API key
    # already says who you are — but required here, because a local auth-disabled server has
    # nothing else to scope memories by. See "User scoping (user_id)" below.
    async with CortadelClient("http://localhost:3001", "alice") as cortadel:
        # apiKey: pass api_key="<token>" — omit when the server runs with auth disabled

        # Store
        await cortadel.add("Alice prefers dark mode and ships on Fridays.")

        # Recall (hybrid BM25 + vector + RRF)
        hits = await cortadel.search("what are alice's preferences?", SearchOptions(top_k=5))
        for h in hits.results:
            print(h.rrf_score, h.content)

        # Ingest a conversation
        await cortadel.add_conversation([
            ChatMessage(role="user", content="I'm allergic to peanuts."),
            ChatMessage(role="assistant", content="Noted — I'll avoid peanut recipes."),
        ])

        # List / get / delete
        page = await cortadel.list()
        one = await cortadel.get(page.items[0].id)
        await cortadel.delete([page.items[0].id])

asyncio.run(main())
```

## Quickstart (blocking)

```python
from cortadel import SyncCortadelClient

with SyncCortadelClient("http://localhost:3001", "alice") as cortadel:
    cortadel.add("Alice prefers dark mode and ships on Fridays.")
    hits = cortadel.search("what are alice's preferences?")
    for h in hits.results:
        print(h.rrf_score, h.content)
```

`SyncCortadelClient` is a *real* blocking client, not `asyncio.run(...)` called once per method —
see `cortadel/sync_client.py`'s module docstring for why that distinction matters (connection-pool
reuse, and correctness when called from a thread that already has a running event loop) and how it
is implemented (one persistent background event loop, for the client's lifetime).

## Auth

Pass `api_key` in either constructor and every request carries `Authorization: Bearer <key>`. Omit
it (or leave it `None`) when the server runs with auth disabled — no header is sent, and the
client never mutates an `httpx.AsyncClient` you bring in either way.

```python
import os
from cortadel import CortadelClient

cortadel = CortadelClient("https://my-box:3001", "alice", api_key=os.environ.get("CORTADEL_API_KEY"))
```

Reuse a single client per base URL + user.

## User scoping (`user_id`)

`user_id` is the second constructor argument on both clients, and it is **optional**:

```python
# Auth enabled — the key identifies the user; the SDK sends no user_id at all.
cortadel = CortadelClient("https://my-box:3001", api_key=os.environ["CORTADEL_API_KEY"])

# Auth disabled — no key exists, so user_id is the only thing selecting a namespace.
cortadel = CortadelClient("http://localhost:3001", "alice")
```

| You pass | What goes on the wire |
|---|---|
| nothing | **No `user_id` at all** — not as a body field, not as a query parameter. The server resolves the user from the API key. |
| `"alice"` | `user_id` is sent on every call, exactly as before. |
| `""` / `"   "` | `ValueError`, raised from the constructor. Omission is the supported way to let the server decide; a blank string is a bug. |

Passing a `user_id` is **not deprecated**. On an authenticated server it is redundant — the key
decides the namespace, so a `user_id` in a request body is silently rewritten to the key's user
and one in a query string is rejected with `403`. On an **auth-disabled** server there is no key,
and `user_id` is the only thing that scopes anything: it is still required there.

### Server requirement

Omitting `user_id` requires a server that includes commit **`30b70ea4`** — the change that made
the API fill in a missing `user_id` from the caller's key. Check which build you're talking to:

```bash
curl -s http://localhost:3001/api/health | jq -r .version
# 1.0.0+44be8adfc376d19cf6999a379cc8519331def7e6
#       ^ build metadata after the "+" is the commit SHA of the running build
```

Against an older server, a request that omits `user_id` comes back as
`400 {"errors":{"UserId":["The UserId field is required."]}}` — surfaced as a `CortadelError` with
`status == 400`. Pass `user_id` explicitly to talk to those builds.

## Methods

Both clients expose the same seven methods (`async def` on `CortadelClient`, blocking on
`SyncCortadelClient`):

| Method | Returns | Notes |
|---|---|---|
| `add(text, options=None)` | `MemoryCreated` | Store a memory. `options.infer` (default `True`) runs background entity/category extraction; `False` stores verbatim (dedup still applies). |
| `add_conversation(messages, options=None)` | `ConversationResult` | Distill atomic facts from a transcript and store each one. |
| `search(query, options=None)` | `SearchResults` | Hybrid search (BM25 + vector fused with RRF); set `options.rerank = "cross_encoder"` to rerank. |
| `list(options=None)` | `MemoryList` | Paginated, newest-first. `options.size` defaults to **20** (a deliberate SDK-wide choice — see below). |
| `get(memory_id)` | `MemoryDetail \| None` | `None` when the memory doesn't exist; never raises for a 404. Content field is `.text`. |
| `delete(memory_ids)` | `str` | Deletes one or more memories; returns the server's confirmation message. |
| `health()` | `HealthResult` | Database + embedding provider reachability. Does **not** raise when the server reports itself `degraded` — a degraded server is a normal return value (`status == "degraded"`), not an exception. |

`ListOptions.size` defaults to **20**, not the REST contract's own default of 10 — kept in sync
with the .NET and TypeScript SDKs so every Cortadel SDK behaves identically regardless of which
one you're reading examples for.

## Errors

Any non-success response — **other than a degraded health check, which `health()` returns instead
of raising** — raises a `CortadelError`:

```python
from cortadel import CortadelClient, CortadelError

async with CortadelClient("http://localhost:3001", "alice") as cortadel:
    try:
        await cortadel.add("")
    except CortadelError as err:
        print(err.status, err.code, err.message)
    # asyncio.CancelledError from a cancelled task/timeout propagates untouched instead —
    # it is never wrapped as a CortadelError.
```

| Attribute | Meaning |
|---|---|
| `status` | HTTP status code. `0` when the transport failed before a status was known. |
| `code` | Machine-readable error code (e.g. `not_found`, `validation_error`). |
| `message` | Human-readable message — for a `400` from model validation, this folds in the
  server's per-field errors instead of a generic "the request failed". |

## Bring your own HTTP client

Both constructors accept `http_client: httpx.AsyncClient` to reuse an existing client (connection
pooling, proxies, custom TLS, etc. all carry over). It is **never mutated or closed** by the SDK —
you own its lifecycle either way.

```python
import httpx
from cortadel import CortadelClient

async with httpx.AsyncClient(proxy="http://proxy.internal:8080") as http_client:
    cortadel = CortadelClient("http://localhost:3001", "alice", http_client=http_client)
    ...
```

## License

Apache-2.0
