"""Cortadel memory as DeepAgents-native tools.

These are ordinary LangChain `StructuredTool`s built the way DeepAgents builds its own built-ins
(`StructuredTool.from_function(func=..., coroutine=..., infer_schema=False, args_schema=...)` with
an injected `runtime: ToolRuntime` parameter — see
`deepagents.middleware.filesystem.FilesystemMiddleware._create_ls_tool`), so they can be handed
straight to `create_deep_agent(tools=[...])`, attached to a middleware's `.tools`, or given to a
subagent.

The `runtime` injection is what makes per-user scoping work: `ToolRuntime` carries `.context` and
`.config`, which is where a DeepAgents run keeps its user id.

!!! warning "This module deliberately omits `from __future__ import annotations`"

    `StructuredTool._injected_args_keys` (langchain-core `tools/structured.py`) detects injected
    arguments from **raw** `inspect.signature(fn).parameters[...].annotation` values, without
    resolving them through `get_type_hints`. Under PEP 563 those annotations are plain strings,
    `_is_injected_arg_type("ToolRuntime[...]")` is `False`, and `runtime` is silently stripped
    from the call — the tool then fails at invocation with a missing-argument `TypeError`.
    DeepAgents' own tool modules omit the future import for the same reason. Every name used in an
    annotation below must therefore be imported at runtime, not under `TYPE_CHECKING`.
"""

import asyncio
import logging
from collections.abc import Callable, Sequence
from typing import Any

from cortadel import AddOptions, SearchOptions, SyncCortadelClient
from langchain.tools import ToolRuntime
from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field

from cortadel_deepagents._client import DEFAULT_APP_NAME, ClientProvider
from cortadel_deepagents._errors import OnError, describe, notify
from cortadel_deepagents._format import format_search_results

logger = logging.getLogger(__name__)

SEARCH_MEMORY_DESCRIPTION = """Search the user's long-term memory for facts recorded in earlier \
conversations.

Use this when the current conversation does not contain something you need and it plausibly came \
up before: a stated preference, a past decision and its reason, a person or project the user has \
mentioned, a correction they made. Search is hybrid (keyword + semantic), so phrase the query the \
way the fact would have been stated rather than as keywords.

Relevant memories are already recalled for you at the start of each turn; call this only when you \
need something that recall did not surface."""

ADD_MEMORIES_DESCRIPTION = """Record durable facts about the user in long-term memory.

The conversation itself is saved automatically when the turn ends, so use this only for something \
worth remembering that the transcript would not make obvious: an explicit "remember this", a \
preference the user stated in passing, a decision plus the reasoning behind it, or a correction of \
something you got wrong.

Write each fact as one self-contained sentence that will still make sense months from now, with no \
pronouns pointing back at this conversation. Do not record transient state, one-off task requests, \
or small talk. Never record credentials, API keys, or access tokens."""


class SearchMemorySchema(BaseModel):
    """Arguments for `search_memory`."""

    query: str = Field(description="What to look for, phrased as the fact might have been stated.")
    # 10 matches the Cortadel SDK's own `SearchOptions.top_k`, and is deliberately wider than the
    # middleware's automatic per-turn recall (5): the model only reaches for this tool when that
    # recall already came up short.
    top_k: int = Field(default=10, ge=1, le=50, description="Maximum number of memories to return.")


class AddMemoriesSchema(BaseModel):
    """Arguments for `add_memories`."""

    memories: list[str] = Field(
        description="One or more self-contained facts to remember, each a single sentence.",
    )


def _client_for(provider: ClientProvider, runtime: ToolRuntime[Any, Any]) -> SyncCortadelClient | None:
    return provider.for_run(runtime, getattr(runtime, "config", None))


