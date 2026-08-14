---
title: Cortadel × CrewAI
description: A drop-in crewai.Memory backed by your Cortadel server, native crew tools, and a task-completed listener.
---

`cortadel-crewai` makes Cortadel the memory a CrewAI crew runs on. Hand one `CortadelMemory` to
`Crew(memory=...)` and every agent recalls from your Cortadel server before a task and writes back
to it afterwards, so the crew keeps what it learned between kickoffs instead of starting from zero.
Retrieval (hybrid BM25 + vector fused with RRF), embedding, deduplication, entity extraction and
bi-temporal versioning all happen server-side — nothing is embedded locally, and no local vector
store is created. Two smaller seams ship alongside it: `search_memory` / `add_memories` as native
CrewAI tools for agents that should decide when to remember, and an event-bus listener that hands
each finished task to Cortadel's extraction pipeline.

## Install

```bash
pip install cortadel-crewai
```

## Quickstart

```python
import os

from crewai import Agent, Crew, Task

from cortadel_crewai import CortadelMemory

# A Cortadel client is bound to ONE user id at construction — there is no per-call
# user parameter, so build one CortadelMemory per user you serve.
memory = CortadelMemory(
    base_url=os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001"),
    user_id="e2e-crewai-demo",
    # api_key="...",          # omit when the server runs with auth disabled
    rerank="cross_encoder",    # let Cortadel rerank with its cross-encoder
    dedupe_window=50,          # don't re-inject facts recalled a moment ago
)

engineer = Agent(
    role="Platform Engineer",
    goal="Answer infrastructure questions using what the team already decided",
    backstory="You have a long memory and never make the team relitigate a settled question.",
)

task = Task(
    description="Which cluster does the billing service deploy to, and what did we decide "
    "about its database? If you do not know yet, say so plainly.",
    expected_output="A short recommendation, citing the earlier decision if one exists.",
    agent=engineer,
)

# Seed a decision so the next run has something to find.
memory.remember(
    "The billing service deploys to the eu-west staging cluster, "
    "backed by the shared Postgres instance rather than its own database."
)

crew = Crew(agents=[engineer], tasks=[task], memory=memory)
print(crew.kickoff())

memory.close()
```

Run it twice: the first kickoff has nothing to recall, the second answers from what the first one
learned, because the memories outlived the process. The agents themselves still need their own LLM
key (`OPENAI_API_KEY` or whatever CrewAI is configured with) — Cortadel does its embedding and
extraction server-side, so that key is for the agents, not for memory.

## What you get

Three independent seams. Use any combination.

**1. `CortadelMemory` — automatic memory.** A real subclass of `crewai.Memory`, accepted anywhere
CrewAI takes a memory instance: `Crew(memory=...)`, `Agent(memory=...)`, or a scoped view via
`memory.scope("/agent/researcher")`. Every turn recalls before the task and stores after it, without
the agent cooperating or even knowing. Because it is a genuine `Memory`, CrewAI's own built-in
`Search memory` / `Save to memory` tools (`crewai.tools.memory_tools.create_memory_tools`) route to
Cortadel too.

**2. `cortadel_tools()` — agent-invoked memory.** Two `crewai.tools.BaseTool` subclasses, named
`search_memory` and `add_memories`, sharing one client:

```python
from crewai import Agent

from cortadel_crewai import cortadel_tools

support = Agent(
    role="Support Engineer",
    goal="Resolve issues without asking the customer to repeat themselves",
    backstory="You look things up before you ask.",
    tools=cortadel_tools(base_url="http://localhost:3001", user_id="e2e-crewai-demo"),
)
```

`search_memory` takes `query` and `top_k` and returns the hits as a formatted list, with each hit's
categories in front of it. `add_memories` takes `messages` (a list of self-contained statements),
stores each one, and reports back how many were saved and how many Cortadel recognised as duplicates
— a 2xx does not mean a new memory was written, so the tool reads the `SKIP_DUPLICATE` event rather
than counting requests. Both work with or without `CortadelMemory`.

**3. `CortadelConversationListener` — turn-level capture.** An event-bus listener that writes each
completed task to Cortadel as a two-turn conversation (task description as the `user` message, task
output as the `assistant` message) through `add_conversation`, so Cortadel's own extraction pipeline
distils the durable facts without the agent deciding anything and without a CrewAI-side LLM hop:

