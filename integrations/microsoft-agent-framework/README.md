# Cortadel × Microsoft Agent Framework

Long-term memory for agents built on the [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) (Python).

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. This package wires it into Agent
Framework through the framework's own extension points: a `ContextProvider` that recalls before
every model call and stores after every turn, plus `search_memory` / `add_memories` as real
`FunctionTool`s the agent can call on its own initiative. Your agent remembers what a user told
it last week, in a store you run yourself.

## Install

```bash
pip install cortadel-agent-framework
```

This pulls in `agent-framework-core` (the framework's core abstractions, not the full
`agent-framework` metapackage with every model provider) and the `cortadel` Python SDK. You will
also want a chat client — e.g. `pip install agent-framework-openai`.

## Quickstart

```python
import asyncio

from agent_framework import Agent
from agent_framework.openai import OpenAIChatClient
from cortadel_agent_framework import CortadelContextProvider, cortadel_memory_tools


async def main() -> None:
    # One provider per end user: a Cortadel client is bound to a single user id.
    async with CortadelContextProvider(
        base_url="http://localhost:3001",  # or https://app.cortadel.ai
        user_id="e2e-alice",               # in a real app, your end user's stable id
    ) as memory:
        agent = Agent(
            client=OpenAIChatClient("gpt-4o-mini"),
            instructions="You are a helpful assistant with long-term memory.",
            context_providers=[memory],                     # automatic recall + storage
            tools=cortadel_memory_tools(memory.client),     # optional: deliberate recall
        )

        # Turn one — stored automatically after the turn completes.
        await agent.run("I ship on Fridays and I prefer dark mode.")

        # Turn two, or next week, or a brand-new session: recalled automatically.
        reply = await agent.run("When should we schedule the release?")
        print(reply.text)


asyncio.run(main())
```

## What you get

### `CortadelContextProvider` — automatic memory

A subclass of `agent_framework.ContextProvider`, attached with `Agent(context_providers=[...])`.
It implements the framework's two hooks:

