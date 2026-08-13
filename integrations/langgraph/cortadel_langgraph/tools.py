"""LangChain tools that let an agent read and write Cortadel memory on its own initiative.

These are ``langchain_core.tools.StructuredTool`` instances — the tool primitive every LangGraph
agent already speaks (``create_react_agent(tools=[...])``, ``ToolNode([...])``). Each is built with
both a ``func`` and a ``coroutine``, so the same tool object works in ``.invoke()`` and
``.ainvoke()`` graphs.

They operate through LangGraph's ``BaseStore``, not through a Cortadel client directly. That is
deliberate: passing ``store=None`` makes a tool resolve the ambient store via
``langgraph.config.get_store()`` at call time, so ``create_react_agent(store=CortadelStore(...))``
wires the tools up with no further plumbing — and the same tools keep working against an
``InMemoryStore`` in a unit test.
"""
from __future__ import annotations

import uuid
from typing import Any, Optional, Sequence

from langchain_core.tools import StructuredTool
from langgraph.store.base import BaseStore
from pydantic import BaseModel, Field, create_model

from ._namespace import DEFAULT_NAMESPACE, NamespaceLike, resolve_namespace
from ._runtime import ambient_store

__all__ = [
    "AddMemoriesInput",
    "SearchMemoryInput",
    "create_add_memories_tool",
    "create_memory_tools",
    "create_search_memory_tool",
]

_SEARCH_DESCRIPTION = (
    "Search the user's long-term memory for facts relevant to a question. Call this before "
    "answering anything that depends on who the user is, what they have told you before, their "
    "preferences, decisions, projects, or past events. Returns the most relevant stored facts, "
    "or a note that nothing was found."
)

_ADD_DESCRIPTION = (
    "Save durable facts to the user's long-term memory so they are available in future "
    "conversations. Store standalone, self-contained statements — each one should still make "
    "sense read on its own months from now. Do not store transient chatter, and do not store a "
    "fact you already retrieved from memory."
)


# 10 matches the Cortadel SDK's own ``SearchOptions.top_k`` default. An explicit search tool is
# asked for on purpose, so it can afford a wider net than the automatic injection in
# ``CortadelMemory`` (which defaults to 5 because every turn pays for it).
_DEFAULT_TOP_K = 10
_TOP_K_FIELD = dict(ge=1, le=50, description="Maximum number of memories to return.")


class SearchMemoryInput(BaseModel):
    """Arguments for the ``search_memory`` tool."""

    query: str = Field(
        description="What to look for, phrased as a natural-language question or topic."
    )
    top_k: int = Field(default=_DEFAULT_TOP_K, **_TOP_K_FIELD)


class AddMemoriesInput(BaseModel):
    """Arguments for the ``add_memories`` tool."""

    memories: list[str] = Field(
        description=(
            "One or more standalone facts to remember, each a complete sentence "
            '(e.g. "Prefers async written updates over meetings").'
        )
    )


def create_search_memory_tool(
    *,
    store: Optional[BaseStore] = None,
    namespace: NamespaceLike = DEFAULT_NAMESPACE,
    top_k: int = _DEFAULT_TOP_K,
    name: str = "search_memory",
    description: str = _SEARCH_DESCRIPTION,
) -> StructuredTool:
    """Build the ``search_memory`` tool.

    Args:
        store: Store to read from. ``None`` resolves the ambient store with
            ``langgraph.config.get_store()`` at call time, which requires the graph to have been
            compiled with ``store=``.
        namespace: Namespace to search, possibly templated (``("memories", "{user_id}")``).
            Placeholders are filled from ``config["configurable"]`` on each call.
        top_k: Default number of memories to return when the model does not say. Also the
            default baked into the tool's ``top_k`` argument schema.
        name: Tool name exposed to the model.
        description: Tool description exposed to the model.
    """

    def search_memory(query: str, top_k: int = top_k) -> str:
        resolved = _resolve_store(store)
        # `limit=` is BaseStore's own keyword, not ours — it stays spelled LangGraph's way.
        items = resolved.search(resolve_namespace(namespace), query=query, limit=top_k)
        return _format_memories(items)

    async def asearch_memory(query: str, top_k: int = top_k) -> str:
        resolved = _resolve_store(store)
        items = await resolved.asearch(resolve_namespace(namespace), query=query, limit=top_k)
        return _format_memories(items)

    return StructuredTool.from_function(
        func=search_memory,
        coroutine=asearch_memory,
        name=name,
        description=description,
        # The schema's default is what the model actually gets when it omits `top_k` — pydantic
        # fills it in before the function's own default is ever consulted — so the configured
        # value has to be baked into the schema, not just into the closure. Rename the schema
        # field and this argument together, or a configured top_k is silently ignored.
        args_schema=_search_schema(top_k),
    )