```python
from cortadel_crewai import CortadelConversationListener

listener = CortadelConversationListener(
    user_id="e2e-crewai-demo",
    session_id="billing-service-rollout",
    project="platform",
)
crew.kickoff()   # each finished task is persisted via add_conversation
```

Constructing it is enough — `BaseEventListener.__init__` subscribes it to the global bus. Keep the
reference for as long as you want it active: a garbage-collected listener takes its client with it.

## Configuration

`CortadelMemory` accepts every `crewai.Memory` field (`read_only`, `root_scope`,
`default_importance`, …) plus:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server origin |
| `user_id` | `str \| None` | `$CORTADEL_USER_ID` | User that owns the memories. **Required** — construction raises `ValueError` without one |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Bearer token; omit when the server runs with auth disabled |
| `app_name` | `str` | `"cortadel-crewai"` | App name recorded for access logging, and sent as `AddOptions.app` on writes |
| `client` | `SyncCortadelClient \| None` | `None` | Inject a pre-built client instead of constructing one |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text`, or `vector` |
| `rerank` | `str \| None` | `None` | Set to `"cross_encoder"` to rerank with Cortadel's cross-encoder |
| `memory_type` | `str \| None` | `None` | Pin on writes and filter reads: `episodic`, `semantic`, `procedural` |
| `infer` | `bool` | `True` | `False` stores text verbatim and skips Cortadel's entity/category extraction |
| `raise_on_error` | `bool` | `False` | `True` propagates Cortadel errors instead of degrading to empty results |
| `on_error` | `Callable[[BaseException], None] \| None` | `None` | Callback handed the exception on every Cortadel failure |
| `dedupe_window` | `int` | `0` | When > 0, suppress the last N memory **ids** already returned by `recall`; `0` disables it |

`api_key` and `on_error` are declared `exclude=True, repr=False`, so neither the token nor a
non-serialisable callable reaches `repr(memory)` or `model_dump()` — which matters because
`Crew.copy()` dumps every agent.

`cortadel_tools()` takes `base_url` / `user_id` / `api_key` / `app_name` / `client` /
`raise_on_error` / `on_error`, and builds both tools around one shared client.
`CortadelConversationListener` takes those seven plus:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str \| None` | `None` | Groups every fact extracted during this run |
| `project` | `str \| None` | `None` | Project scope, e.g. a repository name |
| `tags` | `list[str] \| None` | `None` | Tags applied to every extracted fact |
| `is_agent_memory` | `bool` | `False` | `True` extracts facts about the *assistant* — what a self-improving crew wants |
| `min_output_chars` | `int` | `1` | Skip tasks whose output is shorter than this |

The `search_memory` tool's `top_k` defaults to `10`, matching the SDK's own `SearchOptions`; its
`mode` and `rerank` mirror `search_mode` / `rerank` above. Every retrieval count — the tool's
`top_k` and the `limit` CrewAI passes into `recall` — is clamped into Cortadel's accepted 1–50 range
before it goes out.

:::note
**Memory degrades, it does not escalate.** Every Cortadel call is wrapped in a guard: an
unreachable server logs a warning to the `cortadel_crewai` logger and the call returns an empty
result, so an agent runs without memory rather than crashing. `raise_on_error=True` opts into hard
failures. `on_error` is an **observer, not a handler** — it fires on every failure, including the
ones `raise_on_error` goes on to re-raise, and setting it replaces the default warning log. A
callback that itself raises is swallowed and logged, so a broken observer can never mask the
original failure.
:::

CrewAI re-recalls on every turn (the task description before a task, then the whole message history
at kickoff), so the same facts can land in the prompt repeatedly. `dedupe_window=N` suppresses the
last N memory **ids** already returned — a window of ids, not of recalls, so `dedupe_window=50` with
ten hits per recall spans roughly the last five. It is off by default, because suppression is wrong
when an agent legitimately asks the same question twice.

## How it works

The extension point is **`crewai.memory.unified_memory.Memory`** — the single memory class CrewAI
1.10.0 introduced when it collapsed the old short-term/long-term/entity/external split.
`CortadelMemory` subclasses it and overrides the **text-level** API that every consumer in the
framework actually calls:

