"""Cortadel memory as a pydantic-ai `FunctionToolset`.

This is the *explicit* half of the integration: two tools the model can decide to call. The
implicit half — recall before the model runs, persist after the turn — lives in
`CortadelMemory` (`memory.py`), which also ships this toolset via `get_toolset()`.

Use this module directly only when you want the tools without the automatic memory:

    agent = Agent("openai:gpt-5", toolsets=[cortadel_toolset(user_id="e2e-alice")])
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from pydantic_ai.toolsets import FunctionToolset

# Runtime import: pydantic-ai resolves the first parameter's annotation to decide whether a tool
# function receives `RunContext`. See the note in `_backend.py`.
from pydantic_ai.tools import RunContext

from ._backend import (
    DEFAULT_APP_NAME,
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT,
    DEFAULT_TOOL_TOP_K,
    ENV_API_KEY,
    ENV_BASE_URL,
    ENV_USER_ID,
    Backend,
    ClientFactory,
    UserId,
    resolve_setting,
)

__all__ = ["TOOLSET_ID", "cortadel_toolset"]

TOOLSET_ID = "cortadel-memory"
"""Stable toolset id, so the toolset is addressable in specs and tool-filtering hooks."""

_SEARCH_UNAVAILABLE = (
    "Long-term memory is temporarily unavailable. Answer from the current conversation instead."
)
_ADD_UNAVAILABLE = "Long-term memory is temporarily unavailable, so that was not saved."


def cortadel_toolset(
    *,
    base_url: Optional[str] = None,
    user_id: Optional[UserId] = None,
    api_key: Optional[str] = None,
    app_name: str = DEFAULT_APP_NAME,
    timeout: float = DEFAULT_TIMEOUT,
    top_k: int = DEFAULT_TOOL_TOP_K,
    search_mode: str = "hybrid",
    rerank: bool = False,
    memory_type: Optional[str] = None,
    client_factory: Optional[ClientFactory] = None,
    on_error: Optional[Callable[[Exception], None]] = None,
    raise_on_error: bool = False,
    id: str = TOOLSET_ID,  # noqa: A002 - matches FunctionToolset's own parameter name
) -> FunctionToolset[Any]:
    """Build a `FunctionToolset` exposing `search_memory` and `add_memories`.

    See `CortadelMemory` for the meaning of each option; they are the same knobs. `top_k`
    defaults to 10 here rather than the capability's 5: these results are pulled by an explicit
    model decision, not spent on every run.
    """
    backend = Backend(
        base_url=resolve_setting(base_url, ENV_BASE_URL, DEFAULT_BASE_URL) or DEFAULT_BASE_URL,
        user_id=_require_user_id(user_id),
        api_key=resolve_setting(api_key, ENV_API_KEY, None),
        app_name=app_name,
        timeout=timeout,
        client_factory=client_factory,
        on_error=on_error,
        raise_on_error=raise_on_error,
    )
    return build_toolset(
        backend,
        top_k=top_k,
        search_mode=search_mode,
        rerank=rerank,
        memory_type=memory_type,
        id=id,
    )


def _require_user_id(user_id: Optional[UserId]) -> UserId:
    if user_id is None:
        from_env = resolve_setting(None, ENV_USER_ID, None)
        if from_env:
            return from_env
        raise ValueError(
            'Cortadel needs a `user_id`: pass user_id="<your-user-id>", pass a callable '
            f"`lambda ctx: ...` to derive it from ctx.deps, or set ${ENV_USER_ID}."
        )
    return user_id


def build_toolset(
    backend: Backend,
    *,
    top_k: int = DEFAULT_TOOL_TOP_K,
    search_mode: str = "hybrid",
    rerank: bool = False,
    memory_type: Optional[str] = None,
    id: str = TOOLSET_ID,  # noqa: A002
) -> FunctionToolset[Any]:
    """Wrap an existing `Backend` in a toolset, so the capability and the standalone factory
    share one client cache and one error policy."""

    # Bound here rather than referenced from the closure: the tool's own parameter is also named
    # `top_k` (the canonical name for "how many memories"), which would shadow it in the body.
    default_top_k = top_k

    async def search_memory(ctx: RunContext[Any], query: str, top_k: int = default_top_k) -> str:
        """Search the user's long-term memory for facts relevant to a question.

        Use this whenever the answer might depend on something the user said in an earlier
        session — preferences, decisions, people, ongoing projects.

        Args:
            query: What to look for, phrased as a question or topic.
            top_k: Maximum number of memories to return (1-50).
        """
        hits = await backend.try_search(
            ctx,
            query,
            top_k=top_k,
            mode=search_mode,
            rerank=rerank,
            memory_type=memory_type,
        )
        if hits is None:
            return _SEARCH_UNAVAILABLE
        if not hits:
            return "No relevant memories found."
        lines = []
        for hit in hits:
            text = (hit.content or "").strip()
            if text:
                lines.append(f"- {text}")
        return "\n".join(lines) if lines else "No relevant memories found."

    async def add_memories(ctx: RunContext[Any], text: str) -> str:
        """Save a durable fact about the user to long-term memory.

        Store things worth recalling in a later session — stable preferences, decisions,
        commitments, corrections. Do not store small talk or anything already obvious from the
        current conversation.

        Args:
            text: The fact to remember, written as a complete sentence.
        """
        text = (text or "").strip()
        if not text:
            return "Nothing to save: the text was empty."
        created = await backend.try_add(ctx, text, memory_type=memory_type)
        if created is None:
            return _ADD_UNAVAILABLE
        # A successful call does not always mean a new memory was written — the write pipeline
        # deduplicates, supersedes and invalidates, and reports which happened via `event`.
        event = (created.event or "ADD").upper()
        if event == "SKIP_DUPLICATE":
            return "Already known — no duplicate was created."
        return f"Saved to long-term memory (event: {event})."

    toolset: FunctionToolset[Any] = FunctionToolset(id=id)
    # `takes_ctx=True` is explicit rather than inferred: it keeps tool registration working even
    # if annotation resolution is ever disturbed by a wrapper or a stringified-annotation edge.
    toolset.add_function(search_memory, takes_ctx=True, name="search_memory")
    toolset.add_function(add_memories, takes_ctx=True, name="add_memories")
    return toolset
