# Cortadel × Google ADK

[`cortadel-google-adk`](https://pypi.org/project/cortadel-google-adk/) plugs Cortadel into
[Google's Agent Development Kit](https://github.com/google/adk-python) at ADK's own memory seam:
`CortadelMemoryService` implements `google.adk.memory.BaseMemoryService`, so one instance handed to
`Runner(memory_service=...)` gives every agent in the tree — plus ADK's built-in `load_memory` and
`preload_memory` tools, and every `Context.search_memory` call — durable, hybrid-searched memory
that survives a process restart. ADK's own `InMemoryMemoryService` is a keyword match over a dict
that dies with the process; this is the same interface, backed by a bi-temporal graph store. The
package adds the half ADK leaves out — nothing in `google/adk/runners.py` ever writes to a memory
service — as a `BasePlugin` that persists each finished invocation, and ships `search_memory` /
`add_memories` as model-callable tools for agents that should manage their own memory.

## Install

```bash
pip install cortadel-google-adk
```

or, with uv:

```bash
uv add cortadel-google-adk
```

That pulls in `google-adk>=2.0.0,<3.0.0` and the [`cortadel` Python SDK](../sdk-python.md)
(`>=1.0.0,<2.0.0`).

## Quickstart

All three pieces at once — ADK's `preload_memory` for automatic recall, the plugin for automatic
persistence, and the model-callable tools:

```python
import asyncio

from cortadel_google_adk import (
    CortadelMemoryPlugin,
    CortadelMemoryService,
    cortadel_memory_tools,
)
from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import preload_memory
from google.genai import types

APP_NAME = "assistant"
USER_ID = "e2e-adk-quickstart"

# Pass nothing and base_url falls back to $CORTADEL_BASE_URL then
# http://localhost:3001, and api_key to $CORTADEL_API_KEY.
memory = CortadelMemoryService("http://localhost:3001")

agent = LlmAgent(
    name="assistant",
    model="gemini-2.0-flash",  # needs $GOOGLE_API_KEY, or the Vertex AI env vars
    instruction=(
        "You are a helpful assistant with long-term memory of this user. Use what you "
        "remember. When the user tells you something durable, call add_memories."
    ),
    tools=[
        # ADK's own tool: searches whatever memory service the Runner holds
        # before every model call and injects the hits. No agent code needed.
        preload_memory,
        # Cortadel's tools. `add_memories` is the one ADK has no built-in for.
        *cortadel_memory_tools(memory),
    ],
)

app = App(
    name=APP_NAME,
    root_agent=agent,
    # ADK's runner never writes to memory on its own. This persists each finished
    # invocation — only that turn's events, selected by invocation id.
    plugins=[CortadelMemoryPlugin()],
)

runner = Runner(
    app=app,
    session_service=InMemorySessionService(),
    # One service for the whole tree: the tools, preload_memory and the plugin
    # all share its client pool and its delta ledger.
    memory_service=memory,
)


async def say(session_id: str, text: str) -> None:
    async for event in runner.run_async(
        user_id=USER_ID,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text=text)]),
    ):
        if event.is_final_response() and event.content and event.content.parts:
            print("".join(part.text for part in event.content.parts if part.text))


async def main() -> None:
    first = await runner.session_service.create_session(app_name=APP_NAME, user_id=USER_ID)
    await say(first.id, "I deploy to Cloud Run and I prefer Terraform over the console.")

    # Extraction runs off the request path on the server, so give the write
    # pipeline a moment before reading it back.
    await asyncio.sleep(5)

    # A brand-new session id: ADK's own history is empty, so anything the agent
    # still knows came out of Cortadel.
    second = await runner.session_service.create_session(app_name=APP_NAME, user_id=USER_ID)
    await say(second.id, "How should I ship my next service?")

    await runner.close()  # closes plugins, toolsets and the session service
    await memory.aclose()  # the plugin borrowed this service, so it did not close it


asyncio.run(main())
```

> **Why `memory.aclose()` as well as `runner.close()`.** `CortadelMemoryPlugin()` with no argument
> borrows the runner's `memory_service`, and a borrowed service is left alone on close — closing it
> would break the next run. Construct the plugin as `CortadelMemoryPlugin(memory)` and it owns the
> service, so `runner.close()` drains the client pool for you.

## What you get

### `CortadelMemoryService` — the memory service

Implements every method of `google.adk.memory.BaseMemoryService`:

| ADK method | What it does with Cortadel |
|---|---|
| `search_memory(*, app_name, user_id, query)` | Hybrid BM25 + vector search (`client.search`), returned as a `SearchMemoryResponse` of `MemoryEntry`. Fusion score, categories, tags, cognitive type, gist, project and app ride along in `custom_metadata`. A blank query never reaches the server. |
| `add_session_to_memory(session)` | Ingests the transcript through `client.add_conversation`. **Delta-only** — ADK explicitly permits repeat calls for one session, so only events not shipped before are sent. |
| `add_events_to_memory(*, app_name, user_id, events, session_id=None, custom_metadata=None)` | One turn's events, the same way. Optional on the base class, which raises `NotImplementedError`. |
| `add_memory(*, app_name, user_id, memories, custom_metadata=None)` | Direct fact writes through `client.add`, one call per non-empty entry. Also optional on the base class — `InMemoryMemoryService` does not implement it at all. |

Two methods sit alongside the interface:

- **`search_memory_in_session(*, app_name, user_id, query, session_id)`** — session-scoped recall,
  which `BaseMemoryService.search_memory` has no parameter for.
- **`add_fact(*, app_name, user_id, text, app=None, metadata=None, infer=None, memory_type=None)`**
  — the same write as `add_memory`, but it returns the pipeline's verdict (`MemoryCreated`, whose
  `event` is `ADD` or `SKIP_DUPLICATE`) instead of `None`.

The service is also an async context manager (`async with CortadelMemoryService(...) as memory:`),
and `aclose()` closes every pooled client.

### `CortadelMemoryPlugin` — the automatic-memory seam

A `google.adk.plugins.BasePlugin`, registered once on the app and covering the whole agent tree:

```python
App(name="assistant", root_agent=agent, plugins=[CortadelMemoryPlugin(memory)])
```

**Persist** (`after_run_callback`, on by default). The events of the invocation that just finished
are selected by `Event.invocation_id` — not by re-reading the session — so a long conversation costs
one small write per turn instead of re-sending the whole transcript each time. The service's delta
ledger is a second guard, so calling `ctx.add_session_to_memory()` by hand as well does not
double-write.

**Inject** (`before_model_callback`, off by default). Searches memory with the first non-empty text
part of the user's message and appends the hits to the system instruction. Leave it off and use
ADK's `preload_memory` instead — enabling both injects the same memories twice.

### `cortadel_memory_tools(service)` — model-callable tools

Two `google.adk.tools.FunctionTool`s, in this order:

- **`search_memory(query)`** → `{"memories": [{"text", "score", "categories", "memory_type",
  "gist", "timestamp"}]}`. Keys the server did not compute are omitted rather than sent as nulls,
  and a hit with no readable text is dropped. ADK's built-in `load_memory` works too and needs no
  tools from this package — it just throws away everything except the text.
- **`add_memories(text, memory_type=None)`** → `{"stored": bool, "text": str, "event": str}`. ADK
  has *no* built-in write tool. `event` is `ADD` for a new memory or `SKIP_DUPLICATE` when the fact
  is already known, so the model can stop repeating itself; when the write never happened, `event`
  is replaced by a `reason` (`"empty text"`, `"memory backend unavailable"`).

`cortadel_memory_tools(service, include_search=False)` / `include_add=False` returns one of them;
`make_search_memory_tool(service)` and `make_add_memories_tool(service)` build them individually.

## Configuration

`CortadelMemoryService(base_url, ...)` — `base_url` is positional or keyword, everything else is
keyword-only. These are the knobs that shape what a turn retrieves and what happens when Cortadel
is down:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str \| None` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server URL. |
| `user_id` | `str \| None` | `None` | Pins **all** memory to one Cortadel user, ignoring the ADK session's user. For single-user agents or a shared knowledge base. Leave `None` to scope per ADK user. |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Bearer token (see [Authentication](../authentication.md)). Omit when the server runs with auth disabled. |
| `top_k` | `int` | `5` | Maximum hits per search; Cortadel accepts 1–50. Below the SDK's own `SearchOptions` default of 10 because the dominant caller here is *automatic* injection — `preload_memory` runs before **every** model call — where each hit is prompt budget spent every turn. The same value serves the explicit `search_memory` tool; raise it if that is your main path. |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text` or `vector`. |
| `rerank` | `str \| None` | `None` | `"cross_encoder"` to rerank with Cortadel's local cross-encoder. |
| `memory_type` | `str \| None` | `None` | Restrict searches to `episodic`, `semantic` or `procedural`. Also becomes the fallback pin on direct writes. |
| `scope_recall_to_session` | `bool` | `False` | Make **this package's** `search_memory` tool pin recall to the current ADK session. Off by default — cross-session recall is the point of long-term memory. |
| `raise_on_error` | `bool` | `False` | Propagate Cortadel failures to the caller. Off by default: a memory outage degrades the agent to no-memory rather than taking the run down. `True` re-raises `CortadelError`. |
| `on_error` | `(BaseException) -> None \| None` | `None` | Callback handed the exception behind **every** failed Cortadel call, swallowed or re-raised. With no observer, a swallowed failure is logged as a warning instead. |
| `user_id_resolver` | `(adk_app_name, adk_user_id) -> str \| None` | `None` | Maps ADK's per-call scope onto a Cortadel user id. Overrides `user_id` when both are given. |
| `options` | `CortadelMemoryOptions \| None` | `None` | The set-once half, below. |

`options=CortadelMemoryOptions(...)` — the client wiring you pick once, plus the ingestion defaults
(each of which `add_session_to_memory` / `add_events_to_memory` can override per call through
`custom_metadata`):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `app_name` | `str` | `"cortadel-google-adk"` | App name Cortadel records for access logging on searches. This is *Cortadel's* app name — unrelated to ADK's `app_name`, which arrives per call. |
| `is_agent_memory` | `bool` | `False` | Extract facts about the *assistant* instead of the user. |
| `project` | `str \| None` | `None` | Cortadel project scope stamped on ingested conversations. |
| `tags` | `Sequence[str] \| None` | `None` | Tags stamped on every fact extracted from an ingested conversation. |
| `timeout` | `float` | `100.0` | Per-client HTTP timeout, in seconds. |
| `client_factory` | `(user_id) -> CortadelClient \| None` | `None` | Builds clients yourself; overrides `base_url` / `api_key` / `app_name` / `timeout` entirely. Mainly a test seam. |
| `max_clients` | `int` | `128` | LRU cap on pooled per-user clients. Evicted clients are closed. |
| `dedupe_sessions` | `int` | `256` | How many `(user, session)` pairs the delta ledger tracks. Must be ≥ 1. |

```python
from cortadel_google_adk import CortadelMemoryOptions, CortadelMemoryService

memory = CortadelMemoryService(
    "http://localhost:3001",
    top_k=8,
    rerank="cross_encoder",
    options=CortadelMemoryOptions(project="atlas", tags=["adk"], timeout=30.0),
)
```

`CortadelMemoryPlugin(service=None, *, name="cortadel_memory", persist=True, inject=False,
inject_template=..., close_service=None)`:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `service` | `CortadelMemoryService \| None` | `None` | The service to read and write through. `None` borrows the runner's `memory_service` when that is a `CortadelMemoryService`, and otherwise does nothing but log once. |
| `name` | `str` | `"cortadel_memory"` | Plugin name, as ADK reports it. |
| `persist` | `bool` | `True` | Write each finished invocation to memory. |
| `inject` | `bool` | `False` | Search before each model call and append the hits to the system instruction. |
| `inject_template` | `str` | a `<CORTADEL_MEMORY>` block | Format string for the injected block; receives `{memories}`. |
| `close_service` | `bool \| None` | `True` when a service was passed, `False` when borrowed | Close the service (and its pooled HTTP clients) when the runner closes the plugin. |

### `custom_metadata` keys

`BaseMemoryService` passes a `custom_metadata` mapping whose keys are implementation-defined. This
service recognises:

- `add_session_to_memory` / `add_events_to_memory`: `tags` (list of str), `project` (str),
  `is_agent_memory` (bool), `transcript_path` (str)
- `add_memory`: `memory_type` (`episodic` / `semantic` / `procedural`), `infer` (bool — `False`
  stores the text verbatim and skips entity extraction; dedup still applies), `app` (str, the app
  credited with creating the memory, defaulting to ADK's per-call `app_name`), `metadata` (dict
  stored alongside)

Anything else is ignored. A key of the wrong type is treated as unset, and `infer` in particular is
never coerced to `False` — the server reads an unset `infer` as "use the default", and sending
`False` would silently disable extraction.

## How it works

**The extension point is `google.adk.memory.base_memory_service.BaseMemoryService`** — ADK's own
memory abstraction, and the reason this integration needs no per-agent wiring. In google-adk 2.6.3
the class declares exactly two `@abstractmethod` members, `add_session_to_memory` and
`search_memory`; `add_events_to_memory` and `add_memory` are concrete on the base and raise
`NotImplementedError`. `CortadelMemoryService` overrides all four, and its test suite asserts the
overridden signatures are parameter-for-parameter identical to the base class's, because ADK calls
them by keyword.

Everything downstream of `Runner(memory_service=...)` then routes through Cortadel with no further
changes: ADK's `load_memory` and `preload_memory` tools, `ToolContext.search_memory`, and
`Context.add_session_to_memory`. `preload_memory` is the one to know — its `process_llm_request`
runs before every model call, searches the configured service with the user's message, and renders
each hit as `f"{memory.author}: {text}"`. That is why every recalled entry is stamped
`author="cortadel"` (exported as `MEMORY_AUTHOR`): a Cortadel memory is a distilled fact, not a
verbatim utterance, so labelling it `user` or with an agent name would be a lie.

**Reading is automatic in ADK; writing is not.** No code path in `google/adk/runners.py` calls
`add_session_to_memory` or `add_events_to_memory`, so a memory service wired into a runner is
never written to unless something asks. `CortadelMemoryPlugin` closes that half through
`google.adk.plugins.BasePlugin`:

- `after_run_callback(*, invocation_context)` — the last hook in the ADK lifecycle. It filters
  `session.events` down to the events whose `invocation_id` matches the invocation that just
  finished, and hands only those to `add_events_to_memory`.
- `before_model_callback(*, callback_context, llm_request)` — the optional injection path. It calls
  the **public** `LlmRequest.append_instructions([...])`, the same API ADK's own `LoadMemoryTool`
  uses. (ADK's `preload_memory` writes to the private `_append_dynamic_instructions` slot instead,
  which is one reason `preload_memory` remains the recommended route.) The request is rebuilt for
  every model call, so the block never accumulates across turns, and the callback always returns
  `None` — injection must never short-circuit the model call.
- `close()` — invoked by `Runner.close()` via the plugin manager, and closes the service only when
  the plugin owns it.

**One client per user, pooled.** A `cortadel.CortadelClient` is bound to a single user id at
construction — no SDK method takes one — while ADK hands `user_id` in on *every* call. So the
service resolves an id per call (`user_id_resolver(app_name, user_id)`, else the pinned `user_id`,
else the ADK session's `user_id`) and keeps an LRU pool of one client per resolved id, bounded by
`max_clients` and closed on eviction. The client is acquired *inside* the failure guard, so a
broken `client_factory` or a bad `base_url` obeys the same policy as the call itself instead of
escaping it.

**Delta ingestion.** `BaseMemoryService.add_session_to_memory` is documented as callable many times
for one session, and a naive implementation re-extracts the whole transcript every turn. Each event
gets a fingerprint — `Event.id` when the session service assigned one, otherwise a SHA-256 of
author, timestamp and text — and the fingerprints already shipped are held per `(cortadel_user_id,
session_id)` in an LRU of `dedupe_sessions` entries. Fresh events are *claimed* under an
`asyncio.Lock` before the write, so two concurrent calls on one session cannot ship the same turn
twice, and the claim is **released** if the write fails or is cancelled, so a dropped memory is
retried on the next turn rather than lost. Partial streaming chunks and events with no text (tool
calls, function responses) are filtered out before anything reaches the LLM extractor; every
message carries its ADK `Event.id` as `uuid`, so a stored fact traces back to the exact event that
produced it.

**Failure policy.** Every Cortadel call runs through one guard. `asyncio.CancelledError` is always
re-raised untouched and never reported — cancellation is control flow, not a memory failure.
Anything else goes to `on_error` if set, then either re-raises (`raise_on_error=True`) or returns a
neutral value: an empty `SearchMemoryResponse`, a dropped write. With no `on_error` and a swallowed
failure, a warning is logged instead, so a memory outage still leaves a trace. The plugin keeps its
own backstop: even against a `raise_on_error=True` service, a failed persist in `after_run_callback`
is logged, never raised into a run that already finished.

## Known limits

- **No `await_persist` knob, and writes are always awaited.** This is a deliberate deviation from
  the shared option vocabulary. `after_run_callback` is the last hook in the ADK lifecycle and
  `Runner` neither tracks nor awaits a task created inside it, so a detached write would outlive the
  run that owns it and could be dropped when the loop or the process goes away — losing memories
  silently. The cost is bounded because only the finished turn's events are sent.
- **One `top_k` (default 5) governs both automatic injection and the explicit `search_memory`
  tool**, rather than the vocabulary's usual 10 for an explicit tool. Automatic injection is the
  dominant caller, and it spends prompt budget on every turn.
- **`scope_recall_to_session` only reaches this package's own `search_memory` tool.**
  `BaseMemoryService.search_memory` has no session parameter, so ADK's `load_memory`,
  `preload_memory` and the plugin's `inject=True` always search across sessions. Call
  `search_memory_in_session(...)` directly for session-scoped recall elsewhere.
- **ADK's `app_name` is not a Cortadel search filter.** Cortadel namespaces memory by user, and
  `SearchOptions` has no app field — so two ADK apps sharing a `user_id` share memory. Namespace
  them yourself: `CortadelMemoryService(user_id_resolver=lambda app, user: f"{app}:{user}")`.
- **Conversation-ingested facts carry no app label.** Cortadel's conversation API has no app field,
  so the `app_name` you configure is recorded on *searches* (access logging) only. Direct writes do
  carry one, and it defaults to ADK's per-call `app_name` — not to `cortadel-google-adk`.
- **`inject=True` appends to the system instruction**, not to ADK's private transient-content slot,
  which is why it is off by default and `preload_memory` is the recommended route; turning both on
  injects the same memories twice. Injection also keys on the first non-empty text part of the
  user's message, so an image-only or tool-only turn injects nothing.
- **The `add_memories` tool reports `stored: true` for a `SKIP_DUPLICATE`** — the fact is in memory,
  it just was not newly created. `stored` is `false` only when the write errored or the backend was
  unavailable.
- **The delta ledger and the client pool are in-process.** A restart, or a second replica, re-ships
  a turn it has already sent; Cortadel's server-side dedup is the backstop. The ledger tracks the
  256 most recent `(user, session)` pairs and the pool 128 users, both LRU.
- **Offline tests only.** The suite drives real ADK objects — real `Session`, `Event`,
  `InvocationContext`, `ToolContext`, `LlmRequest` — but stubs at the Cortadel client boundary
  through `client_factory`. Nothing in CI runs against a live Cortadel server or a live model, so
  wire-level behaviour rests on the [Python SDK](../sdk-python.md) and its own conformance suite.
- **Verified against google-adk 2.6.3.** The `>=2.0.0` floor is where
  `BaseMemoryService.add_events_to_memory` / `add_memory` and the `ToolContext` unification land;
  it is not tested below 2.6.x.

## Requirements

- Python **>= 3.10** (classified through 3.13)
- `google-adk` **>= 2.0.0, < 3.0.0** (developed and verified against 2.6.3)
- `cortadel` **>= 1.0.0, < 2.0.0**
- A running Cortadel server — the hosted service at `https://app.cortadel.ai`, or your own via
  `docker compose up` → `http://localhost:3001` (see [Self-hosting](../self-hosting.md))
- A model for ADK itself: `$GOOGLE_API_KEY` for the Gemini API, or the Vertex AI environment
  (`GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`)

## Links

- **PyPI** — [`cortadel-google-adk`](https://pypi.org/project/cortadel-google-adk/)
- **Source** —
  [`integrations/google-adk`](https://github.com/cortadel/cortadel/tree/main/integrations/google-adk),
  including
  [`examples/quickstart.py`](https://github.com/cortadel/cortadel/blob/main/integrations/google-adk/examples/quickstart.py),
  a two-session script that shows memory surviving a fresh session
- **All integrations** — [Integrations](../integrations.md)
- **Google ADK** — [google/adk-python](https://github.com/google/adk-python)

Licensed under Apache-2.0.