| CrewAI call | Cortadel call |
|---|---|
| `recall(query, limit=N)` — `Agent` before a task, `LiteAgent`, `Flow`, the built-in `Search memory` tool | `search(query, SearchOptions(top_k=N, mode, rerank, memory_type))` |
| `remember(content, ...)` / `remember_many([...])` — the built-in `Save to memory` tool and any explicit save | `add(text, AddOptions(app, metadata, infer, memory_type))` |
| `remember_conversation(messages)` — added by this package | `add_conversation(messages, ConversationOptions(...))` |
| `list_records(limit, offset)` | `list(ListOptions(page, size, memory_type))` |
| `forget(record_ids=[...])` | `delete(ids)` |

CrewAI supplies the retrieval count itself rather than the package choosing one: `recall(query,
limit=5)` before a task, `limit=20` for the kickoff message history and for its built-in
`Search memory` tool, `limit=10` in `LiteAgent`.

Overriding the text API is the deliberate choice, and it is what the page below the README is for.
One level down sits **`crewai.memory.storage.backend.StorageBackend`**, the `runtime_checkable`
protocol CrewAI's own LanceDB backend implements — and its `search()` takes a
`query_embedding: list[float]`. Cortadel's API takes a *text* query and embeds it itself with its own
model, so that seam cannot be served faithfully; serving it would mean embedding locally with a
different model than the corpus was written with. So this package plugs in one level up, and fills
the `storage` slot with `InertStorage`, a structurally-compatible no-op. That slot cannot simply be
left empty: `Memory`'s `storage` field defaults to the string `"lancedb"`, and
`Memory.model_post_init` builds a real LanceDB store whenever it finds a `str` there. Handing it a
non-`str` object short-circuits that branch, so importing this package never pulls in LanceDB, never
writes `./.crewai` into your working directory, and never needs an embedder or an `OPENAI_API_KEY`
for memory. The inherited scope helpers that are deliberately not overridden (`list_scopes`, `info`,
`tree`, `list_categories`) still call through to it, and get "nothing here" instead of an
`AttributeError`.

The other two seams are the framework's own as well. The tools are ordinary
`crewai.tools.BaseTool` subclasses with pydantic `args_schema` models, so they drop into
`Agent(tools=[...])` beside anything else. The listener is a `crewai.events.BaseEventListener` whose
`setup_listeners()` registers an `@crewai_event_bus.on(TaskCompletedEvent)` handler — CrewAI's
documented way to observe a run.

Underneath, everything goes through `cortadel.SyncCortadelClient`, the blocking client with one
background event loop for its lifetime, because CrewAI calls memory synchronously from agent and task
threads. `arecall()` delegates to the sync override.

## Known limits

- **Recall keeps CrewAI's `limit`, not the repo-wide `top_k`.** `CortadelMemory.recall` overrides
  `crewai.Memory.recall`, and the framework calls it by keyword in four places, so renaming the
  parameter would break the integration outright. It maps straight onto `SearchOptions.top_k`. The
  `search_memory` tool does use `top_k`.
- **No `await_persist` and no `scope_recall_to_session`.** Every write here is blocking, so there is
  no detached write to wait for. The SDK's `SearchOptions.session_id` is never set, so recall always
  searches everything Cortadel knows about the user; the listener's `session_id` groups writes only.
- **Cortadel is a flat per-user namespace.** CrewAI's scope hierarchy (`/crew/research/...`) and its
  category taxonomy are sent along as `AddOptions.metadata` for provenance, but they are **not
  retrieval filters** — `recall(scope=..., categories=...)` does not narrow the search. Cortadel does
  its own organisation (entity graph, server-inferred categories).
- **`depth="deep"` is accepted and ignored.** CrewAI's deep recall drives a local LLM flow over a
  vector store; Cortadel already fuses BM25 and vector arms with RRF server-side and will
  cross-encode on request. Running both would pay for a second, weaker retrieval brain.
- **`update()`, `reset()` and `reset_all()` are inert.** Cortadel is bi-temporal: a correction is a
  new write that supersedes the older version server-side, and there is no bulk-reset endpoint.
  Editing or wiping in place would destroy that history. To delete, pass explicit ids to
  `forget(record_ids=[...])`.
- **`forget()` without `record_ids` deletes nothing** and returns `0`, rather than guessing at
  criteria the server cannot express. With ids it returns `len(record_ids)`, not a server-side count
  — Cortadel's `delete` answers with a confirmation string, so deleting two ids of which one never
  existed still reports `2`.
