# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Cortadel memory exposed as Agent Framework tools the agent can call itself.

Where :class:`~cortadel_agent_framework.CortadelContextProvider` gives an agent memory it never
has to ask for, these give it memory it can *choose* to use — recalling on demand mid-reasoning,
or deliberately committing something worth keeping.

Both are built with the framework's own tool primitive: ``agent_framework.tool``, which turns an
annotated function into a :class:`~agent_framework.FunctionTool` and derives the JSON schema from
the signature (``Annotated[...]`` strings become parameter descriptions).
"""

from __future__ import annotations

import asyncio
import logging

# `Annotated` is in the stdlib from 3.9, so no typing-extensions dependency is needed at our
# 3.10 floor. Agent Framework reads the annotation metadata to build each parameter's description.
from typing import TYPE_CHECKING, Annotated, Optional

from agent_framework import tool
from cortadel import AddOptions, CortadelClient, SearchOptions

from ._errors import ErrorCallback, report_failure

if TYPE_CHECKING:  # pragma: no cover - typing only
    from agent_framework import FunctionTool

__all__ = ["add_memories_tool", "cortadel_memory_tools", "search_memory_tool"]

logger = logging.getLogger(__name__)

#: Value recorded on memories written through the ``add_memories`` tool.
TOOL_APP_NAME = "cortadel-agent-framework"


def search_memory_tool(
    client: CortadelClient,
    *,
    name: str = "search_memory",
    top_k: int = 10,
    rerank: Optional[str] = None,
    raise_on_error: bool = False,
    on_error: Optional[ErrorCallback] = None,
) -> FunctionTool:
    """Build a ``search_memory`` tool bound to a Cortadel client.

    Args:
        client: The Cortadel client to search. Bound at build time, so the tool is already
            scoped to that client's user — the model cannot reach another user's memories.

    Keyword Args:
        name: Tool name exposed to the model.
        top_k: Result count used when the model does not ask for one. Defaults to ``10``,
            matching the Cortadel SDK's own ``SearchOptions`` default for an explicit search
            (:class:`~cortadel_agent_framework.CortadelContextProvider` retrieves fewer, because
            it injects on every turn whether the agent wanted memories or not).
        rerank: Pass ``"cross_encoder"`` to rerank results server-side.
        raise_on_error: Propagate a Cortadel failure to the framework's tool machinery instead of
            answering the model with a graceful "memory is unavailable" note. Defaults to
            ``False`` — a memory outage must never take the agent down.
        on_error: Callback invoked with the exception when the search fails. Replaces the warning
            log; the model still gets the graceful note unless ``raise_on_error`` is set.

    Returns:
        A :class:`~agent_framework.FunctionTool` ready to hand to ``Agent(tools=[...])``.
    """
    # Bound to a local before the closure below shadows the name with its own model-facing
    # `top_k` parameter (the SDK's spelling, which the JSON schema exposes to the model).
    fallback_top_k = top_k

    async def search_memory(
        query: Annotated[str, "What to recall, phrased as a natural-language question or topic."],
        top_k: Annotated[Optional[int], "How many memories to return (1-50). Defaults to 10."] = None,
    ) -> str:
        """Search your long-term memory for facts recalled from earlier conversations.

        Use this whenever the answer might depend on something the user told you before.
        Returns one memory per line, most relevant first, or a note that nothing was found.
        """
        try:
            results = await client.search(
                query,
                SearchOptions(top_k=_clamp_top_k(top_k, fallback_top_k), rerank=rerank),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            report_failure(
                exc,
                "Cortadel search_memory tool failed.",
                logger=logger,
                raise_on_error=raise_on_error,
                on_error=on_error,
            )
            return "Memory is temporarily unavailable; answer without it."

        hits = results.results or []
        if not hits:
            return f"No memories found for: {query}"

        lines = []
        for hit in hits:
            text = (hit.gist or hit.content or "").strip().replace("\n", " ")
            if text:
                lines.append(f"- {text}")
        return "\n".join(lines) if lines else f"No memories found for: {query}"

    return tool(
        search_memory,
        name=name,
        description=(
            "Search long-term memory for facts about the user recalled from earlier "
            "conversations. Call this before answering anything that may depend on prior context."
        ),
    )


def add_memories_tool(
    client: CortadelClient,
    *,
    name: str = "add_memories",
    infer: Optional[bool] = None,
    memory_type: Optional[str] = None,
    raise_on_error: bool = False,
    on_error: Optional[ErrorCallback] = None,
) -> FunctionTool:
    """Build an ``add_memories`` tool bound to a Cortadel client.

    Args:
        client: The Cortadel client to write to. Bound at build time, so writes always land in
            that client's user namespace.

    Keyword Args:
        name: Tool name exposed to the model.
        infer: ``False`` stores the text verbatim and skips background entity/category
            extraction (Cortadel's dedup still applies). Defaults to the server's ``True``.
        memory_type: Pin the cognitive type — ``episodic``, ``semantic`` or ``procedural``.
        raise_on_error: Propagate a Cortadel failure to the framework's tool machinery instead of
            answering the model with a graceful "memory is unavailable" note. Defaults to
            ``False``.
        on_error: Callback invoked with the exception when the write fails. Replaces the warning
            log; the model still gets the graceful note unless ``raise_on_error`` is set.

    Returns:
        A :class:`~agent_framework.FunctionTool` ready to hand to ``Agent(tools=[...])``.
    """

    async def add_memories(
        text: Annotated[str, "The fact to remember, written as one self-contained sentence."],
    ) -> str:
        """Save a durable fact to your long-term memory.

        Use this for things worth recalling in future conversations — stable preferences,
        decisions, constraints and commitments — not for small talk or transient details.
        """
        if not text or not text.strip():
            return "Nothing to remember: the text was empty."
        try:
            created = await client.add(
                text,
                AddOptions(app=TOOL_APP_NAME, infer=infer, memory_type=memory_type),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            report_failure(
                exc,
                "Cortadel add_memories tool failed.",
                logger=logger,
                raise_on_error=raise_on_error,
                on_error=on_error,
            )
            return "Memory is temporarily unavailable; the fact was not saved."

        # A 2xx does not mean a new memory was written — Cortadel reports what the store
        # pipeline actually decided (ADD, SKIP_DUPLICATE, SUPERSEDE, TOUCH, ...).
        if created.event == "SKIP_DUPLICATE":
            return "Already remembered; nothing new was stored."
        return f"Remembered (event: {created.event or 'ADD'})."

    return tool(
        add_memories,
        name=name,
        description=(
            "Save a durable fact to long-term memory so it can be recalled in future "
            "conversations. Use for stable preferences, decisions and constraints."
        ),
    )


def cortadel_memory_tools(
    client: CortadelClient,
    *,
    top_k: int = 10,
    rerank: Optional[str] = None,
    infer: Optional[bool] = None,
    raise_on_error: bool = False,
    on_error: Optional[ErrorCallback] = None,
) -> list[FunctionTool]:
    """Build both Cortadel memory tools for one client.

    Convenience over calling :func:`search_memory_tool` and :func:`add_memories_tool`::

        agent = Agent(client=chat_client, tools=cortadel_memory_tools(cortadel))

    Args:
        client: The Cortadel client both tools are bound to.

    Keyword Args:
        top_k: Result count ``search_memory`` uses when the model does not ask.
        rerank: Pass ``"cross_encoder"`` to rerank search results server-side.
        infer: Forwarded to ``add_memories``; ``False`` stores text verbatim.
        raise_on_error: Forwarded to both tools; ``True`` propagates Cortadel failures.
        on_error: Forwarded to both tools; observes Cortadel failures.

    Returns:
        ``[search_memory, add_memories]`` as Agent Framework ``FunctionTool``s.
    """
    return [
        search_memory_tool(
            client,
            top_k=top_k,
            rerank=rerank,
            raise_on_error=raise_on_error,
            on_error=on_error,
        ),
        add_memories_tool(
            client,
            infer=infer,
            raise_on_error=raise_on_error,
            on_error=on_error,
        ),
    ]


def _clamp_top_k(requested: Optional[int], fallback: int) -> int:
    """Clamp a model-supplied ``top_k`` into the 1-50 range Cortadel accepts."""
    value = requested if isinstance(requested, int) and requested > 0 else fallback
    return max(1, min(50, value))
