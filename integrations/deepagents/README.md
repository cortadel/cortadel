# Cortadel × DeepAgents

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. This package wires it into
[LangChain DeepAgents](https://github.com/langchain-ai/deepagents) at the seam DeepAgents is built
out of: middleware. Drop `CortadelMemoryMiddleware` into `create_deep_agent(middleware=[...])` and
your agent recalls what it learned in past conversations before it plans, and remembers this one
after it finishes — across threads, processes and deployments, without you writing a retrieval
step.

DeepAgents already ships a long-term memory middleware (`MemoryMiddleware`), but it reads static
`AGENTS.md` files off a filesystem backend. Cortadel replaces the static read with a hybrid search
over a temporal graph that the agent writes back to automatically.

## Install

```bash
pip install cortadel-deepagents
# or
uv add cortadel-deepagents
```

This pulls in `deepagents`, `langchain`, `langgraph` and the `cortadel` Python SDK.

## Quickstart

```python
from deepagents import create_deep_agent

from cortadel_deepagents import CortadelMemoryMiddleware

memory = CortadelMemoryMiddleware(
    base_url="http://localhost:3001",   # or https://app.cortadel.ai
    user_id="e2e-demo-user",
    # api_key="...",                    # omit when the server has auth disabled
)

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",
    system_prompt="You are a helpful research assistant.",
    middleware=[memory],
)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "Draft the release notes the way I like them."}]},
    {"configurable": {"thread_id": "thread-1"}},
)
print(result["messages"][-1].content)
```

Nothing else is required. On the way in, the middleware searches Cortadel for memories relevant to
that message and injects them into the system prompt. On the way out, it saves the turn. Start a
brand-new thread tomorrow and the agent still knows how you like your release notes.

## What you get

### 1. Automatic memory — `CortadelMemoryMiddleware`

An `AgentMiddleware` subclass using three DeepAgents hooks:

| Hook | Runs | What it does |
|---|---|---|
| `before_agent` / `abefore_agent` | once per turn | Hybrid-searches Cortadel with the new user message; stores the hits in private state. |
| `wrap_model_call` / `awrap_model_call` | every model call | Renders those hits into a `<cortadel_memory>` block appended to the system message. |
| `after_agent` / `aafter_agent` | once per turn | Sends the turn's new messages to `add_conversation`, which distils durable facts. |

Retrieval sits in `before_agent`, not `before_model`, deliberately. A deep agent makes many model
calls per turn — planning, tool loops, subagent dispatch — and one search per *turn* is right;
one per *model call* would multiply latency and cost by the length of the loop for identical
results. The recalled set lives in checkpointed private state and is re-rendered on every model
call, so it is present for the whole loop without being re-fetched. The injection is applied to a
per-call `ModelRequest` override and never written back into the conversation, so the prompt does
not grow turn over turn. Recall is also skipped entirely when the last user message has not
changed — a run resumed after a human-in-the-loop interrupt does not re-search.

### 2. Memory tools — `search_memory` and `add_memories`

Two LangChain `StructuredTool`s, built the way DeepAgents builds its own built-ins (injected
`runtime: ToolRuntime`, explicit `args_schema`). They are registered on the middleware by default,
so the quickstart above already has them; use `create_cortadel_tools()` to get them standalone:

```python
from deepagents import create_deep_agent
from cortadel_deepagents import create_cortadel_tools

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",
    tools=create_cortadel_tools(base_url="http://localhost:3001", user_id="e2e-demo-user"),
)
```

| Tool | Arguments | Purpose |
|---|---|---|
| `search_memory` | `query: str`, `top_k: int = 10` | Look up something older than automatic recall surfaced. |
| `add_memories` | `memories: list[str]` | Record a durable fact the transcript would not make obvious. |

The tool's `top_k` defaults to 10 — the Cortadel SDK's own `SearchOptions` default — rather than
the 5 the middleware recalls automatically each turn: the model only reaches for the tool when
that automatic recall already came up short, so an explicit lookup should cast a wider net.

### Per-user scoping

A Cortadel client is bound to **one** `user_id` at construction — no SDK method takes a user id.
DeepAgents carries per-run identity in LangGraph's `runtime.context` and `config["configurable"]`,
so the middleware resolves an id per run and keeps one cached client per user:

1. `runtime.context.user_id` — the typed context declared with
   `create_deep_agent(context_schema=...)`. Preferred.
2. `config["configurable"]["user_id"]` — what LangGraph Server/Studio and most hand-rolled callers
   set.
3. The `user_id=` constructor argument, then `$CORTADEL_USER_ID`.

```python
from dataclasses import dataclass
from deepagents import create_deep_agent
from cortadel_deepagents import CortadelMemoryMiddleware

@dataclass
class Ctx:
    user_id: str

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",
    middleware=[CortadelMemoryMiddleware(base_url="http://localhost:3001")],
    context_schema=Ctx,
)
agent.invoke({"messages": [...]}, context=Ctx(user_id="e2e-demo-user"))
```

Rename the key with `user_id_key="account_id"`, or take over construction entirely with
`client_factory=lambda user_id: SyncCortadelClient(...)`. If no id can be resolved, the run
proceeds with memory disabled and one warning — it never fails.

LangGraph's `thread_id` maps onto Cortadel's `session_id` — a thread *is* the session here. It is
always attached to writes, and attached to reads too if you set `scope_recall_to_session=True`.

### Degrading gracefully

Every Cortadel call is wrapped. A server that is down, slow, unauthenticated or simply not
configured produces a log warning and an agent that runs without memory — never a failed turn.
The tools return an explanatory string instead of raising, so the model can carry on.

Two independent knobs control that, and they do different jobs:

```python
CortadelMemoryMiddleware(
    base_url="http://localhost:3001",
    user_id="e2e-demo-user",
    on_error=report_to_your_error_tracker,  # observe every failure
    raise_on_error=False,                   # ...but keep failing open
)
```

- `on_error` **observes**. It is a callback taking the exception, called for every failed Cortadel
  call — recall, persistence, and both tools — including failures that `raise_on_error` then
  re-raises. When it is unset, a swallowed failure is logged as a `logging` warning instead; when
  it is set, the callback replaces that log line. A callback that raises is itself swallowed and
  logged, so an observer can never take the agent down.
- `raise_on_error` **decides**. `False` (the default) fails open: memory must never take the agent
  down. `True` re-raises, and makes the tools raise rather than return their explanatory string —
  useful in tests and CI where a silent memory outage would let a broken suite pass.

Both are forwarded to the tools the middleware registers, so one setting governs the whole
integration; `create_cortadel_tools()` takes them directly when you build the tools standalone.

### Persistence always awaits

There is no fire-and-forget write option. `after_agent` is the last node of the run, so a detached
write could be cut off when the run — or the process — ends, and the `cortadel_persisted_count`
cursor could not be advanced honestly. The async hooks offload the blocking SDK call with
`asyncio.to_thread`, so awaiting it does not block the agent's event loop. A failed write does not
advance the cursor: the turn is retried with the next turn's suffix, and Cortadel's write pipeline
deduplicates.

## Configuration

All arguments to `CortadelMemoryMiddleware` are keyword-only.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str \| None` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server URL. Hosted: `https://app.cortadel.ai`. |
| `user_id` | `str \| None` | `$CORTADEL_USER_ID` | Static Cortadel user id. Omit for multi-user agents. |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Sent as `Authorization: Bearer`. Omit when auth is disabled. |
| `app_name` | `str` | `"cortadel-deepagents"` | Recorded on searches for access logging; used as `AddOptions.app` on writes. |
| `client` | `SyncCortadelClient \| None` | `None` | Bring your own client. Pins the middleware to that client's user; never closed by `close()`. |
| `client_factory` | `(str) -> SyncCortadelClient \| None` | `None` | Per-user client construction under your control. |
| `user_id_key` | `str` | `"user_id"` | Attribute on `runtime.context` / key in `config["configurable"]` holding the user id. |
| `top_k` | `int` | `5` | Memories recalled per turn (1–50). The `search_memory` tool defaults to `10` instead. |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text`, or `vector`. |
| `rerank` | `bool` | `False` | Run Cortadel's cross-encoder reranker. More accurate, slower. |
| `memory_type` | `str \| None` | `None` | Restrict to `episodic`, `semantic`, or `procedural`. |
| `scope_recall_to_session` | `bool` | `False` | Pass `thread_id` as `session_id` on *search*, limiting recall to this thread. |
| `write_memories` | `bool` | `True` | Persist each turn with `add_conversation`. `False` = read-only agent. |
| `is_agent_memory` | `bool` | `False` | Extract facts about the assistant instead of the user. |
| `tags` | `Sequence[str] \| None` | `None` | Tags applied to every extracted fact. |
| `project` | `str \| None` | `None` | Cortadel project scope (e.g. a repo name). |
| `expose_tools` | `bool` | `True` | Also register `search_memory` / `add_memories` on this middleware. |
| `system_prompt` | `str \| None` | `CORTADEL_SYSTEM_PROMPT` | Prompt fragment; must contain the `{cortadel_memories}` slot. `None` recalls into state without injecting. |
| `raise_on_error` | `bool` | `False` | Re-raise Cortadel failures instead of degrading. |
| `on_error` | `(Exception) -> None \| None` | `None` | Callback invoked with the exception on every failed Cortadel call. Observes; does not decide. |

`create_cortadel_tools()` accepts the connection arguments (`base_url`, `user_id`, `api_key`,
`app_name`, `client`, `client_factory`, `user_id_key`) plus `search_mode`, `rerank`,
`memory_type`, `raise_on_error` and `on_error`.

Environment variables read when the matching argument is omitted: `CORTADEL_BASE_URL`,
`CORTADEL_API_KEY`, `CORTADEL_USER_ID`.

## Examples

- [`examples/quickstart.py`](examples/quickstart.py) — single-user agent, two turns on the same
  thread, showing recall carrying over.
- [`examples/multi_user.py`](examples/multi_user.py) — one compiled agent serving many users, with
  the user id resolved from `context_schema`.

## Running the tests

The suite is fully offline: no network, no Cortadel server, no API keys. It stubs at the Cortadel
client boundary and drives the real DeepAgents graph with a fake chat model.

```bash
cd integrations/deepagents
uv sync --extra test
uv run pytest -q
```

## Requirements

- Python **≥ 3.11** (the floor `deepagents` itself declares) — the suite is run on 3.11, 3.12,
  3.13 and 3.14.
- `deepagents` **≥ 0.7.0, < 1.0** — verified against 0.7.5.
- `langchain` **≥ 1.3.14, < 2.0**, `langgraph` **≥ 1.0, < 2.0**.
- `cortadel` **≥ 1.0, < 2.0**.
- A running Cortadel server: hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` → `http://localhost:3001` (see
  [self-hosting](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md)).

## Design notes

**Why middleware and not a backend.** DeepAgents also has a `BackendProtocol` (`StateBackend`,
`StoreBackend`, `CompositeBackend`), and routing `/memories/` to a Cortadel-backed backend looks
tempting. It is the wrong fit. That protocol is a mutable file tree — `read`, `write`, `edit`,
`glob`, `grep`, `delete` — and `edit_file` is the centre of its memory UX. Cortadel's SDK exposes
`add`, `add_conversation`, `search`, `list`, `get`, `delete`, `health` and **no update**: edits are
bi-temporal supersessions that mint a new memory id, so an `edit_file` round trip could not honour
its own contract. `grep` over the store would also mean downloading every memory to filter it in
Python, throwing away the hybrid search that is the reason to use Cortadel at all. Middleware plus
tools uses Cortadel as what it is — a retrieval engine — and leaves the backend slot free for the
scratchpad files a deep agent genuinely wants.

**Relationship to `cortadel-langgraph`.** DeepAgents is built on LangGraph, and both integrations
exist. `cortadel-langgraph` targets graphs you assemble yourself — you own the nodes and decide
where memory goes. `cortadel-deepagents` targets the prebuilt `create_deep_agent` harness, where
you do not own the graph, and the only supported extension point is the middleware list; it also
handles deep-agent-specific concerns (many model calls per turn, resumed runs after
human-in-the-loop interrupts, subagent-safe tools) that a bare LangGraph node does not have to.
Use whichever matches how you built the agent; do not stack both.

## Links

- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)
- [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents)

Apache-2.0.
