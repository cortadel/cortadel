# Cortadel × Pydantic AI

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. This package plugs it into
[Pydantic AI](https://ai.pydantic.dev) as a **capability**, pydantic-ai's own primary extension
point. One object added to your `Agent` gives it memory tools *and* automatic recall and
persistence, so the agent remembers a user across sessions without you threading state through
your application.

## Install

```bash
pip install cortadel-pydantic-ai
```

```bash
uv add cortadel-pydantic-ai
```

It depends on `pydantic-ai-slim` so you keep choosing your own model provider extras; an existing
`pydantic-ai` install satisfies it too.

## Quickstart

```python
import asyncio

from pydantic_ai import Agent

from cortadel_pydantic_ai import CortadelMemory

memory = CortadelMemory(
    base_url="http://localhost:3001",   # or https://app.cortadel.ai
    user_id="e2e-quickstart",           # whose memories these are
)

agent = Agent(
    "openai:gpt-5",
    instructions="You are a helpful assistant.",
    capabilities=[memory],
)


async def main() -> None:
    # Turn 1 — nothing is known yet; the turn is stored on the way out.
    first = await agent.run("I'm allergic to peanuts, and I prefer metric units.")
    print(first.output)

    # Turn 2, a brand-new run with no message history: the allergy is recalled from Cortadel
    # and injected into the prompt before the model sees the question.
    second = await agent.run("Suggest a dessert for me.")
    print(second.output)

    await memory.aclose()


asyncio.run(main())
```

`examples/` has two runnable scripts: `quickstart.py` (the above, with commentary) and
`multi_user.py` (per-user scoping through `deps`).

## What you get

Adding `CortadelMemory` to `capabilities=[...]` contributes three things at once.

### 1. Memory tools the agent can call

A `FunctionToolset` (id `cortadel-memory`) with two tools:

| Tool | Signature | What it does |
| --- | --- | --- |
| `search_memory` | `(query: str, top_k: int = 10) -> str` | Searches the user's long-term memory and returns the matching facts. |
| `add_memories` | `(text: str) -> str` | Saves a durable fact, reporting whether it was stored, deduplicated, or superseded. |

Want only the tools, without the automatic behaviour? Use the toolset on its own:

```python
from cortadel_pydantic_ai import cortadel_toolset

agent = Agent("openai:gpt-5", toolsets=[cortadel_toolset(user_id="e2e-alice")])
```

The `top_k` the model sees defaults to **10** on a standalone `cortadel_toolset(...)` — matching
the Cortadel SDK's own `SearchOptions.top_k` — and to the capability's `top_k` (**5**) when the
toolset comes from `CortadelMemory`, so one knob governs both halves of that setup. Either way the
model may override it per call, and the value is clamped to the server's 1–50 range.

### 2. Automatic recall before the model call

`CortadelMemory.get_instructions()` contributes a dynamic instruction that searches Cortadel with
the run's prompt and injects the hits into the prompt. Two properties are worth calling out:

- **One search per run, not per step.** `for_run()` gives each run its own copy of the capability
  to cache the recall on, so a five-step tool loop still makes exactly one Cortadel call.
- **Nothing is injected when there is nothing to say.** With no hits — or an unreachable server —
  the instruction returns `None`, which pydantic-ai drops entirely. No empty section, no wasted
  tokens.

Recalled memories are injected as **instructions**, never as conversation parts, so they do not
turn into a fake user or system turn in the transcript. pydantic-ai builds the instructions block
freshly for each request from the current run's instruction parts, so feeding
`result.all_messages()` back as `message_history=` on the next turn sends exactly one memory block
— the newly recalled one — rather than accumulating a copy per turn.

One caveat worth knowing if you persist transcripts: the rendered instructions string is still
*recorded* on each historical `ModelRequest.instructions` for the record. It is not re-sent to the
model, but it does mean recalled memory text is present in a serialized `all_messages()` dump.

### 3. Automatic persistence after the turn

`after_run()` converts the run's **new** messages (`result.new_messages()`, not `all_messages()`)
into a Cortadel conversation and sends it with `add_conversation`, which extracts durable facts
server-side. Only user prompts and assistant text are sent; tool calls, tool returns and system
prompts are mechanics, not facts.

That write is **awaited** by default (`await_persist=True`), unlike most Cortadel integrations:
`after_run()` is the last hook in a pydantic-ai run and the framework owns no background task
pool, so in the ordinary `asyncio.run(main())` shape a fire-and-forget task is cancelled the
moment `main()` returns and the turn is silently lost. Set `await_persist=False` to take the write
off the critical path — then `await memory.aclose()` before shutdown, which drains whatever is
still in flight.

### Failure is never fatal, by default

Memory is an enhancement, not a dependency. Out of the box, if Cortadel is unreachable, recall
injects nothing, persistence is skipped, the tools tell the model that memory is unavailable, and
the run continues. Cancellation is never swallowed.

Two independent knobs control what you see:

- **`on_error`** is an *observer*: a callback that receives every failure. It fires whether or not
  the failure is also raised, and its own exceptions are logged rather than propagated. With no
  callback set, a swallowed failure logs a warning on the `cortadel_pydantic_ai` logger instead.
- **`raise_on_error`** is the *policy*: `False` (the default) degrades, `True` lets the failure
  propagate into the run. They compose in that order — the callback fires, then the failure is
  re-raised if you asked for it.

`raise_on_error` cannot apply to a write that has already been backgrounded with
`await_persist=False`: there is no caller left to raise into, so such a failure only reaches
`on_error`.

## Configuration

`base_url` and `user_id` — and only those two — may be passed positionally, in that order, so
`CortadelMemory("http://localhost:3001", "e2e-alice")` works and reads the way
`CortadelClient(base_url, user_id, ...)` does in the Cortadel SDK itself. **Every other option is
keyword-only**, which is what makes this list safe to extend: a new option can never take over a
positional slot that used to mean something else. `cortadel_toolset(...)` is keyword-only
throughout — it is a builder rather than a client-shaped entry point.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `base_url` | `str` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server URL. Hosted: `https://app.cortadel.ai`. |
| `user_id` | `str` \| `(ctx) -> str` | `$CORTADEL_USER_ID` | Whose memories these are. A callable derives it per run, normally from `ctx.deps`. Required. |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Bearer token. Omit when the server has auth disabled. |
| `app_name` | `str` | `"cortadel-pydantic-ai"` | Identifies this integration for access logging; also labels stored memories. |
| `timeout` | `float` | `100.0` | Per-client HTTP timeout, in seconds. |
| `tools` | `bool` | `True` | Expose `search_memory` / `add_memories` to the model. |
| `recall` | `bool` | `True` | Search and inject memories before each run. |
| `persist` | `bool` | `True` | Store the turn after each run. |
| `await_persist` | `bool` | `True` | Wait for that write before the run returns. `True` because `after_run()` is the last hook in a run — see [above](#3-automatic-persistence-after-the-turn). |
| `top_k` | `int` | `5` | Maximum memories recalled per run (1–50), and the default `top_k` the `search_memory` tool offers the model. `cortadel_toolset(...)` on its own defaults to `10`. |
| `search_mode` | `str` | `"hybrid"` | `hybrid` (BM25 + vector), `text`, or `vector`. |
| `rerank` | `bool` | `False` | Rerank with the server's cross-encoder. More accurate, slower. |
| `memory_type` | `str \| None` | `None` | Restrict recall to `episodic`, `semantic`, or `procedural`. |
| `scope_recall_to_session` | `bool` | `False` | Restrict recall to the current session. Off by default — scoping to a session would hide everything learned in earlier conversations. |
| `instructions_header` | `str` | see `DEFAULT_INSTRUCTIONS_HEADER` | Preamble above the recalled memories. |
| `session_id` | `str` \| `(ctx) -> str \| None` \| `None` | `ctx.conversation_id` | Groups stored facts into a session. |
| `project` | `str \| None` | `None` | Project scope recorded on stored facts (e.g. a repo name). |
| `tags` | `Sequence[str] \| None` | `None` | Tags applied to every stored fact. |
| `client_factory` | `(user_id) -> MemoryClient \| None` | `None` | Builds the Cortadel client. Override to inject a stand-in in tests. |
| `on_error` | `(exc) -> None \| None` | `None` | Callback receiving every Cortadel failure. Falls back to a warning on the `cortadel_pydantic_ai` logger. |
| `raise_on_error` | `bool` | `False` | Let Cortadel failures propagate into the run instead of degrading. |
| `toolset_id` | `str` | `"cortadel-memory"` | Id of the contributed toolset. |

`cortadel_toolset(...)` takes the same names where they apply — `base_url`, `user_id`, `api_key`,
`app_name`, `timeout`, `top_k` (default `10`), `search_mode`, `rerank`, `memory_type`,
`client_factory`, `on_error`, `raise_on_error`, `id` — since it has no recall or persistence of
its own.

### Per-user scoping

A Cortadel client is bound to one user id at construction — no method takes a user id — so
multi-tenant agents pass a callable. The integration keeps one pooled client per resolved id:

```python
from dataclasses import dataclass

from pydantic_ai import Agent

from cortadel_pydantic_ai import CortadelMemory


@dataclass
class Deps:
    user_id: str


agent = Agent(
    "openai:gpt-5",
    deps_type=Deps,
    capabilities=[CortadelMemory(user_id=lambda ctx: ctx.deps.user_id)],
)

await agent.run("What do you know about me?", deps=Deps(user_id="e2e-alice"))
await agent.run("What do you know about me?", deps=Deps(user_id="e2e-bob"))
```

Call `await memory.aclose()` on shutdown to drain any backgrounded writes and release the pooled
HTTP connections.

## Running the tests

The suite is fully offline — no live Cortadel server, no network, no API keys. Cortadel is stubbed
at the client boundary; the pydantic-ai side runs for real against its in-process `TestModel` and
`FunctionModel`.

```bash
cd integrations/pydantic-ai
uv sync --extra test
uv run pytest -q
```

## Requirements

- **Python** ≥ 3.10
- **pydantic-ai** ≥ 2.29.0 (`pydantic-ai-slim>=2.29.0,<3.0.0`) — the floor at which
  `Agent(capabilities=[...])` and `pydantic_ai.capabilities.AbstractCapability` exist
- **cortadel** ≥ 1.0.0, < 2.0.0 (the official Python SDK)
- **A running Cortadel server** — either the hosted service at `https://app.cortadel.ai`, or
  self-hosted: `docker compose up` from the repo root, then `http://localhost:3001`

## Links

- Cortadel: <https://cortadel.ai>
- Source and issues: <https://github.com/cortadel/cortadel>
- Pydantic AI capabilities: <https://ai.pydantic.dev/capabilities/overview/>

Licensed under Apache-2.0.
