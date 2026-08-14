# Cortadel × CrewAI

[Cortadel](https://cortadel.ai) is self-hosted long-term memory for AI agents — a bi-temporal
graph store with hybrid BM25 + vector search. This package makes it a drop-in replacement for
CrewAI's built-in memory, so a crew remembers what it learned in previous runs instead of
starting from zero every kickoff. Point it at a Cortadel server and the retrieval, embedding,
deduplication, entity extraction, and versioning all happen server-side.

## Install

```bash
pip install cortadel-crewai
```

## Quickstart

```python
from crewai import Agent, Crew, Task
from cortadel_crewai import CortadelMemory

# One Cortadel client is bound to one user id, so one CortadelMemory == one user.
memory = CortadelMemory(
    base_url="http://localhost:3001",
    user_id="e2e-crewai-demo",
)

researcher = Agent(
    role="Research Analyst",
    goal="Answer questions using everything the team already knows",
    backstory="You have a long memory and hate repeating work.",
)

task = Task(
    description="What deployment target did we settle on, and why?",
    expected_output="A short answer citing the earlier decision.",
    agent=researcher,
)

crew = Crew(agents=[researcher], tasks=[task], memory=memory)
print(crew.kickoff())
```

That is the whole integration. Before each task the agent recalls from Cortadel; anything it
chooses to save goes back to Cortadel.

## What you get

### 1. `CortadelMemory` — automatic memory

A real subclass of `crewai.Memory`, accepted anywhere CrewAI takes a memory instance:
`Crew(memory=...)`, `Agent(memory=...)`, or a scoped view via `memory.scope("/agent/researcher")`.

It overrides the text-level API that every CrewAI consumer actually calls:

| CrewAI call | Cortadel call |
|---|---|
| `recall(query, limit=N)` — `Agent` before each task, `LiteAgent`, `Flow`, `RecallMemoryTool` | `search(query, SearchOptions(top_k=N, mode, rerank))` |
| `remember(content, ...)` / `remember_many([...])` — `RememberTool` and any explicit save | `add(text, AddOptions(...))` |
| `remember_conversation(messages)` (added by this package) | `add_conversation(messages, ConversationOptions(...))` |
| `list_records(limit, offset)` | `list(ListOptions(page, size))` |
| `forget(record_ids=[...])` | `delete(ids)` |

Because it is a genuine `Memory`, CrewAI's own built-in `Search memory` / `Save to memory`
tools (`create_memory_tools`) route to Cortadel automatically too.

### 2. `cortadel_tools()` — agent-invoked memory

Native `crewai.tools.BaseTool` subclasses with pydantic `args_schema` models, for when the agent
should decide when to remember:

```python
from crewai import Agent
from cortadel_crewai import cortadel_tools

agent = Agent(
    role="Support Engineer",
    goal="Resolve tickets without asking the customer to repeat themselves",
    backstory="You look things up before you ask.",
    tools=cortadel_tools(base_url="http://localhost:3001", user_id="e2e-crewai-demo"),
)
```

This gives the agent `search_memory` and `add_memories`. Works with or without `CortadelMemory`.

### 3. `CortadelConversationListener` — turn-level capture

An event-bus listener (`crewai.events.BaseEventListener`) that hands each completed task to
Cortadel's extraction pipeline, so durable facts are distilled without the agent deciding
anything:

```python
from cortadel_crewai import CortadelConversationListener

listener = CortadelConversationListener(user_id="e2e-crewai-demo", session_id="nightly-run")
crew.kickoff()   # each finished task is persisted via add_conversation
```

Keep a reference to the listener for as long as you want it active.

## Configuration

`CortadelMemory` accepts every `crewai.Memory` field (`read_only`, `root_scope`,
`default_importance`, …) plus:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str` | `$CORTADEL_BASE_URL` or `http://localhost:3001` | Cortadel server URL |
| `user_id` | `str` | `$CORTADEL_USER_ID` | User that owns the memories. **Required** — one instance per user |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Bearer token; omit when the server runs with auth disabled |
| `app_name` | `str` | `"cortadel-crewai"` | Recorded for access logging on searches |
| `client` | `SyncCortadelClient \| None` | `None` | Inject a pre-built client instead of constructing one |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text`, or `vector` |
| `rerank` | `str \| None` | `None` | Set to `"cross_encoder"` to rerank with Cortadel's cross-encoder |
| `memory_type` | `str \| None` | `None` | Pin/filter a cognitive type: `episodic`, `semantic`, `procedural` |
| `infer` | `bool` | `True` | `False` stores text verbatim and skips entity/category extraction |
| `raise_on_error` | `bool` | `False` | `True` propagates Cortadel errors instead of degrading |
| `on_error` | `Callable[[BaseException], None] \| None` | `None` | Called with the exception on every Cortadel failure |
| `dedupe_window` | `int` | `0` | Suppress the last N memory **ids** already returned by `recall` |

`cortadel_tools()` takes `base_url` / `user_id` / `api_key` / `app_name` / `client` /
`raise_on_error` / `on_error`. `CortadelConversationListener` takes those seven plus `session_id`
(groups every fact extracted during a run), `project` (e.g. a repository name), `tags` (applied to
every extracted fact), `is_agent_memory` (`True` extracts facts about the *assistant* — usually
what a self-improving crew wants) and `min_output_chars` (default `1`; skip tasks whose output is
shorter).

The `search_memory` tool takes `query` and `top_k` (default `10`, clamped to Cortadel's 1–50
range). `CortadelMemory.recall()` keeps CrewAI's own parameter name, `limit`, because it overrides
`crewai.Memory.recall` and the framework calls it by keyword (`recall(query, limit=5)` in
`crewai/agent/core.py`); it maps straight onto `SearchOptions.top_k`.

### Degrading gracefully

By default every Cortadel call is guarded: if the server is unreachable, the call logs a warning
to the `cortadel_crewai` logger and returns an empty result. An agent runs without memory rather
than crashing — a memory outage should never take the crew down. Set `raise_on_error=True` to opt
into hard failures.

`on_error` is an **observer, not a handler**: it is called with the exception on every failure,
including the ones `raise_on_error=True` goes on to re-raise. Setting it replaces the default
warning log, so route it wherever you actually watch (Sentry, a metric, your own logger):

```python
memory = CortadelMemory(user_id="e2e-crewai-demo", on_error=lambda exc: sentry_sdk.capture_exception(exc))
```

A callback that raises is swallowed and logged, so a broken observer can never mask the original
failure. On the listener, note where a re-raised error lands: its handler runs on CrewAI's
event-bus thread pool, so the error surfaces on the bus `Future`, not in the task that produced it.

One wrinkle worth knowing: a degraded `remember()` returns an **unpersisted placeholder record**
(`record.id == ""`, `record.metadata["cortadel_persisted"] is False`) rather than `None`. CrewAI's
own `Save to memory` tool reads `record.scope` / `record.importance` straight off that return value
with no `None` check, so returning `None` would turn an unreachable server into an `AttributeError`
inside the agent loop. `remember_many()` still returns only what was actually stored, so a fully
degraded batch is `[]`.

### Avoiding re-injected memories

CrewAI re-recalls on every turn (`Agent` recalls the task description, then the whole message
history at kickoff), so the same facts can land in the prompt repeatedly. Set `dedupe_window=N` to
suppress the last N memory **ids** returned by `recall`. Note that the window counts ids, not
recalls: with `dedupe_window=50` and ten hits per recall it spans roughly the last five recalls. It
defaults to `0` (off), because suppression is wrong when an agent legitimately asks the same
question twice.

## What does not map

Stated plainly, because two memory systems are meeting here and only one of them can be in charge:

- **Cortadel is a flat per-user namespace.** CrewAI's scope hierarchy (`/crew/research/...`) and
  its category taxonomy are sent to Cortadel as `AddOptions.metadata` for provenance, but they
  are **not retrieval filters** — `recall(scope=..., categories=...)` does not narrow the search.
  Cortadel does its own organisation (entity graph, server-inferred categories).
- **`depth="deep"` is ignored.** CrewAI's deep recall drives a local LLM flow over a vector
  store; Cortadel already fuses BM25 and vector arms with RRF server-side. Running both would pay
  for a second, weaker retrieval brain.
- **`update()`, `reset()`, `reset_all()` are inert.** Cortadel is bi-temporal — corrections are
  new writes that supersede old versions server-side, and there is no bulk-reset endpoint. To
  delete, pass explicit ids to `forget(record_ids=[...])`.
- **`forget()` without `record_ids` deletes nothing** and returns `0`, rather than guessing at
  criteria the server cannot express. With ids it returns `len(record_ids)`, not a server-side
  count — Cortadel's `delete` answers with a confirmation string, so deleting two ids of which one
  never existed still reports `2`.
- **`list_records(offset=...)` is approximate.** Cortadel paginates by page/size with no row
  offset, so the offset is floored to a page boundary: `list_records(limit=50, offset=25)` returns
  records 0–49. Pass an offset that is a multiple of `limit` for an exact window.
- **Automatic post-task saves go through a CrewAI-side LLM first.** This package does not override
  `extract_memories()`, so CrewAI's own auto-save
  (`base_agent_executor` → `memory.extract_memories(raw)` → `memory.remember_many(...)`) distils
  the task text with *its* LLM (`Memory.llm`, default `gpt-5.4-mini`) before Cortadel sees it. With
  no LLM key configured that step raises, CrewAI logs "Failed to save to memory", and the auto-save
  silently no-ops — **recall still works, but nothing is written**. To write without a CrewAI-side
  LLM, use `CortadelConversationListener` (which calls `add_conversation` directly and lets
  Cortadel do the extraction), `cortadel_tools()`, or an explicit `memory.remember(...)`.
- **`Agent(memory=...)` does not survive `Crew.copy()`.** `BaseAgent.copy()` re-validates the agent
  through a `model_dump()`, and CrewAI's discriminated union turns a `CortadelMemory` back into a
  plain `crewai.Memory`. `Crew.copy()` copies every agent this way, and it is used by
  `kickoff_for_each()`, `train()` and `test()`. Crew-level memory is unaffected (`Crew.copy()`
  reattaches the live instance), so **with those three entry points rely on `Crew(memory=...)`, not
  `Agent(memory=...)`**. A plain `kickoff()` keeps both.
- **Metadata does not round-trip.** The Cortadel Python SDK always returns `None` for
  `MemoryListItem.metadata` / `MemoryDetail.metadata`, so the CrewAI bookkeeping written on save
  cannot be read back through this SDK.
- **`StorageBackend` is not implemented.** CrewAI's storage protocol searches by
  `query_embedding: list[float]`; Cortadel's API takes a *text* query and embeds it itself, so
  that seam cannot be served faithfully. This package plugs in one level up, at the text API.

## Running the tests

The suite is fully offline — no server, no API keys, no network.

```bash
uv sync --extra test
uv run pytest -q
```

## Requirements

- Python **≥ 3.11, < 3.14**. The upper bound mirrors crewai's own range; the lower bound is one
  version above it because 3.10 cannot actually be installed — crewai pulls chromadb, whose
  Python-3.10 branch resolves to `onnxruntime` 1.24.3, and that release ships no cp310 wheel and
  no sdist at all.
- `crewai` **≥ 1.10.0** — this implements the unified `crewai.Memory` surface, and **1.10.0 is the
  release that introduced it**. `crewai.memory.unified_memory` and `crewai.memory.types` do not
  exist in 1.0.0–1.9.3, so this package cannot import on those versions. 1.10.0 is also the
  release that *removed* the older `ExternalMemory` + `crewai.memory.storage.interface.Storage`
  seam (which shipped right through 1.9.3); that seam is not supported here. Only crewai 1.15.15
  has been tested — 1.10.0 is the true minimum, not a verified-working floor.
- `cortadel` **≥ 1.0, < 2.0**
- A running Cortadel server: hosted at `https://app.cortadel.ai`, or self-host with
  `docker compose up` → `http://localhost:3001`.

## Links

- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)
