# Cortadel × Claude Agent SDK

[Cortadel](https://cortadel.ai) is self-hosted long-term temporal graph memory for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search. The
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python) gives an agent a session;
it does not give it a memory that outlives one. This package closes that gap through the SDK's own
two extension points: an **in-process MCP server** carrying memory tools the agent can call on
purpose, and **`UserPromptSubmit` / `Stop` hooks** that recall and persist without being asked.
Both come off one object, and memory degrades rather than breaking your agent — if the Cortadel
server is unreachable the hooks return empty and the turn proceeds untouched, with the failure
handed to your `on_error` callback (or logged). Flip `raise_on_error=True` when you would rather
know loudly.

## Install

```bash
pip install cortadel-claude-agent-sdk
# or: uv add cortadel-claude-agent-sdk
```

This pulls in `claude-agent-sdk` and the `cortadel` Python SDK.

## Quickstart

```python
import asyncio

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
from cortadel_claude_agent_sdk import CortadelMemory


async def main() -> None:
    # One CortadelMemory per user: a Cortadel client is bound to one user id at construction.
    memory = CortadelMemory("http://localhost:3001", "e2e-alice")

    # apply() returns a COPY of the options with the memory tools and both hooks merged in.
    options = memory.apply(ClaudeAgentOptions(model="claude-sonnet-4-5"))

    async with memory:
        async for message in query(prompt="What did we decide about the schema?", options=options):
            if isinstance(message, ResultMessage) and message.subtype == "success":
                print(message.result)


asyncio.run(main())
```

That single `apply()` call is equivalent to writing all of this by hand:

```python
options = ClaudeAgentOptions(
    model="claude-sonnet-4-5",
    mcp_servers={"cortadel": memory.mcp_server},
    allowed_tools=["mcp__cortadel__search_memory", "mcp__cortadel__add_memories"],
    hooks=memory.hooks(),
)
```

Take just one half with `memory.apply(options, auto_memory=False)` (tools only — the agent decides
when to remember) or `memory.apply(options, tools=False)` (hooks only — memory the agent never has
to think about).

## What you get

### Memory tools (in-process MCP server)

Defined with the SDK's `@tool` decorator and packaged by `create_sdk_mcp_server`, so they run in
your process — no subprocess, no IPC.

| Tool | Fully qualified name | Arguments | Does |
|---|---|---|---|
| `search_memory` | `mcp__cortadel__search_memory` | `query` (required), `top_k` | Hybrid BM25 + vector search over this user's memories. Annotated `readOnlyHint`, so Claude may batch it with other read-only calls. |
| `add_memories` | `mcp__cortadel__add_memories` | `text` (required), `memory_type` | Stores a durable fact. The result reports Cortadel's pipeline `event` (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, …) — a successful call does not always mean a new memory. |

The `mcp__<server>__<tool>` prefix comes from the key in `mcp_servers`; change it with
`server_name=`. Failures come back to the model as `is_error` results with a readable message, so
the agent loop continues.

### Automatic memory (hooks)

| Hook event | What it does |
|---|---|
| `UserPromptSubmit` | Searches Cortadel with the submitted prompt and injects the hits as `hookSpecificOutput.additionalContext`. Skips prompts shorter than `min_prompt_chars` and anything starting with `/` or `!`. Within a session it never injects the same memory twice (`dedupe_injections`), so a long conversation does not keep re-spending context on facts the model has already seen. |
| `Stop` | Reads the finished turn back off the session transcript and persists it with `add_conversation`, tagged and scoped by `session_id`, `project` and `transcript_path`. Cortadel distils the durable facts server-side. Guards against re-entry via `stop_hook_active`. |

The `Stop` hook has to read the transcript because `StopHookInput` carries `session_id`,
`transcript_path` and `cwd` but no message content. It uses the SDK's own
`get_session_messages()` (which rebuilds the conversation chain and drops meta/sidechain entries)
and falls back to parsing the JSONL at `transcript_path` directly.

### Relationship to the `cortadel-memory` plugin

This repo also ships [`cortadel-plugin/`](../../cortadel-plugin), a Claude Code **plugin** that does
the same two things via command hooks in the CLI. Use the plugin for interactive Claude Code; use
this package when you are building an agent programmatically in Python. They are independent — do
not run both against the same session or every turn gets captured twice.