- **`list_records(offset=...)` is approximate.** Cortadel paginates by page/size with no row offset,
  so the offset is floored to a page boundary: `list_records(limit=50, offset=25)` returns records
  0–49. Pass an offset that is a multiple of `limit` for an exact window. Page size is capped at 100.
- **CrewAI's own auto-save runs a CrewAI-side LLM first.** This package does not override
  `extract_memories()`, so the framework's automatic post-task save
  (`base_agent_executor` → `memory.extract_memories(raw)` → `memory.remember_many(...)`) distils the
  task text with *its* LLM (`Memory.llm`, default `gpt-5.4-mini`) before Cortadel sees it. With no
  LLM key configured that step raises, CrewAI logs "Failed to save to memory", and the auto-save
  silently no-ops — **recall still works, but nothing is written**. To write without a CrewAI-side
  LLM, use `CortadelConversationListener`, `cortadel_tools()`, or an explicit `memory.remember(...)`.
- **`Agent(memory=...)` does not survive `Crew.copy()`.** `BaseAgent.copy()` re-validates the agent
  through a `model_dump()`, and CrewAI's discriminated union turns a `CortadelMemory` back into a
  plain `crewai.Memory`. `Crew.copy()` copies every agent this way, and `kickoff_for_each()`,
  `train()` and `test()` all use it. Crew-level memory is unaffected — `Crew.copy()` reattaches the
  live instance — so with those three entry points rely on `Crew(memory=...)`. A plain `kickoff()`
  keeps both.
- **A degraded `remember()` returns a placeholder, not `None`.** When the server call fails and
  `raise_on_error` is False you get an unpersisted record (`record.id == ""`,
  `record.metadata["cortadel_persisted"] is False`), because CrewAI's `Save to memory` tool reads
  `record.scope` / `record.importance` straight off that return value with no `None` check.
  `remember_many()` still returns only what was actually stored, so a fully degraded batch is `[]`.
- **A re-raised listener error lands on the bus, not in your task.** Its handler runs on CrewAI's
  event-bus thread pool, so with `raise_on_error=True` the error surfaces on the bus `Future`, not
  in the task that produced the output.
- **Metadata does not round-trip.** The Cortadel Python SDK always returns `None` for
  `MemoryListItem.metadata` / `MemoryDetail.metadata`, so the CrewAI bookkeeping written on save
  cannot be read back through this SDK.
- **One user per instance.** A Cortadel client is bound to one user id at construction; there is no
  per-call user parameter. Serve several users by building one `CortadelMemory` each.
- **Tested against one CrewAI release.** The test suite is fully offline (real CrewAI, stubbed
  Cortadel client, no server and no keys) and has only been run against `crewai` 1.15.15. The
  `>= 1.10.0` floor is derived from published wheel contents, not from a test run on 1.10.0.

## Requirements

- Python **≥ 3.11, < 3.14**. The upper bound mirrors crewai's own range; the lower bound is one
  version above it because 3.10 cannot actually be installed — crewai pulls chromadb, whose
  Python-3.10 branch resolves to `onnxruntime` 1.24.3, and that release ships no cp310 wheel and no
  sdist to build from.
- `crewai` **≥ 1.10.0** — the release that introduced the unified `crewai.Memory` surface.
  `crewai.memory.unified_memory` and `crewai.memory.types` do not exist in 1.0.0–1.9.3, so this
  package cannot import there. 1.10.0 is also the release that *removed* the older `ExternalMemory` +
  `crewai.memory.storage.interface.Storage` seam; that seam is not supported here.
- `cortadel` **≥ 1.0, < 2.0** — the [Python SDK](/sdk-python/), pulled in automatically.
- A running Cortadel server: the hosted service at `https://app.cortadel.ai`, or your own
  (`docker compose up` → `http://localhost:3001`, see [Self-hosting](/self-hosting/)). Mint the
  API key it needs with [Authentication](/authentication/).

## Links

- [`cortadel-crewai` on PyPI](https://pypi.org/project/cortadel-crewai/)
- [Source](https://github.com/cortadel/cortadel/tree/main/integrations/crewai) — including two
  runnable examples, one per seam
- [All integrations](/integrations/)