| Hook | What it does |
|---|---|
| `before_run` | Hybrid-searches Cortadel with the current turn's input and injects the hits into the invocation context — as an attributed context message (default) or appended to the system instructions. |
| `after_run` | Sends the completed turn (input + the agent's response) to Cortadel's conversation pipeline, which distils durable facts from it off the request path. |

Three things it does that a naive wrapper would not:

- **It never takes your agent down.** Every Cortadel call fails open: transport and HTTP errors
  are swallowed, so a memory outage degrades the agent to "no long-term memory", not "no agent".
  Pass `on_error` to observe those failures, or `raise_on_error=True` if you would rather the
  turn fail loudly; a failure that is neither observed nor propagated is logged as a warning.
  `asyncio.CancelledError` is deliberately re-raised — cancellation is your intent, not a
  Cortadel failure.
- **It does not re-inject the same memories every turn.** Injected memory ids are tracked in the
  provider-scoped `state` dict Agent Framework hands to each hook (persisted in
  `AgentSession.state`, so it survives a session store round-trip), bounded to
  `max_remembered_ids`.
- **It does not re-ingest its own output.** The context block it injected is filtered out before
  the turn is stored, so retrieved memories are never written back as if the user had said them.

### `cortadel_memory_tools` — agent-invoked memory

Real `agent_framework.FunctionTool`s built with the framework's `tool` primitive, so their JSON
schemas come from the annotated signatures:

| Tool | Signature | Purpose |
|---|---|---|
| `search_memory` | `(query: str, top_k: int \| None = None)` | Recall on demand mid-reasoning. Returns one memory per line. `top_k` is nullable in the schema the model sees; omitting it falls back to the builder's `top_k` (10), and any value is clamped into Cortadel's 1–50 range. |
| `add_memories` | `(text: str)` | Deliberately commit a fact worth keeping. Reports the store pipeline's real verdict (`ADD`, `SKIP_DUPLICATE`, …). |

Both are bound to a client at build time, so **no tool parameter accepts a user id** — the model
cannot reach another user's memories. Use `search_memory_tool()` / `add_memories_tool()`
individually if you want only one, or to rename them.

The builders take these options — `cortadel_memory_tools()` forwards all but `name` and
`memory_type`:

| Option | Type | Default | Applies to | Meaning |
|---|---|---|---|---|
| `name` | `str` | the tool's own name | both | Rename the tool the model sees. |
| `top_k` | `int` | `10` | `search_memory` | Result count used when the model does not ask for one. Higher than the provider's `5`: this tool only runs when the model decided it needed memory, so it can afford a wider net — and `10` is the Cortadel SDK's own `SearchOptions` default. |
| `rerank` | `str \| None` | `None` | `search_memory` | `"cross_encoder"` to rerank server-side. |
| `infer` | `bool \| None` | `None` | `add_memories` | `False` stores the text verbatim and skips background extraction (dedup still applies). |
| `memory_type` | `str \| None` | `None` | `add_memories` | Pin the cognitive type: `episodic`, `semantic` or `procedural`. |
| `raise_on_error` | `bool` | `False` | both | Propagate a Cortadel failure instead of answering the model with a graceful "memory is unavailable" note. |
| `on_error` | `Callable[[Exception], None] \| None` | `None` | both | Observe Cortadel failures. Replaces the warning log. |

The provider and the tools compose: attach the provider for ambient recall and add the tools when
you want the agent to be able to go looking.

## Configuration

`CortadelContextProvider(base_url=..., user_id=..., **options)` — pass `base_url` and `user_id`
and the provider builds (and closes) its own Cortadel client, or pass `client=` and keep
ownership yourself.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str` | — | Cortadel server URL. Required unless `client` is given. |
| `user_id` | `str` | — | The user who owns these memories. Required unless `client` is given. |
| `api_key` | `str \| None` | `None` | Bearer token. Omit when the server runs with auth disabled. |
| `app_name` | `str` | `"cortadel-agent-framework"` | Recorded by Cortadel for access logging on searches. |
| `client` | `CortadelClient \| None` | `None` | Pre-built client. When given, the four options above are ignored and **you** own its lifecycle. |
| `source_id` | `str` | `"cortadel"` | Attribution id for injected messages and provider state. Give each provider a distinct id if you attach two. |
| `top_k` | `int` | `5` | Memories retrieved per turn (Cortadel accepts 1–50). |
| `search_mode` | `str` | `"hybrid"` | `hybrid`, `text` or `vector`. |
| `rerank` | `str \| None` | `None` | `"cross_encoder"` to rerank server-side. Cortadel accepts no other value. |
| `memory_type` | `str \| None` | `None` | Restrict recall to `episodic`, `semantic` or `procedural`. |
| `context_prompt` | `str \| None` | a generic "## Memories" header | Header placed above the injected memories. |
| `inject_as` | `str` | `"message"` | `"message"` injects a user-role context message; `"instructions"` appends to the system instructions. |
| `scope_recall_to_session` | `bool` | `False` | Restrict recall to the current `AgentSession`. Off by default — cross-session recall is the point. |
| `deduplicate_across_turns` | `bool` | `True` | Skip memories already injected in this session. |
| `max_remembered_ids` | `int` | `256` | Cap on remembered ids per session, bounding state growth. `0` remembers nothing, which makes every hit eligible for re-injection each turn. |
| `store_turns` | `bool` | `True` | Persist each completed turn. `False` gives a read-only agent. |
| `await_persist` | `bool` | `True` | Await the write before the turn returns. **Defaults to `True`, unlike most Cortadel integrations**, because Agent Framework gives a `ContextProvider` no shutdown hook: a script that returns from `agent.run()` and exits would drop an in-flight write. Set `False` to take the write off the turn's critical path — then close the provider (`async with` / `aclose()`) to flush it, and observe write failures through `on_error`, since a fire-and-forget write has no caller left to raise into. |
| `is_agent_memory` | `bool` | `False` | Extract facts about the *assistant* rather than the user. |
| `tags` | `list[str] \| None` | `None` | Tags applied to every fact extracted from stored turns. |
| `project` | `str \| None` | `None` | Project scope (e.g. a repo name) applied to stored turns. |
| `raise_on_error` | `bool` | `False` | Propagate Cortadel failures to the caller instead of swallowing them. Fail-open is the default: a memory outage must never take the agent down. |
| `on_error` | `Callable[[Exception], None] \| None` | `None` | Callback invoked with the exception when a Cortadel call fails. Replaces the warning log; a callback that itself raises is logged and swallowed. |

### How ids map

- **User** — a Cortadel client is bound to one `user_id` at construction; no Cortadel method takes
  a user id per call. So **a provider instance is a per-user object**. Build one per end user and
  cache it; never share one across users.
- **Session** — Agent Framework's `AgentSession.session_id` is passed as Cortadel's `session_id`
  when *writing*, so facts stay grouped by conversation. Reads deliberately span every session
  unless you set `scope_recall_to_session=True`.

## Running the tests

Offline unit tests — no network, no Cortadel server, no API keys:

```bash
cd integrations/microsoft-agent-framework
uv sync --extra test
uv run pytest -q
```

## Requirements

- **Python** ≥ 3.10
- **`agent-framework-core`** ≥ 1.13.0 — the release this package is built and tested against. The
  floor is conservative rather than a hard compatibility boundary: `ContextProvider`'s
  `before_run` / `after_run` hook pair and `SessionContext.extend_messages` are byte-identical in
  1.12.0, so the integration would very likely work there too — it is simply not tested there.
- **`cortadel`** ≥ 1.0.0
- **A running Cortadel server** — either the hosted service at `https://app.cortadel.ai`, or
  self-host it: `docker compose up` from the repo root gives you `http://localhost:3001`. See
  [docs/self-hosting.md](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md).

## Links

- [Cortadel on GitHub](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)

Apache-2.0.
