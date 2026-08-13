# Cortadel × LangGraph

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search, so facts are superseded rather than
overwritten and retrieval finds things that share no words with the query. This package makes it a
first-class citizen inside LangGraph: `CortadelStore` **is** a LangGraph `BaseStore`, so everything
that already accepts a store — `StateGraph.compile(store=...)`, `@entrypoint(store=...)`,
`create_react_agent(store=...)`, `get_store()`, `InjectedStore` — accepts Cortadel with no other
changes. On top of that you get two ready-made tools and a pair of graph nodes that give an agent
memory it never has to ask for.

LangGraph already ships short-term memory (the checkpointer, scoped to a `thread_id`). This is the
other half: long-term memory scoped to a *user*, which crosses every thread they ever open.

## Install

```bash
pip install cortadel-langgraph
# or
uv add cortadel-langgraph
```

`langgraph` and the `cortadel` SDK come with it.

## Quickstart

```python
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.prebuilt import create_react_agent

from cortadel_langgraph import CortadelMemory, CortadelStore, create_memory_tools

USER_ID = "e2e-alice"
NAMESPACE = ("memories", USER_ID)

# 1. Cortadel as a LangGraph BaseStore.
store = CortadelStore("http://localhost:3001", USER_ID)

# 2. Automatic memory: recall before the model call, persist after the turn.
memory = CortadelMemory(store, namespace=NAMESPACE)

agent = create_react_agent(
    model="anthropic:claude-sonnet-4-5",
    # 3. ...and tools, for when the agent wants to look something up or write something down.
    tools=create_memory_tools(store=store, namespace=NAMESPACE),
    store=store,
    pre_model_hook=memory.pre_model_hook,
    post_model_hook=memory.post_model_hook,
    checkpointer=InMemorySaver(),
)

agent.invoke(
    {"messages": [{"role": "user", "content": "I ship releases on Fridays."}]},
    config={"configurable": {"thread_id": "conv-1"}},
)

# A brand-new thread — an empty transcript. Whatever it knows now came from Cortadel.
result = agent.invoke(
    {"messages": [{"role": "user", "content": "When should we deploy?"}]},
    config={"configurable": {"thread_id": "conv-2"}},
)
print(result["messages"][-1].content)
```

Runnable versions of this, including one that needs no LLM at all, are in
[`examples/`](examples/).

## What you get

### `CortadelStore` — the `BaseStore` implementation

The flagship. `BaseStore` declares exactly two abstract methods, `batch` and `abatch`; this
implements both, so every convenience method (`get`/`search`/`put`/`delete`/`list_namespaces` and
the `a*` variants) works, sync and async.

| LangGraph op | Cortadel call |
|---|---|
| `put(ns, key, value)` | `add()` — into Cortadel's write pipeline (intent classification, dedup, extraction) |
| `put(ns, key, None)` / `delete(ns, key)` | `delete()` |
| `get(ns, key)` | `get()` |
| `search(ns, query="…")` | `search()` — hybrid BM25 + vector, RRF-fused |
| `search(ns)` (no query) | `list()` |
| `list_namespaces(...)` | *no Cortadel equivalent* — served from a process-local registry |

Plus two Cortadel-specific extras that `BaseStore` has no room for: `add_conversation()` (hand
Cortadel raw turns and let its pipeline decide what is worth remembering) and `health()`.

### `create_memory_tools()` — tools the agent calls itself

Two `langchain_core.tools.StructuredTool`s, each with both a sync and an async implementation:

- **`search_memory(query, top_k)`** — retrieve. Returns the matching facts as plain text.
- **`add_memories(memories)`** — store. One memory per fact.

They talk to a `BaseStore`, not to a Cortadel client, so `store=None` makes them resolve the store
the graph was compiled with, at call time. That also means they keep working against an
`InMemoryStore` in a unit test.

### `CortadelMemory` — memory without a tool call

Two ordinary node callables, usable as `StateGraph` nodes, as `create_react_agent`'s
`pre_model_hook` / `post_model_hook`, or through the `.pre_model_hook` / `.post_model_hook`
properties (which bundle the sync and async pair into one `RunnableLambda`).

- **`recall_node`** searches Cortadel with the user's latest message and prepends the hits as a
  `SystemMessage`. It writes to **`llm_input_messages`**, the channel `create_react_agent` treats
  as ephemeral, so the memory block is never appended to the durable transcript and never
  re-injected turn after turn. Within one turn the block is cached, so a tool loop costs one
  Cortadel search, not one per model call.
