# Cortadel × Google ADK

[Cortadel](https://cortadel.ai) is self-hosted long-term memory for AI agents — a bi-temporal graph
store with hybrid BM25 + vector search. This package plugs it into
[Google's Agent Development Kit](https://github.com/google/adk-python) at ADK's own memory seam:
`CortadelMemoryService` implements `google.adk.memory.BaseMemoryService`, so one instance handed to
`Runner(memory_service=...)` gives every agent in the tree — and ADK's built-in `load_memory` and
`preload_memory` tools — durable, semantically searchable memory that survives a restart. ADK's own
`InMemoryMemoryService` is a dict of keywords that dies with the process; this is the same interface,
backed by a real graph store.

## Install

```bash
pip install cortadel-google-adk
```

or, with uv:

```bash
uv add cortadel-google-adk
```

That pulls in `google-adk>=2.0.0` and the `cortadel` Python SDK.

## Quickstart

```python
import asyncio

from cortadel_google_adk import CortadelMemoryPlugin, CortadelMemoryService
from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import preload_memory
from google.genai import types

memory = CortadelMemoryService("http://localhost:3001")

agent = LlmAgent(
    name="assistant",
    model="gemini-2.0-flash",
    instruction="You are a helpful assistant. Use what you remember about the user.",
    # ADK's built-in tool: searches memory before every model call and injects
    # the hits. It routes through whatever memory_service the Runner holds.
    tools=[preload_memory],
)

app = App(
    name="assistant",
    root_agent=agent,
    # ADK's runner never writes to memory on its own. This plugin persists each
    # finished turn — the missing half of automatic memory.
    plugins=[CortadelMemoryPlugin()],
)

runner = Runner(
    app=app,
    session_service=InMemorySessionService(),
    memory_service=memory,
)


async def main() -> None:
    session = await runner.session_service.create_session(
        app_name="assistant", user_id="e2e-adk-quickstart"
    )
    async for event in runner.run_async(
        user_id=session.user_id,
        session_id=session.id,
        new_message=types.Content(
            role="user", parts=[types.Part(text="I deploy to Cloud Run and prefer Terraform.")]
        ),
    ):
        if event.is_final_response() and event.content and event.content.parts:
            print(event.content.parts[0].text)

    await memory.aclose()


asyncio.run(main())
```

Run it a second time with a **new session id** and the same `user_id`: the agent still knows about
Cloud Run and Terraform, because the memory lives in Cortadel, not in the session.

## What you get

### 1. `CortadelMemoryService` — the memory service (flagship)

Implements every method of `google.adk.memory.BaseMemoryService`:

| ADK method | What it does with Cortadel |
|---|---|
| `search_memory(app_name, user_id, query)` | Hybrid BM25 + vector search, returned as `SearchMemoryResponse` of `MemoryEntry`. Score, categories, cognitive type and gist ride along in `custom_metadata`. |
| `add_session_to_memory(session)` | Ingests the session transcript via `add_conversation`. **Delta-only** — ADK permits repeat calls for one session, and this ships only events it has not sent before. |
| `add_events_to_memory(...)` | One turn's events, the same way. |
| `add_memory(...)` | Direct fact writes via `add`. Optional in the base class; `InMemoryMemoryService` does not implement it. |

Plus two methods beyond the interface: `search_memory_in_session(...)` (session-scoped retrieval,
which `BaseMemoryService.search_memory` has no parameter for) and `add_fact(...)` (a single write
that returns the pipeline's verdict — `ADD`, `SKIP_DUPLICATE`, … — instead of `None`).

### 2. `CortadelMemoryPlugin` — automatic memory

A `google.adk.plugins.BasePlugin`. **Persists** each completed invocation in `after_run_callback`,
selecting only that invocation's events by `invocation_id`. This is the half ADK does not do for
you: nothing in `google/adk/runners.py` calls `add_session_to_memory`.

The write is **awaited**, and there is no option to fire and forget it: `after_run_callback` is the
last hook in the ADK lifecycle, so a detached task would outlive the run that owns it and could be
dropped when the loop or process goes away — losing memories silently. The cost is bounded, because
only the finished turn's events are sent, not the whole transcript.

It can also **inject** (`inject=True`, off by default) — searching memory in `before_model_callback`
and appending the hits to the system instruction. Leave it off and use ADK's own `preload_memory`
tool instead, as the quickstart does; turning on both would inject the same memories twice.

### 3. `cortadel_memory_tools(service)` — model-callable tools

Two `FunctionTool`s for agents that should manage their own memory:

- **`search_memory(query)`** — retrieval with Cortadel's metadata attached. (ADK's built-in
  `load_memory` also works and needs no tools from us; this one returns more.)
- **`add_memories(text, memory_type=None)`** — ADK has *no* built-in write tool. This lets the agent
  decide a fact is worth keeping, and tells it when the fact was already known (`SKIP_DUPLICATE`)
  so it stops repeating itself.

```python
from cortadel_google_adk import cortadel_memory_tools

agent = LlmAgent(name="assistant", model="gemini-2.0-flash", tools=cortadel_memory_tools(memory))
```

## Configuration

`CortadelMemoryService(base_url, ...)` — the keywords that shape a turn:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str \| None` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server URL. |
| `user_id` | `str \| None` | `None` | Pins **all** memory to one Cortadel user, ignoring the ADK session's user. For single-user agents or a shared knowledge base. Leave `None` to scope per ADK user. |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server runs with auth disabled. |
| `top_k` | `int` | `5` | Max hits per search (1–50). Below the Cortadel SDK's own default of 10 because the dominant caller here is *automatic injection* — ADK's `preload_memory` searches before **every** model call — and each hit is prompt budget spent every turn. The same knob serves this package's explicit `search_memory` tool; raise it if that is your main path. |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text` or `vector`. |
| `rerank` | `str \| None` | `None` | `"cross_encoder"` to rerank with Cortadel's local cross-encoder. |
| `memory_type` | `str \| None` | `None` | Restrict to `episodic`, `semantic` or `procedural`. |
| `scope_recall_to_session` | `bool` | `False` | Make this package's `search_memory` tool pin recall to the current ADK session. Off by default — cross-session recall is the point. |
| `raise_on_error` | `bool` | `False` | Propagate Cortadel failures to the caller. Off by default: a memory outage degrades the agent to no-memory rather than taking the run down. `True` re-raises `CortadelError`. |
| `on_error` | `(BaseException) -> None \| None` | `None` | Called with the exception behind **every** failed Cortadel call, swallowed or re-raised. With no observer, a swallowed failure is logged as a warning instead. |
| `user_id_resolver` | `(app_name, user_id) -> str` | `None` | Maps ADK's scope to a Cortadel user id. Overrides `user_id`. |
| `options` | `CortadelMemoryOptions \| None` | `None` | The set-once half, below. |

`options=CortadelMemoryOptions(...)` — client wiring you pick once, plus the ingestion defaults
(each of which `add_session_to_memory` / `add_events_to_memory` can override per call through
`custom_metadata`):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `app_name` | `str` | `"cortadel-google-adk"` | App name Cortadel records for access logging on searches. This is *Cortadel's* app name — unrelated to ADK's `app_name`, which arrives per call. |
| `is_agent_memory` | `bool` | `False` | Extract facts about the *assistant* instead of the user. |
| `project` | `str \| None` | `None` | Cortadel project scope stamped on ingested conversations. |
| `tags` | `Sequence[str] \| None` | `None` | Tags stamped on every extracted fact. |
| `timeout` | `float` | `100.0` | Per-client HTTP timeout, in seconds. |
| `client_factory` | `(user_id) -> CortadelClient` | `None` | Builds clients yourself; overrides `base_url`/`api_key`/`app_name`/`timeout`. Mainly a test seam. |
| `max_clients` | `int` | `128` | LRU cap on pooled per-user clients. |
| `dedupe_sessions` | `int` | `256` | How many session ids to track for delta ingestion. |

```python
from cortadel_google_adk import CortadelMemoryOptions, CortadelMemoryService

memory = CortadelMemoryService(
    "http://localhost:3001",
    top_k=8,
    options=CortadelMemoryOptions(project="atlas", tags=["adk"], timeout=30.0),
)
```

`CortadelMemoryPlugin(service=None, *, name, persist=True, inject=False, inject_template, close_service=None)`.
With `service=None` it borrows the runner's `memory_service` when that is a `CortadelMemoryService`.

### How user ids map

A Cortadel client is bound to **one** user id at construction — no SDK method takes a user id. ADK
hands `user_id` in on every call. So the service keeps an LRU pool of one client per user and
resolves the id like this:

1. `user_id_resolver(app_name, user_id)` if given, else
2. the pinned `user_id` if given, else
3. the ADK session's `user_id`.

Cortadel namespaces memory by user, not by app — two ADK apps sharing a `user_id` share memory. To
keep them apart, namespace in the resolver:

```python
CortadelMemoryService(user_id_resolver=lambda app, user: f"{app}:{user}")
```

### `custom_metadata` keys

`BaseMemoryService` passes a `custom_metadata` mapping whose keys are implementation-defined. This
service recognises:

- `add_events_to_memory` / `add_session_to_memory`: `tags` (list of str), `project` (str),
  `is_agent_memory` (bool), `transcript_path` (str)
- `add_memory`: `memory_type` (`episodic`/`semantic`/`procedural`), `infer` (bool — `False` stores
  verbatim and skips entity extraction; dedup still applies), `app` (str), `metadata` (dict)

Anything else is ignored.

### When Cortadel is down

With `raise_on_error=False` (the default) the agent degrades to no-memory: searches return no
memories, writes are dropped, a warning is logged, and the run completes normally. Set
`raise_on_error=True` if you would rather the run fail loudly.

Either way, pass `on_error` to observe the failure — it fires for every failed Cortadel call, and
replaces the warning log when the failure is being swallowed:

```python
CortadelMemoryService(on_error=lambda exc: sentry_sdk.capture_exception(exc))
```

`asyncio.CancelledError` is always re-raised untouched, and is never reported to `on_error`:
cancellation is control flow, not a memory failure.

A dropped write is **not** marked as ingested, so the next turn re-sends those events rather than
losing them. And `CortadelMemoryPlugin` keeps its own backstop: even with `raise_on_error=True`, a
failed persist in `after_run_callback` is logged, never raised into a run that already finished.

## Running the tests

The suite is fully offline — no server, no API keys, no network. It stubs at the Cortadel client
boundary through `client_factory`.

```bash
cd integrations/google-adk
uv sync --extra test
uv run pytest -q
```

## Requirements

- Python **>= 3.10**
- `google-adk` **>= 2.0.0** (developed and tested against 2.6.3)
- `cortadel` **>= 1.0.0, < 2.0.0**
- A running Cortadel server: hosted at `https://app.cortadel.ai`, or self-host with
  `docker compose up` → `http://localhost:3001`.

## Examples

- [`examples/quickstart.py`](examples/quickstart.py) — a complete two-session script showing memory
  survive across sessions, wired for both the plugin and the model-callable tools.

## Links

- Source and issues: <https://github.com/cortadel/cortadel>
- Cortadel: <https://cortadel.ai>
- Google ADK: <https://github.com/google/adk-python>

Licensed under Apache-2.0.
