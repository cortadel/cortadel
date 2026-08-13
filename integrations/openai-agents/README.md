# Cortadel × OpenAI Agents SDK

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. This package makes it native to the
[OpenAI Agents SDK](https://github.com/openai/openai-agents-python): your agent remembers a user
across conversations, processes and deployments, without you writing any retrieval plumbing.

It plugs into the SDK's own seams — the `Session` protocol for conversation history,
`RunConfig.call_model_input_filter` for automatic recall, and `@function_tool` for explicit
memory calls. No monkey-patching, no wrapper `Runner`.

## Install

```bash
pip install cortadel-openai-agents
```

That brings in `openai-agents` and the `cortadel` SDK.

## Quickstart

```python
import asyncio
from agents import Agent, Runner
from cortadel_openai_agents import CortadelSession

async def main() -> None:
    agent = Agent(name="Assistant", instructions="You are a concise assistant.")

    session = CortadelSession(
        session_id="chat-1",
        user_id="e2e-alice",                 # the memory namespace
        base_url="http://localhost:3001",    # or https://app.cortadel.ai
    )

    async with session:
        result = await Runner.run(
            agent,
            "What editor do I use?",
            session=session,                 # history + store-after-turn
            run_config=session.run_config(), # recall-before-model-call
        )
        print(result.final_output)

asyncio.run(main())
```

**Both arguments matter.** `session=` gives you conversation history *and* writes each finished
turn to Cortadel. `run_config=` additionally installs the recall filter, which searches Cortadel
for the question the user just asked and injects the hits into the model call. Pass only
`session=` and you get storage without recall — occasionally what you want, usually not.

`session.run_config()` accepts your own config and copies it, so nothing is clobbered:

```python
run_config=session.run_config(RunConfig(workflow_name="support-bot"))
```

## What you get

### `CortadelSession` — automatic memory

A `Session` (the SDK's conversation-history protocol) that adds long-term memory on top:

| Method / member | What it does |
|---|---|
| `get_items` / `add_items` / `pop_item` / `clear_session` | Verbatim conversation history, delegated to a transcript session |
| `add_items` (also) | Distils the finished user↔assistant exchange into Cortadel via `add_conversation` |
| `input_filter` | A `CallModelInputFilter`: searches Cortadel for the latest user message and injects the hits |
| `run_config(base=None)` | A `RunConfig` with that filter installed |
| `tools()` | The two memory tools below, bound to this session's client |
| `flush()` / `aclose()` | Send anything still buffered; drain background writes and release what the session created |

**Why history and memory are separate.** A `Session` is a verbatim transcript store — the runner
replays it, fingerprints it, and pops from it to rewind failed turns. Cortadel is a *distilled*
store: it deduplicates facts and does not preserve item order, so backing `get_items` with it
would corrupt the run loop. So `CortadelSession` follows the SDK's own wrapper-session pattern
(the one `agents.extensions.memory.EncryptedSession` uses): it holds a **transcript** session for
exact short-term fidelity and layers Cortadel on top. The transcript defaults to an in-memory
`SQLiteSession`; pass `transcript=` any `Session` (file-backed SQLite, Redis, SQLAlchemy…) to
survive restarts.

**Why recall is a filter, not `get_items`.** `get_items()` receives no query, and the runner calls
it *before* the new turn's input exists — on the first turn there is nothing to search on at all.
`RunConfig.call_model_input_filter` runs immediately before each model call with the full input in
hand, and the SDK documents it for exactly this ("you can use this to add a system prompt to the
input"). It also receives a *copy*, so the injected block is **ephemeral**: it never enters
history, never gets written back to Cortadel, and never accumulates turn after turn. Context stays
flat no matter how long the conversation runs.

### `cortadel_memory_tools` — explicit memory

Two real `FunctionTool`s for agents that should decide when to remember:

```python
from agents import Agent
from cortadel_openai_agents import cortadel_memory_tools

agent = Agent(
    name="Assistant",
    instructions="Search your memory before answering personal questions.",
    tools=cortadel_memory_tools("e2e-alice", base_url="http://localhost:3001"),
)
```

| Tool | Parameters | Returns |
|---|---|---|
| `search_memory` | `query: str` | Numbered relevant memories, or "No relevant memories found." |
| `add_memories` | `text: str` | What the write pipeline did (`Stored.`, `Already remembered…`) |

Schemas are derived by `@function_tool` from the signatures and docstrings, and are strict
(`additionalProperties: false`). The two shapes compose — give an agent a `CortadelSession` *and*
`tools=session.tools()` for automatic recall plus an explicit "look it up again" escape hatch.

### Failure behaviour

Memory degrades; it never takes down the agent. If Cortadel is unreachable, a search returns
nothing and the model call proceeds unchanged, a write is dropped, and a tool call tells the model
memory is unavailable.

Two independent knobs govern that, and both are available on `CortadelSession` and
`cortadel_memory_tools`:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `raise_on_error` | `bool` | `False` | Propagate memory failures to the caller instead of degrading. |
| `on_error` | `(Exception) -> None \| None` | `None` | Called with the exception on **every** memory failure. May be `async`. |

```python
session = CortadelSession(
    session_id="chat-1",
    user_id="e2e-alice",
    on_error=lambda exc: sentry_sdk.capture_exception(exc),
)
```

`on_error` *observes*; `raise_on_error` *propagates* — they compose. With no callback set, a
swallowed failure is logged as a warning on the `cortadel_openai_agents` logger; setting a
callback replaces that log rather than doubling it. A callback that raises is itself logged and
dropped, so your telemetry going down cannot become the agent's problem.

## Configuration

### `CortadelSession(session_id, user_id, **options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str` | *required* | Conversation id. Keys the transcript, and sent as Cortadel's `ConversationOptions.session_id`. |
| `user_id` | `str` | *required* | Memory namespace owner. **One session serves one user** — a Cortadel client is bound to a user id at construction and no method takes one. |
| `base_url` | `str` | `$CORTADEL_BASE_URL` → `http://localhost:3001` | Cortadel server URL. |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server has auth disabled. |
| `app_name` | `str` | `"cortadel-openai-agents"` | Recorded for access logging on searches. |
| `client` | `CortadelClient \| None` | `None` | Use a pre-built client instead. Must already be scoped to `user_id`; you keep ownership of closing it. |
| `transcript` | `Session \| None` | in-memory `SQLiteSession` | Where verbatim history lives. |
| `top_k` | `int` | `5` | Memories recalled per turn. |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text`, or `vector`. |
| `rerank` | `str \| None` | `None` | Set `"cross_encoder"` to rerank server-side. |
| `min_score` | `float \| None` | `None` | Drop hits below this `rrf_score`. |
| `scope_recall_to_session` | `bool` | `False` | Recall only facts extracted from *this* conversation (`SearchOptions.session_id`). Off by default — long-term memory earns its name by crossing conversations. |
| `inject_as` | `"instructions" \| "input"` | `"instructions"` | Append the block to the system prompt, or insert it as a system message immediately before the latest user message (leaves the earlier prefix byte-identical, so prompt caches still hit). |
| `memory_header` | `str` | `"# Long-term memory (Cortadel)"` | Heading of the injected block; also the double-injection marker. |
| `retrieve` | `bool` | `True` | Set `False` to store without recalling. |
| `store` | `bool` | `True` | Set `False` to recall without storing. |
| `await_persist` | `bool` | `True` | Whether the write is awaited before the turn returns. See below. |
| `tags` | `list[str] \| None` | `None` | Tags applied to every fact extracted from this conversation. |
| `project` | `str \| None` | `None` | Project scope for extracted facts. |
| `raise_on_error` | `bool` | `False` | Surface Cortadel failures instead of degrading. |
| `on_error` | `(Exception) -> None \| None` | `None` | Observe every Cortadel failure; replaces the warning log. May be `async`. |
| `session_settings` | `SessionSettings \| dict \| None` | `None` | Standard SDK session settings (`limit`), forwarded to the transcript. |

**Why `await_persist` defaults to `True` here** (the repo-wide default is fire-and-forget):
`Runner.run()` is frequently the last thing a process does, so a write left in flight would be
cancelled at event-loop shutdown and the memory silently lost. Set `await_persist=False` to keep
Cortadel's extraction latency off the turn, and close the session — `await session.aclose()`, or
just `async with` — so pending writes are drained before you exit. `await session.flush()` drains
them too, any time you need a hard synchronisation point. A background write is not awaited by
anyone, so `raise_on_error` cannot apply to it: those failures always go to `on_error` or the log.

### `cortadel_memory_tools(user_id=None, **options)`

Takes `base_url`, `api_key`, `app_name`, `client`, `top_k`, `search_mode`, `rerank`, `min_score`,
`raise_on_error` and `on_error` with the same meanings, plus `session_id` (restrict
`search_memory` to one conversation; `None` searches everything the user has). Pass either
`user_id` or an already-scoped `client`, not both.

Two defaults differ from `CortadelSession`, deliberately:

- **`top_k` defaults to `10`**, the Cortadel SDK's own `SearchOptions` default. An agent that
  chose to call `search_memory` can spend more context on the answer than a per-turn injection
  that fires whether or not memory was needed.
- **`session.tools()` inherits the session's settings instead** — including its `top_k` (`5` by
  default) and its `scope_recall_to_session` — so an explicit tool call and an automatic recall
  never disagree about what the user's memory contains.

### Multiple users

Because scoping happens at construction, serve several users by building one session (or one
toolset) per user:

```python
sessions = {user_id: CortadelSession(session_id=f"chat-{user_id}", user_id=user_id)
            for user_id in ("e2e-alice", "e2e-bob")}
```

## Running the tests

The suite is fully offline — no network, no Cortadel server, no API keys. The Cortadel boundary is
a fake client; the model boundary is a fake `Model`, so several tests drive a real `Runner.run()`.

```bash
cd integrations/openai-agents
uv sync --extra test
uv run pytest -q
```

## Requirements

- **Python** ≥ 3.10
- **`openai-agents`** ≥ 0.10.0 — the first release exporting `ModelInputData` / `CallModelData` /
  `CallModelInputFilter` from `agents.run` and `SessionSettings` from `agents`. Verified against
  0.20.0.
- **`cortadel`** ≥ 1.0.0, < 2.0.0
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` (→ `http://localhost:3001`). See
  [self-hosting](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md).

### Known limits

- **Sessions and server-managed conversations are mutually exclusive.** The SDK forbids combining
  a `session=` with `conversation_id`, `previous_response_id` or `auto_previous_response_id`. Use
  `cortadel_memory_tools` if you need OpenAI server-side conversation continuation.
- **`clear_session()` clears the transcript, not Cortadel.** Closing a chat window is not a request
  to forget the user. Delete memories deliberately with `client.delete([...])`.
- **`pop_item()` rewinds history, not memory.** Facts already written are bi-temporal — superseded,
  never silently erased. Unflushed messages *are* dropped on pop.

## Links

- [Cortadel on GitHub](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)

Apache-2.0.