There is no TypeScript sibling to this package today. If you are on
`@anthropic-ai/claude-agent-sdk`, the same design maps over directly (`tool()` +
`createSdkMcpServer()` + `hooks`) on top of [`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk).

## Configuration

All keyword arguments to `CortadelMemory(base_url, user_id, ...)`:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | `str` | *required* | Cortadel server, e.g. `http://localhost:3001` or `https://app.cortadel.ai`. |
| `user_id` | `str` | *required* | Namespace anchor. Every memory read or written belongs to it. |
| `api_key` | `str \| None` | `None` | Sent as `Authorization: Bearer`. Omit when the server runs with auth disabled. |
| `app_name` | `str` | `"cortadel-claude-agent-sdk"` | Recorded for access logging on searches, and stamped as the creating app on tool-written memories. |
| `server_name` | `str` | `"cortadel"` | MCP server key; sets the `mcp__<server_name>__*` tool prefix. |
| `project` | `str \| None` | `None` | Project scope for captured conversations. Defaults to the basename of the session's `cwd`. |
| `tags` | `Sequence[str]` | `("claude-agent-sdk",)` | Tags applied to every fact extracted from a captured conversation. |
| `top_k` | `int` | `5` | Memories fetched per recall, and the `search_memory` tool's default when the model does not pass its own `top_k`. One knob serves both paths, so the tool defaults to 5 rather than the SDK's own `SearchOptions` default of 10 — automatic injection spends context on every turn, and 5 is the budget that survives a long session. |
| `rerank` | `str \| None` | `None` | Set to `"cross_encoder"` to rerank recall hits. Off by default — CPU reranking is too slow to sit in front of a prompt. |
| `scope_recall_to_session` | `bool` | `False` | Restrict automatic recall to the current SDK session (the hook's `session_id`). Off by default: recalling across sessions is the whole point of long-term memory. No effect on the `search_memory` tool, whose handler receives tool arguments and no session id. |
| `min_prompt_chars` | `int` | `10` | Prompts shorter than this skip recall. |
| `max_context_chars` | `int` | `4000` | Ceiling on the injected memory block. |
| `capture_max_chars` | `int` | `16000` | Ceiling on the conversation text sent to `add_conversation`. |
| `recall_timeout` | `float` | `10.0` | Seconds the `UserPromptSubmit` hook may spend before giving up. |
| `capture_timeout` | `float` | `60.0` | Seconds the `Stop` hook may spend before giving up. |
| `await_persist` | `bool` | `True` | Whether the `Stop` hook waits for the write before returning. **Defaults to `True`, against the repo-wide fire-and-forget default, because `Stop` fires at session end — hand the write to a background task and the event loop the agent ran on can be torn down before it lands, silently losing the turn.** Set it to `False` only if you keep the loop alive yourself, and call `aclose()` to drain what is still in flight. |
| `dedupe_injections` | `bool` | `True` | Never inject the same memory twice in one session. |
| `is_agent_memory` | `bool` | `False` | Extract facts about the *assistant* instead of the user. |
| `raise_on_error` | `bool` | `False` | Fail open: a memory failure inside a hook is swallowed and the turn proceeds. Set it to `True` to have the hook re-raise instead — what you want in tests and CI. |
| `on_error` | `Callable[[BaseException], None] \| None` | `None` | Called with the exception on every memory failure, from either path. |

Each matcher's `HookMatcher.timeout` is derived from `recall_timeout` / `capture_timeout` so the
CLI-side timeout never fires before this package's own.

### Error handling

A Cortadel outage must never take the agent down, so `raise_on_error` defaults to `False`.

```python
import logging

memory = CortadelMemory(
    "http://localhost:3001",
    "e2e-alice",
    on_error=lambda exc: logging.getLogger("agent").warning("cortadel: %s", exc),
)
```

The three paths differ, deliberately:

- **Hooks** (`UserPromptSubmit`, `Stop`) swallow the failure and return an empty result, so the
  turn proceeds untouched. With `raise_on_error=True` they re-raise instead.
- **Tools** always report the failure to the model as an `is_error` result with a readable message
  — that surfaces it rather than swallowing it, so `raise_on_error` does not change tool behaviour.
- **A background write** (`await_persist=False`) can only be observed: the hook that started it
  returned long ago, so there is nothing left to raise into.

`on_error` sees the exception in all three cases. When it is `None` **and** the failure was
swallowed, a warning goes to the `cortadel_claude_agent_sdk` logger instead. A callback that
itself raises is caught and logged — it can never break a turn.

### Alternative constructors

```python
# From the same env vars the cortadel-memory plugin reads:
#   CORTADEL_URL, CORTADEL_USER_ID, and optionally CORTADEL_API_KEY / CORTADEL_CLIENT_NAME
memory = CortadelMemory.from_env(top_k=8)

# From a Cortadel client you already own (shared, wrapped, or a test double).
# aclose() will NOT close a client passed in this way — you own its lifecycle.
memory = CortadelMemory.from_client(my_cortadel_client, top_k=8)
```

Both accept every other keyword argument in the table above. `aclose()` — reachable as
`async with memory:` — drains any in-flight background write before it closes the client, which is
what makes `await_persist=False` safe when you do want it.

## Running the tests

Offline unit tests — no network, no Cortadel server, no API keys.

```bash
cd integrations/claude-agent-sdk
uv sync --extra test
uv run pytest -q
```

## Requirements

- Python ≥ 3.10
- `claude-agent-sdk` ≥ 0.2.0 (developed and verified against 0.2.137). The SDK itself needs the
  Claude Code CLI and Anthropic credentials to run an agent; the tests here need neither.
- `cortadel` ≥ 1.0.0
- A running Cortadel server: hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` → `http://localhost:3001`.

## Links

- [github.com/cortadel/cortadel](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)

Apache-2.0.
