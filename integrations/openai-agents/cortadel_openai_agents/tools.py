"""Cortadel memory as Agents SDK function tools.

These are for agents that should decide *when* to remember — "look that up in your memory",
"remember this for next time". For memory that just happens, without the agent asking, use
:class:`~cortadel_openai_agents.session.CortadelSession` instead; the two compose fine.

Built with the SDK's own tool primitive, ``@function_tool`` (``agents/tool.py``), so the JSON
schema is derived from the signature and the Google-style docstring, and the result is a real
``FunctionTool`` — nothing to hand-wire.

Both tools are bound to one user id, because a Cortadel client is: no method on the SDK takes a
user id. Build one toolset per user.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agents import function_tool
from cortadel import AddOptions, CortadelClient, SearchOptions

from ._memory import (
    DEFAULT_APP_NAME,
    OnError,
    build_client,
    call_safely,
    filter_hits,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from agents.tool import FunctionTool

__all__ = ["cortadel_memory_tools"]

_NO_RESULTS = "No relevant memories found."


def cortadel_memory_tools(
    user_id: str | None = None,
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    app_name: str = DEFAULT_APP_NAME,
    client: CortadelClient | None = None,
    top_k: int = 10,
    search_mode: str = "hybrid",
    rerank: str | None = None,
    min_score: float | None = None,
    session_id: str | None = None,
    raise_on_error: bool = False,
    on_error: OnError | None = None,
) -> list[FunctionTool]:
    """Build the ``search_memory`` and ``add_memories`` tools for one user.

    ::

        agent = Agent(
            name="Assistant",
            instructions="Search your memory before answering personal questions.",
            tools=cortadel_memory_tools("e2e-alice", base_url="http://localhost:3001"),
        )

    Args:
        user_id: Memory namespace owner. Required unless ``client`` is given.
        base_url: Cortadel server URL. Defaults to ``$CORTADEL_BASE_URL`` then
            ``http://localhost:3001``.
        api_key: Bearer token. Defaults to ``$CORTADEL_API_KEY``; omit when auth is disabled.
        app_name: Recorded for access logging on searches, and set as the creating app on
            memories these tools write.
        client: A pre-built client, already scoped to the intended user. Mutually sufficient
            with ``user_id``; the caller owns its lifecycle.
        top_k: Number of hits ``search_memory`` returns. Defaults to the Cortadel SDK's own
            ``SearchOptions`` default — an agent that asked for memory deliberately can use more
            of it than an automatic per-turn injection can.
        search_mode: ``hybrid`` (default), ``text``, or ``vector``.
        rerank: Set to ``"cross_encoder"`` to rerank with the server's cross-encoder.
        min_score: Drop hits whose ``rrf_score`` is below this.
        session_id: Restrict ``search_memory`` to facts from one conversation. ``None`` searches
            everything the user has. :meth:`CortadelSession.tools` sets this when the session was
            built with ``scope_recall_to_session=True``.
        raise_on_error: By default a Cortadel failure is reported to the model as an ordinary
            tool result string, which lets the agent carry on. Set ``True`` to fail the run
            instead.
        on_error: Called with the exception on every Cortadel failure. Replaces the default
            warning log; may be ``async``.

    Returns:
        ``[search_memory, add_memories]`` as ``FunctionTool`` instances.
    """
    if client is None:
        if not user_id:
            raise ValueError("Pass either user_id or a pre-built client.")
        client = build_client(user_id, base_url=base_url, api_key=api_key, app_name=app_name)
    elif user_id:
        raise ValueError("Pass either user_id or client, not both — a client is already scoped.")

    bound = client

    # `function_tool` installs a default `failure_error_function` that converts any exception in
    # the tool body into a model-visible string. Passing `None` explicitly (rather than leaving
    # the parameter unset) disables that, which is what `raise_on_error=True` asks for.
    escalate: dict[str, Any] = {"failure_error_function": None} if raise_on_error else {}

    @function_tool(
        name_override="search_memory",
        description_override=(
            "Search the user's long-term memory for facts relevant to a question. Use this "
            "before answering anything that depends on who the user is, what they prefer, or "
            "what was decided in an earlier conversation."
        ),
        **escalate,
    )
    async def search_memory(query: str) -> str:
        """Search long-term memory.

        Args:
            query: What to look for, phrased in natural language.
        """
        results = await call_safely(
            lambda: bound.search(
                query,
                SearchOptions(
                    top_k=top_k, mode=search_mode, rerank=rerank, session_id=session_id
                ),
            ),
            description="search",
            raise_on_error=raise_on_error,
            default=None,
            on_error=on_error,
        )
        if results is None:
            return "Memory is currently unavailable. Answer without it."

        hits = filter_hits(results.results, min_score)
        lines = [hit.content.strip() for hit in hits if hit.content and hit.content.strip()]
        if not lines:
            return _NO_RESULTS
        return "\n".join(f"{index}. {line}" for index, line in enumerate(lines, start=1))

    @function_tool(
        name_override="add_memories",
        description_override=(
            "Store a durable fact about the user in long-term memory. Use this for stable "
            "preferences, decisions, and details worth recalling in a future conversation — not "
            "for passing chatter."
        ),
        **escalate,
    )
    async def add_memories(text: str) -> str:
        """Store a fact in long-term memory.

        Args:
            text: The fact to remember, as a single self-contained sentence.
        """
        created = await call_safely(
            lambda: bound.add(text, AddOptions(app=app_name)),
            description="add",
            raise_on_error=raise_on_error,
            default=None,
            on_error=on_error,
        )
        if created is None:
            return "Memory is currently unavailable; nothing was stored."

        # A successful call does not always mean a new memory: the write pipeline may have
        # deduplicated, superseded, or invalidated instead. Report what actually happened.
        if created.event == "SKIP_DUPLICATE":
            return "Already remembered; nothing new stored."
        if created.event and created.event != "ADD":
            return f"Stored (event: {created.event})."
        return "Stored."

    return [search_memory, add_memories]