- **`remember_node`** waits until the model produces a final answer (not a tool call), then hands
  the turns to `add_conversation`. A per-thread cursor means each message is submitted at most
  once, and tool traffic is excluded.

**Persistence awaits the write** — there is no fire-and-forget option, because a graph node has no
lifetime of its own: once the run finishes, LangGraph (or the platform hosting it) is free to tear
down the loop or the process, and a detached write would be silently lost. Blocking is cheap here
anyway: Cortadel's extraction pipeline already runs off the request path server-side, so the call
returns as soon as the turns are accepted.

## Configuration

### `CortadelStore(base_url, user_id, **options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str` | *required* | Cortadel server: `http://localhost:3001` self-hosted, `https://app.cortadel.ai` hosted |
| `user_id` | `str` \| `(namespace) -> str` | *required* | The Cortadel user that owns the memories, or a callable deriving it from the namespace |
| `api_key` | `str \| None` | `None` | Bearer token. Omit when the server has auth disabled (the self-hosted default) |
| `app_name` | `str` | `"cortadel-langgraph"` | Recorded for access logging, and as the creating app on writes |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text` or `vector` |
| `rerank` | `str \| None` | `None` | `"cross_encoder"` to rerank with the server's cross-encoder |
| `infer` | `bool` | `True` | `False` stores text verbatim, skipping background entity/category extraction |
| `text_keys` | `Sequence[str]` | `("content", "text", "memory", "data")` | `Item.value` keys checked, in order, for the text to store |
| `value_key` | `str` | `"content"` | Key the memory text is exposed under on read |
| `raise_on_error` | `bool` | `False` | `False` fails open — a Cortadel failure becomes an empty result. `True` propagates it. See *Degradation* |
| `on_error` | `(BaseException) -> None \| None` | `None` | Callback invoked with the exception when a failure is swallowed. Replaces the default warning log |
| `timeout` | `float` | `100.0` | Per-request HTTP timeout, in seconds |
| `max_alias_entries` | `int` | `10000` | Cap on the process-local key alias table |
| `logger` | `logging.Logger \| None` | `None` | Defaults to this package's own `cortadel_langgraph.*` logger |

### `CortadelMemory(store, **options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `store` | `BaseStore \| None` | `None` | `None` resolves the graph's compiled store at call time |
| `namespace` | `tuple[str, ...] \| str` | `("memories", "{user_id}")` | Namespace to use; `{placeholders}` come from `config["configurable"]` |
| `top_k` | `int` | `5` | Maximum memories injected per turn. Lower than the `search_memory` tool's `10` because every turn pays for this search, whether or not it was needed |
| `header` | `str` | see `DEFAULT_RECALL_HEADER` | Sentence introducing the injected memories |
| `messages_key` | `str` | `"messages"` | State key holding the conversation |
| `output_key` | `str` | `"llm_input_messages"` | Where the recalled-plus-original messages are written |
| `persist` / `recall` | `bool` | `True` | Turn either half off |
| `session_from_thread` | `bool` | `True` | Record the LangGraph `thread_id` as the Cortadel session id |
| `project` / `tags` | `str` / `list[str]` | `None` | Cortadel scope and tags applied to persisted facts |
| `max_tracked_threads` | `int` | `256` | Cap on the per-thread caches |

### Tool factories

`create_search_memory_tool(store=…, namespace=…, top_k=10, name=…, description=…)`,
`create_add_memories_tool(store=…, namespace=…, name=…, description=…)`, and
`create_memory_tools(store=…, namespace=…, top_k=10)` for both.

`top_k` is both the number of memories fetched when the model omits the argument **and** the
default baked into the tool's advertised JSON schema — the model sees it, so the two cannot drift.
It defaults to `10`, matching the Cortadel SDK's own `SearchOptions.top_k`.

## Multi-tenancy

A Cortadel client is bound to **one user id at construction** — no method takes a user id. So one
store serves many users by deriving the user from the namespace and keeping one client each:

```python
from cortadel_langgraph import CortadelMemory, CortadelStore, namespace_user_id

store = CortadelStore("http://localhost:3001", namespace_user_id(-1))
memory = CortadelMemory(store, namespace=("memories", "{user_id}"))

graph.invoke(inputs, config={"configurable": {"thread_id": "t-1", "user_id": "e2e-alice"}})
```

`thread_id` scopes the short-term transcript; `user_id` scopes long-term memory. They are
independent — a user has many threads, and their memory crosses all of them.

## Degradation

Memory is an enhancement, never a reason for an agent to fall over. **The store fails open by
default** (`raise_on_error=False`). Every Cortadel call is wrapped: a `CortadelError` — which the
SDK also raises for transport failures, with `code="transport_error"` — becomes an empty result. A
search returns `[]`, a `get` returns `None`, a write is dropped, and the graph runs on without
memory.

You then choose what *observes* that failure:

```python
# Default: a warning on the `cortadel_langgraph` logger, and the agent carries on.
store = CortadelStore(url, user_id)

# Route failures into your own telemetry instead of the log.
store = CortadelStore(url, user_id, on_error=lambda exc: sentry_sdk.capture_exception(exc))

# Silence them entirely.
store = CortadelStore(url, user_id, on_error=lambda exc: None)

# Or opt out of failing open: the CortadelError reaches your code.
store = CortadelStore(url, user_id, raise_on_error=True)
```

`on_error` is only consulted for failures that are *swallowed*, so `raise_on_error=True` wins over
it — there is nothing to observe when the exception reaches the caller anyway. Passing a string
(the pre-release spelling of this option) raises `TypeError` rather than quietly never firing.

## Things worth knowing

- **Keys.** Cortadel mints its own memory ids and has no upsert-by-caller-key, so the store's key
  space *is* Cortadel memory ids — that is what `search()` returns as `SearchItem.key` and what
  `get()`/`delete()` expect. A caller-chosen key given to `put()` is bridged to the minted id
  through a **process-local** alias table, so `put(); get()` round-trips within one run but not
  across a restart. `value["id"]` always holds the durable Cortadel id.
- **Values.** `BaseStore` values are dicts; Cortadel stores text. The first matching `text_keys`
  entry becomes the memory text and the rest becomes metadata, so `{"content": "…"}` is the shape
  to use. A value with no matching key is stored as sorted JSON — lossless, but Cortadel's
  extraction works far better on prose.
- **`list_namespaces()`** reports namespaces *this store instance* has touched, because Cortadel
  namespaces by user rather than by path. It is accurate but not durable, and empty in a
  freshly-started process.
- **`filter`** supports the fields Cortadel exposes on a hit (`categories`, `tags`, `memory_type`,
  `app_name`, `source`, `state`, …); `memory_type` and `session_id` are pushed to the server, the
  rest are applied client-side. An unusable key is warned about once and ignored — it does *not*
  silently drop results. MongoDB-style operator filters (`{"$gt": …}`) are not supported.
- **`ttl`** is not supported (`supports_ttl = False`). Cortadel is bi-temporal — memories are
  superseded, not expired on a timer.
- **`create_react_agent` is deprecated** as of LangGraph 1.0 in favour of
  `langchain.agents.create_agent`. It still works, and the hooks above still work with it. On
  `create_agent`, use `store=` plus `create_memory_tools()`; or drive `recall_node` /
  `remember_node` as nodes of your own `StateGraph`, which is what `examples/03_multi_user_graph.py`
  does.
- **`MemoryDetail.metadata` is always `None`** from the Python SDK (a code-generator gap), so
  metadata written by `put()` is write-only from Python — do not build logic that reads it back.

## Running the tests

The suite is fully offline: no network, no Cortadel server, no API keys.

```bash
cd integrations/langgraph
uv sync --extra test
uv run pytest -q
```

## Requirements

- **Python ≥ 3.10**
- **`langgraph` ≥ 1.0, < 2.0** (brings `langgraph-checkpoint` for `BaseStore` and `langchain-core`
  for `StructuredTool`)
- **`cortadel` ≥ 1.0, < 2.0** — the official Python SDK
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` from the [repo root](https://github.com/cortadel/cortadel) → serves the API,
  dashboard and MCP endpoint on `http://localhost:3001`. Self-hosted defaults to auth disabled, so
  `api_key` is optional there.

## Links

- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel) — SDKs, plugin, docs
- [cortadel.ai](https://cortadel.ai)
- [Issues](https://github.com/cortadel/cortadel/issues)

Apache-2.0.