def create_cortadel_tools(
    *,
    base_url: str | None = None,
    user_id: str | None = None,
    api_key: str | None = None,
    app_name: str | None = None,
    client: SyncCortadelClient | None = None,
    client_factory: Callable[[str], SyncCortadelClient] | None = None,
    user_id_key: str = "user_id",
    provider: ClientProvider | None = None,
    search_mode: str = "hybrid",
    rerank: bool = False,
    memory_type: str | None = None,
    raise_on_error: bool = False,
    on_error: OnError | None = None,
) -> list[BaseTool]:
    """Build the `search_memory` and `add_memories` tools.

    Every argument except `provider` mirrors
    [`CortadelMemoryMiddleware`][cortadel_deepagents.CortadelMemoryMiddleware]; see its docstring
    and the README configuration table.

    Args:
        provider: An existing `ClientProvider` to share (the middleware passes its own, so the
            middleware and its tools reuse one client cache). When given, the connection
            arguments above are ignored.
        raise_on_error: Re-raise a Cortadel failure instead of returning the explanatory string.
            Off by default, because a tool that raises aborts the agent's turn and Cortadel being
            unreachable is a degraded state, not an agent bug. Turn it on in tests and CI.
        on_error: Callback invoked with the exception whenever a tool's Cortadel call fails. It
            observes; `raise_on_error` decides. With no callback set, a swallowed failure is
            logged as a warning.

    Returns:
        `[search_memory, add_memories]`, ready for `create_deep_agent(tools=...)`.
    """
    resolved = provider or ClientProvider(
        base_url=base_url,
        user_id=user_id,
        api_key=api_key,
        # One source of truth for the default: it is this integration's published package name.
        app_name=app_name or DEFAULT_APP_NAME,
        client=client,
        client_factory=client_factory,
        user_id_key=user_id_key,
    )

    def _unavailable(action: str, error: Exception) -> str:
        """Uniform, non-raising failure text.

        A tool that raises aborts the agent's turn, so by default the model is told plainly that
        memory is degraded and carries on. `on_error` still observes the failure, and
        `raise_on_error=True` opts into the abort.
        """
        observed = notify(on_error, action, error)
        if raise_on_error:
            raise error
        detail = describe(error)
        if not observed:
            logger.warning("cortadel-deepagents: %s failed (%s)", action, detail)
        logger.debug("Cortadel %s failure", action, exc_info=True)
        return f"Cortadel memory is unavailable right now ({detail}). Continue without it."

    def _search(query: str, top_k: int, cortadel: SyncCortadelClient) -> str:
        results = cortadel.search(
            query,
            SearchOptions(
                top_k=top_k,
                mode=search_mode,
                rerank="cross_encoder" if rerank else None,
                memory_type=memory_type,
            ),
        )
        return format_search_results(results.results, query)

    def _add(memories: Sequence[str], cortadel: SyncCortadelClient) -> str:
        texts = [text.strip() for text in memories if text and text.strip()]
        if not texts:
            return "Nothing to remember: no non-empty memories were provided."
        options = AddOptions(app=resolved.app_name, memory_type=memory_type)
        stored: list[str] = []
        for text in texts:
            created = cortadel.add(text, options)
            # `event` matters: a 200 does not mean a new memory was written. The write pipeline
            # may have deduplicated, superseded, or merged it.
            stored.append(f"{created.event or 'ADD'}: {created.content or text}")
        return "Recorded in Cortadel:\n" + "\n".join(f"- {line}" for line in stored)

    def search_memory(runtime: ToolRuntime[Any, Any], query: str, top_k: int = 10) -> str:
        cortadel = _client_for(resolved, runtime)
        if cortadel is None:
            return "Cortadel memory is not configured for this run; continue without it."
        try:
            return _search(query, top_k, cortadel)
        except Exception as error:  # noqa: BLE001 - never abort the agent over memory
            return _unavailable("search_memory", error)

    async def asearch_memory(runtime: ToolRuntime[Any, Any], query: str, top_k: int = 10) -> str:
        cortadel = _client_for(resolved, runtime)
        if cortadel is None:
            return "Cortadel memory is not configured for this run; continue without it."
        try:
            # `SyncCortadelClient` is blocking (it drives its own background loop), so it is
            # offloaded rather than awaited, keeping the agent's event loop free.
            return await asyncio.to_thread(_search, query, top_k, cortadel)
        except Exception as error:  # noqa: BLE001
            return _unavailable("search_memory", error)

    def add_memories(runtime: ToolRuntime[Any, Any], memories: list[str]) -> str:
        cortadel = _client_for(resolved, runtime)
        if cortadel is None:
            return "Cortadel memory is not configured for this run; nothing was recorded."
        try:
            return _add(memories, cortadel)
        except Exception as error:  # noqa: BLE001
            return _unavailable("add_memories", error)

    async def aadd_memories(runtime: ToolRuntime[Any, Any], memories: list[str]) -> str:
        cortadel = _client_for(resolved, runtime)
        if cortadel is None:
            return "Cortadel memory is not configured for this run; nothing was recorded."
        try:
            return await asyncio.to_thread(_add, memories, cortadel)
        except Exception as error:  # noqa: BLE001
            return _unavailable("add_memories", error)

    return [
        StructuredTool.from_function(
            name="search_memory",
            description=SEARCH_MEMORY_DESCRIPTION,
            func=search_memory,
            coroutine=asearch_memory,
            infer_schema=False,
            args_schema=SearchMemorySchema,
        ),
        StructuredTool.from_function(
            name="add_memories",
            description=ADD_MEMORIES_DESCRIPTION,
            func=add_memories,
            coroutine=aadd_memories,
            infer_schema=False,
            args_schema=AddMemoriesSchema,
        ),
    ]