def create_add_memories_tool(
    *,
    store: Optional[BaseStore] = None,
    namespace: NamespaceLike = DEFAULT_NAMESPACE,
    name: str = "add_memories",
    description: str = _ADD_DESCRIPTION,
) -> StructuredTool:
    """Build the ``add_memories`` tool.

    Each fact becomes one ``store.put(namespace, <uuid4>, {"content": fact})``. Against a
    :class:`~cortadel_langgraph.store.CortadelStore` that lands in Cortadel's write pipeline, so
    duplicates and contradictions of existing memories are resolved server-side rather than piling
    up — the tool does not need to check first.

    Args:
        store: Store to write to. ``None`` resolves the ambient store at call time.
        namespace: Namespace to write into, possibly templated.
        name: Tool name exposed to the model.
        description: Tool description exposed to the model.
    """

    def add_memories(memories: list[str]) -> str:
        resolved = _resolve_store(store)
        target = resolve_namespace(namespace)
        stored = 0
        for text in _clean(memories):
            resolved.put(target, str(uuid.uuid4()), {"content": text})
            stored += 1
        return _format_stored(stored)

    async def aadd_memories(memories: list[str]) -> str:
        resolved = _resolve_store(store)
        target = resolve_namespace(namespace)
        stored = 0
        for text in _clean(memories):
            await resolved.aput(target, str(uuid.uuid4()), {"content": text})
            stored += 1
        return _format_stored(stored)

    return StructuredTool.from_function(
        func=add_memories,
        coroutine=aadd_memories,
        name=name,
        description=description,
        args_schema=AddMemoriesInput,
    )


def create_memory_tools(
    *,
    store: Optional[BaseStore] = None,
    namespace: NamespaceLike = DEFAULT_NAMESPACE,
    top_k: int = _DEFAULT_TOP_K,
) -> list[StructuredTool]:
    """Both memory tools, ready to drop into ``create_react_agent(tools=...)``."""
    return [
        create_search_memory_tool(store=store, namespace=namespace, top_k=top_k),
        create_add_memories_tool(store=store, namespace=namespace),
    ]


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────


def _search_schema(default_top_k: int) -> type[SearchMemoryInput]:
    """The search args schema, with ``top_k``'s default matching this tool's configuration."""
    if default_top_k == _DEFAULT_TOP_K:
        return SearchMemoryInput
    return create_model(
        "SearchMemoryInput",
        __base__=SearchMemoryInput,
        top_k=(int, Field(default=default_top_k, **_TOP_K_FIELD)),
    )


def _resolve_store(store: Optional[BaseStore]) -> BaseStore:
    if store is not None:
        return store
    resolved = ambient_store()
    if resolved is None:
        raise RuntimeError(
            "No store is available. Either pass store=CortadelStore(...) when building the tool, "
            "or compile the graph with it: create_react_agent(..., store=CortadelStore(...)) / "
            "StateGraph(...).compile(store=CortadelStore(...))."
        )
    return resolved


def _clean(memories: Sequence[str]) -> list[str]:
    return [text.strip() for text in memories if isinstance(text, str) and text.strip()]


def _format_stored(count: int) -> str:
    if count == 0:
        return "Nothing to store: no non-empty memories were provided."
    return f"Stored {count} " + ("memory." if count == 1 else "memories.")


def _format_memories(items: Sequence[Any]) -> str:
    """Render search results as the plain text that becomes the ``ToolMessage`` content."""
    if not items:
        return "No relevant memories found."
    lines = []
    for index, item in enumerate(items, start=1):
        value = getattr(item, "value", None) or {}
        text = _text_of(value)
        score = getattr(item, "score", None)
        suffix = f" (relevance {score:.3f})" if isinstance(score, (int, float)) else ""
        lines.append(f"{index}. {text}{suffix}")
    return "Relevant memories:\n" + "\n".join(lines)


def _text_of(value: Any) -> str:
    """Pull the human-readable text out of an ``Item.value``, whatever key it landed under."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("content", "text", "memory", "data"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        return "; ".join(f"{k}={v}" for k, v in value.items() if k != "id")
    return str(value)
