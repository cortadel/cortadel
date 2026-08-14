# Cortadel × Pydantic AI

[Pydantic AI](https://ai.pydantic.dev) has a first-class extension point for exactly this kind of
thing — a **capability**: one object, passed as `Agent(capabilities=[...])`, that can contribute
tools, instructions and lifecycle hooks at once. `cortadel-pydantic-ai` implements it. Adding a
single `CortadelMemory(...)` to your agent gives the model `search_memory` and `add_memories` tools,
recalls relevant memories into the prompt before each run, and hands the finished turn to Cortadel
afterwards — so an agent remembers a user across sessions without you threading any state through
your application.

## Install

```bash
pip install cortadel-pydantic-ai
```

```bash
uv add cortadel-pydantic-ai
```

It depends on `pydantic-ai-slim`, not the `pydantic-ai` meta-package, so you keep choosing your own
model-provider extras (`pip install "pydantic-ai-slim[openai]"`, `[anthropic]`, …). An existing
`pydantic-ai` install satisfies the floor too, because `pydantic-ai==X` depends on
`pydantic-ai-slim==X`.

## Quickstart

Two *separate* runs, with no message history threaded between them. The second run has no idea what
the first one said — except that Cortadel remembered it.

```python
import asyncio
import os

from pydantic_ai import Agent

from cortadel_pydantic_ai import CortadelMemory

memory = CortadelMemory(
    base_url=os.getenv("CORTADEL_BASE_URL", "http://localhost:3001"),  # or https://app.cortadel.ai
    user_id="e2e-quickstart",                    # the memory namespace
    api_key=os.getenv("CORTADEL_API_KEY"),       # omit when the server has auth disabled
    # An observer, not a policy: the run keeps going either way.
    on_error=lambda exc: print(f"  [memory unavailable: {exc}]"),
)

agent = Agent(
    "openai:gpt-5",
    instructions="You are a concise assistant.",
    capabilities=[memory],
)


async def main() -> None:
    # Turn 1 — nothing is known yet; the turn is stored on the way out.
    first = await agent.run("I'm allergic to peanuts, and I always want metric units.")
    print(first.output)

    # Cortadel extracts facts off the request path, so give it a moment.
    await asyncio.sleep(2)

    # Turn 2 — a brand-new run with no `message_history=`. The only way the model can know
    # about the allergy is the recall performed before it was called.
    second = await agent.run("Suggest a dessert I can make, with quantities.")
    print(second.output)

    await memory.aclose()


asyncio.run(main())
```

`base_url`, `user_id` and `api_key` fall back to `$CORTADEL_BASE_URL`, `$CORTADEL_USER_ID` and
`$CORTADEL_API_KEY`, in that order of precedence — an explicit argument always wins.

The package ships two runnable scripts:
[`examples/quickstart.py`](https://github.com/cortadel/cortadel/tree/main/integrations/pydantic-ai/examples/quickstart.py)
(the above, with commentary) and
[`examples/multi_user.py`](https://github.com/cortadel/cortadel/tree/main/integrations/pydantic-ai/examples/multi_user.py)
(per-user scoping through `deps`).

## What you get

One capability contributes three things.

### 1. Memory tools the model can call

A `FunctionToolset` with the stable id `cortadel-memory`, holding two tools. Both receive the
`RunContext`, and their descriptions and JSON schemas are derived from the coroutines' own
signatures and docstrings.

| Tool | Signature | What it does |
|---|---|---|
| `search_memory` | `(query: str, top_k: int = <the capability's `top_k`, `5` by default>) -> str` | Searches the user's long-term memory and returns the matching facts as a bulleted list. |
| `add_memories` | `(text: str) -> str` | Saves a durable fact, and reports the write pipeline's verdict rather than assuming a write — Cortadel deduplicates, supersedes and invalidates, and says which via `event`. |

The strings the model sees are written for the model, not for a log: no hits reads
`No relevant memories found.`, a dedup verdict reads `Already known — no duplicate was created.`,
and an unreachable server reads `Long-term memory is temporarily unavailable. Answer from the
current conversation instead.` — never an empty result the model would misread as "nothing is
known". `top_k` is clamped to the server's 1–50 range, so a model that asks for 9,999 gets 50.

Want only the tools, without the automatic behaviour? Use the toolset on its own:

```python
from pydantic_ai import Agent

from cortadel_pydantic_ai import cortadel_toolset

agent = Agent("openai:gpt-5", toolsets=[cortadel_toolset(user_id="e2e-alice")])
```

### 2. Automatic recall, before the model is called

A dynamic instruction searches Cortadel with the run's prompt and injects the hits as a bulleted
block under a configurable header. The agent's own `instructions=` still come first. Two properties
worth knowing:

- **One search per run, not per model request.** A five-step tool loop still makes exactly one
  Cortadel call.
- **Nothing is injected when there is nothing to say.** With no hits — or an unreachable server —
  the instruction returns `None`, which pydantic-ai drops entirely. No empty section, no wasted
  tokens. Duplicate hit texts are collapsed before rendering.

Recalled memories ride in the **instructions**, never as conversation parts, so they never turn into
a fake user or system turn in the transcript.

### 3. Automatic persistence, after the turn

The finished turn is converted into a Cortadel conversation and sent with `add_conversation`, which
distils durable facts server-side. Only the conversational surface is sent — user prompts and the
assistant's text; tool calls, tool returns, thinking parts and system prompts are mechanics or agent
configuration, not facts about the user. Only *this run's* messages go out, so a multi-turn
conversation never re-sends its own history.

### Failure is never fatal, by default

Memory is an enhancement, not a dependency. Out of the box, if Cortadel is unreachable: recall
injects nothing, persistence is skipped, the tools tell the model memory is unavailable, and the run
continues. Cancellation is never swallowed — `asyncio.CancelledError` propagates untouched.

Two independent knobs control what you see, and they compose in this order:

- **`on_error`** is the *observer*: a callback that receives every failure. It fires whether or not
  the failure is also raised, and its own exceptions are logged rather than propagated. With no
  callback set, a swallowed failure logs a warning on the `cortadel_pydantic_ai` logger instead.
- **`raise_on_error`** is the *policy*: `False` (the default) degrades, `True` lets the failure
  propagate into the run — unwrapped, so you can catch `cortadel.CortadelError` itself.

## Configuration

`base_url` and `user_id` — and only those two — may be passed positionally, in that order, so
`CortadelMemory("http://localhost:3001", "e2e-alice")` reads the way `CortadelClient(base_url,
user_id, ...)` does in the [Python SDK](../sdk-python.md) itself. **Every other option is
keyword-only**, which is what makes the list safe to extend: a new option can never take over a
positional slot that used to mean something else. A test pins that contract.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str \| None` | `$CORTADEL_BASE_URL`, else `http://localhost:3001` | Cortadel server URL. Hosted: `https://app.cortadel.ai`. |
| `user_id` | `str \| (ctx) -> str` | `$CORTADEL_USER_ID` | The memory namespace. A callable derives it per run, normally from `ctx.deps`. Required — construction raises `ValueError` without one. |
| `api_key` | `str \| None` | `$CORTADEL_API_KEY` | Bearer token (see [Authentication](../authentication.md)). Omit when the server has auth disabled. |
| `app_name` | `str` | `"cortadel-pydantic-ai"` | Label recorded for access logging on searches, and on memories written by the `add_memories` tool. |
| `timeout` | `float` | `100.0` | Per-client HTTP timeout, in seconds. |
| `tools` | `bool` | `True` | Expose `search_memory` / `add_memories` to the model. |
| `recall` | `bool` | `True` | Search Cortadel before each run and inject the hits as instructions. |
| `persist` | `bool` | `True` | Send the finished turn with `add_conversation` after each run. |
| `await_persist` | `bool` | **`True`** | Wait for that write before the run returns. On by default, unlike most Cortadel integrations — see [Known limits](#known-limits). |
| `top_k` | `int` | `5` | Maximum memories recalled per run (clamped to 1–50), and the default `top_k` the `search_memory` tool offers the model. |
| `search_mode` | `str` | `"hybrid"` | `hybrid` (BM25 + vector), `text`, or `vector`. |
| `rerank` | `bool` | `False` | Rerank with the server's cross-encoder (`rerank="cross_encoder"` on the wire). More accurate, slower. |
| `memory_type` | `str \| None` | `None` | Restrict recall to one cognitive type: `episodic`, `semantic`, or `procedural`. |
| `scope_recall_to_session` | `bool` | `False` | Restrict automatic recall to the current session. Off by default: scoping to a session would hide everything learned in earlier conversations. |
| `instructions_header` | `str` | `DEFAULT_INSTRUCTIONS_HEADER` | Preamble placed above the recalled memories. |
| `session_id` | `str \| (ctx) -> str \| None \| None` | `ctx.conversation_id` | Groups stored facts into a session. pydantic-ai keeps `conversation_id` stable across runs that share a message history. |
| `project` | `str \| None` | `None` | Project scope recorded on stored facts (e.g. a repo name). |
| `tags` | `Sequence[str] \| None` | `None` | Tags applied to every stored fact, for scoped retrieval later. |
| `client_factory` | `(user_id: str) -> MemoryClient \| None` | `None` | Builds the Cortadel client. Override to inject a stand-in in tests. |
| `on_error` | `(exc: Exception) -> None \| None` | `None` | Callback receiving every Cortadel failure. Falls back to a warning on the `cortadel_pydantic_ai` logger. |
| `raise_on_error` | `bool` | `False` | Let Cortadel failures propagate into the run instead of degrading. |
| `toolset_id` | `str` | `"cortadel-memory"` | Id of the contributed toolset. |

`id`, `description` and `defer_loading` come from pydantic-ai's own `AbstractCapability` and are
keyword-only there, so they work here too; with no `description` set, the capability describes itself
as *"Long-term memory of this user, stored in Cortadel."*

`cortadel_toolset(...)` takes the same names where they apply — `base_url`, `user_id`, `api_key`,
`app_name`, `timeout`, `top_k`, `search_mode`, `rerank`, `memory_type`, `client_factory`, `on_error`,
`raise_on_error`, and `id` for the toolset id. It has no recall or persistence of its own, and it is
keyword-only throughout: it is a builder, not the client-shaped entry point.

### Per-user scoping

A Cortadel client is bound to one user id at construction — no SDK method takes a user id — so
multi-tenant agents pass a callable and the integration pools one client per resolved id:

```python
from dataclasses import dataclass

from pydantic_ai import Agent, RunContext

from cortadel_pydantic_ai import CortadelMemory


@dataclass
class Deps:
    user_id: str
    tenant: str


def current_user(ctx: RunContext[Deps]) -> str:
    # Namespacing by tenant keeps two customers' user ids from colliding.
    return f"{ctx.deps.tenant}-{ctx.deps.user_id}"


memory: CortadelMemory[Deps] = CortadelMemory(user_id=current_user)
agent = Agent("openai:gpt-5", deps_type=Deps, capabilities=[memory])

await agent.run("Which region am I in?", deps=Deps(user_id="e2e-alice", tenant="e2e-acme"))
await agent.run("Which region am I in?", deps=Deps(user_id="e2e-bob", tenant="e2e-acme"))
```

Alice's memories cannot leak into Bob's run: the two resolve to two clients against two Cortadel
namespaces. Call `await memory.aclose()` on shutdown to drain any backgrounded writes and close every
pooled client.

## How it works

The extension point is **`pydantic_ai.capabilities.AbstractCapability`** — pydantic-ai's own primary
seam, and the reason this integration is a single object rather than a bag of callbacks.
`CortadelMemory` is a `@dataclass` subclass of it, generic over `AgentDepsT`, and it overrides six
methods:

| Hook | What Cortadel does with it |
|---|---|
| `get_toolset()` | Returns a `pydantic_ai.toolsets.FunctionToolset`, built by `add_function(..., takes_ctx=True, name=...)` so the tool names are pinned to `search_memory` / `add_memories` regardless of the Python function names. Returns `None` when `tools=False`. |
| `get_instructions()` | Returns the bound `_recall_instructions` method, which pydantic-ai treats as a dynamic instructions function taking a `RunContext`. Returning `None` from it makes pydantic-ai skip the instruction entirely. Returns `None` up front when `recall=False`. |
| `for_run(ctx)` | Returns `copy.copy(self)` — a per-run copy with the recall cache cleared. Shallow on purpose: the shared backend (and with it the client cache and its HTTP keep-alive) survives, the cache does not. |
| `after_run(ctx, result=...)` | Converts `result.new_messages()` into `cortadel.ChatMessage`s and calls `add_conversation`. Always returns `result` unchanged. |
| `get_description()` | The one-line description the model may see when the capability is deferred. |
| `get_serialization_name()` | Returns `None`, opting out of spec-based construction (see below). |

Three mechanics are worth spelling out, because each one is a bug you would otherwise hit.

**Why the recall cache needs `for_run`.** The agent loop re-resolves instructions on *every* model
request, not once per run — that is how a dynamic instruction stays fresh across a tool round-trip.
Without a cache, a five-step run would hit Cortadel five times with the same query. Caching on the
capability instance itself would be worse: capabilities are shared across concurrent runs, so run B
would read run A's memories. `for_run()` resolves both — each run gets its own copy to cache on, and
the copy keeps sharing the connection pool.

**Why instructions, not messages.** pydantic-ai rebuilds the instructions block for each request from
the current run's instruction parts: `Model._get_instruction_parts` prefers
`model_request_parameters.instruction_parts`, and only falls back to the `ModelRequest.instructions`
recorded in history for direct `model.request()` callers. So feeding `result.all_messages()` back as
`message_history=` on the next turn sends exactly **one** memory block — the freshly recalled one —
instead of accumulating a stale copy per turn.

**Why `RunContext` is imported at runtime.** Every module here uses
`from __future__ import annotations`, which makes annotations strings. pydantic-ai decides whether a
callable wants a run context by resolving its first parameter's *runtime* annotation
(`pydantic_ai._utils.takes_run_context` → `get_first_param_type`), so `RunContext` has to be
resolvable from the module's globals or that detection raises `UserError`. Hence the deliberate
non-`TYPE_CHECKING` imports, and `takes_ctx=True` passed explicitly at tool registration rather than
inferred.

Underneath the hooks sits one shared backend: it resolves the user id per call, caches a
`cortadel.CortadelClient` per user id, and routes every Cortadel call through a `try_*` wrapper that
returns a sentinel on failure and reports the exception. `aclose()` drains in-flight background
writes, then closes every pooled client.

## Known limits

**`await_persist` defaults to `True` here.** Cortadel's shared vocabulary fixes the *name*, not the
default, and this package deviates deliberately: `after_run()` is the last hook in a pydantic-ai run
and the framework owns no background task pool, so a fire-and-forget write outlives nothing — the
very common `asyncio.run(main())` shape cancels every pending task the moment `main()` returns, and
the turn is silently lost. The cost is one Cortadel round-trip on run latency. Set
`await_persist=False` to take the write off the critical path — then `await memory.aclose()` before
shutdown, which is what guarantees the write actually landed.

**`raise_on_error` cannot cover a backgrounded write.** With `await_persist=False` there is no caller
left to raise into, so such a failure reaches `on_error` (and the logger) only.

**Recalled memory text appears in serialized transcripts.** It is never a conversation part and it is
not re-sent to the provider, but the rendered instructions string *is* recorded on each historical
`ModelRequest.instructions`. If you persist `all_messages()` dumps, they will contain the recalled
text.

**Not spec-serializable.** `get_serialization_name()` returns `None` on purpose: `user_id`,
`client_factory` and `on_error` can all be callables, which a YAML/JSON agent spec cannot express. So
an agent loaded from a spec file cannot declare this capability — construct it in code.

**Two different `top_k` defaults.** The capability recalls `5` per run (those tokens are spent on
every single run, whether or not the model needed them); a standalone `cortadel_toolset(...)` defaults
to `10`, matching `cortadel.SearchOptions.top_k`, because the model asked for those results and pays
for them only on the turns it does. When the toolset comes from `CortadelMemory`, the capability's
`top_k` governs both.

**`scope_recall_to_session` only affects automatic recall.** The `search_memory` tool never scopes to
a session — session scoping there would hide everything learned in earlier conversations, which is
precisely what the model is reaching for when it calls the tool.

**The app label does not reach conversation writes.** `app_name` is sent on every search and on
memories written by the `add_memories` tool (as `AddOptions.app`), but the SDK's
`ConversationOptions` has no app field, so facts distilled from the automatic `add_conversation`
write carry no app label. Use `project` / `tags` if you need to attribute them.

**Only the text survives a multimodal prompt.** The recall query and the stored turn are built from
text content only; images, audio and documents in a `UserPromptPart` are dropped rather than
stringified. A prompt with no text at all yields no query, and recall is skipped without a round-trip.

**Untested against a live server.** The package's suite is fully offline: Cortadel is stubbed at the
client boundary, while the pydantic-ai side runs for real against in-process `TestModel` and
`FunctionModel`. Wire-level behaviour rests on the [Python SDK](../sdk-python.md) and its own
conformance suite. The suite also drives `agent.run` only, so streaming entry points are not
exercised.

## Requirements

- **Python** ≥ 3.10
- **pydantic-ai** ≥ 2.29.0 (`pydantic-ai-slim>=2.29.0,<3.0.0`) — the floor at which
  `Agent(capabilities=[...])` and `pydantic_ai.capabilities.AbstractCapability` exist
- **cortadel** ≥ 1.0.0, < 2.0.0 — the official [Python SDK](../sdk-python.md), installed for you
- **A running Cortadel server** — either the hosted service at `https://app.cortadel.ai`, or
  self-hosted: `docker compose up` from the repo root, then `http://localhost:3001` (see
  [Self-hosting](../self-hosting.md))

## Links

- Package on PyPI: [`cortadel-pydantic-ai`](https://pypi.org/project/cortadel-pydantic-ai/)
- Source: [`integrations/pydantic-ai`](https://github.com/cortadel/cortadel/tree/main/integrations/pydantic-ai)
- All twelve packages: [Integrations](../integrations.md)
- Pydantic AI capabilities: <https://ai.pydantic.dev/capabilities/overview/>

Licensed under Apache-2.0.
