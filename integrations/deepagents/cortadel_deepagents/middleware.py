"""`CortadelMemoryMiddleware` — automatic long-term memory for a deep agent.

DeepAgents is assembled entirely out of `AgentMiddleware`: `create_deep_agent` stacks
`FilesystemMiddleware`, `SubAgentMiddleware`, `SummarizationMiddleware` and friends, and
`middleware=[...]` is the one seam it gives you to add your own. Its *own* long-term memory
feature — `deepagents.middleware.memory.MemoryMiddleware` — is an `AgentMiddleware` that loads
`AGENTS.md` files in `before_agent` and injects them into the system prompt from
`wrap_model_call`. This class is the same shape, with Cortadel's hybrid search standing in for a
static file read, plus the write half that a file-backed memory cannot do on its own.

Lifecycle, mapped onto the three hooks DeepAgents actually gives us:

| Hook              | Runs             | What we do                                              |
|-------------------|------------------|---------------------------------------------------------|
| `before_agent`    | once per turn    | hybrid-search Cortadel for the new user message         |
| `wrap_model_call` | every model call | inject the recalled block into the system message       |
| `after_agent`     | once per turn    | `add_conversation` the messages added during this turn  |

Putting retrieval in `before_agent` (not `before_model`) is the point: a deep agent makes many
model calls per turn — planning, tool loops, subagent dispatch — and one search per *turn* is
correct, whereas one search per *model call* would multiply latency and cost by the length of the
loop for no new information. The recalled set lives in private state, and `wrap_model_call`
re-renders it into the system message on every call, so it is present for the whole loop without
being re-fetched, and without ever accumulating: the injection is applied to a per-call
`ModelRequest` override, never written back into the conversation.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Annotated, Any, NotRequired

from cortadel import ChatMessage, ConversationOptions, SearchOptions
from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    ContextT,
    ModelRequest,
    ModelResponse,
    PrivateStateAttr,
    ResponseT,
)

from cortadel_deepagents._client import DEFAULT_APP_NAME, ClientProvider, resolve_thread_id
from cortadel_deepagents._errors import OnError, describe, notify
from cortadel_deepagents._format import (
    CORTADEL_SYSTEM_PROMPT,
    RecalledMemory,
    append_to_system_message,
    hit_to_recalled,
    render_memories,
    validate_system_prompt,
)
from cortadel_deepagents._messages import latest_user_text, to_chat_messages
from cortadel_deepagents.tools import create_cortadel_tools

if TYPE_CHECKING:  # pragma: no cover - typing only
    from collections.abc import Awaitable, Callable, Sequence

    from cortadel import SyncCortadelClient
    from langchain_core.runnables import RunnableConfig
    from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)


class CortadelMemoryState(AgentState):
    """State added by `CortadelMemoryMiddleware`.

    Every field is a `PrivateStateAttr`: it is checkpointed (so it survives across turns on a
    thread) but hidden from the agent's input/output schema, matching how
    `deepagents.middleware.memory.MemoryState.memory_contents` is declared.
    """

    cortadel_memories: NotRequired[Annotated[list[RecalledMemory], PrivateStateAttr]]
    """Memories recalled for the current turn, rendered into the system prompt."""

    cortadel_recall_query: NotRequired[Annotated[str, PrivateStateAttr]]
    """The query the current `cortadel_memories` were recalled for.

    Guards against re-searching on a resumed run: a deep agent that interrupts for human approval
    re-enters `before_agent` with the same last human message, and repeating the search would cost
    a round trip to return the same hits.
    """

    cortadel_persisted_count: NotRequired[Annotated[int, PrivateStateAttr]]
    """How many messages have already been written to Cortadel.

    Only the suffix after this index is sent on the next `after_agent`, so a long-lived thread
    never re-ingests its own history.
    """


class CortadelMemoryMiddleware(AgentMiddleware[CortadelMemoryState, ContextT, ResponseT]):
    """Give a deep agent Cortadel long-term memory: automatic recall, automatic persistence, tools.

    ```python
    from deepagents import create_deep_agent
    from cortadel_deepagents import CortadelMemoryMiddleware

    memory = CortadelMemoryMiddleware(base_url="http://localhost:3001", user_id="e2e-demo-user")
    agent = create_deep_agent(model="anthropic:claude-sonnet-4-6", middleware=[memory])
    ```

    Cortadel clients are bound to one user id at construction, so multi-user agents resolve the id
    per run from `runtime.context.user_id` or `config["configurable"]["user_id"]` and get a cached
    client per user. See the README's "Per-user scoping" section.
    """

    state_schema = CortadelMemoryState

    def __init__(
        self,
        *,
        base_url: str | None = None,
        user_id: str | None = None,
        api_key: str | None = None,
        app_name: str = DEFAULT_APP_NAME,
        client: SyncCortadelClient | None = None,
        client_factory: Callable[[str], SyncCortadelClient] | None = None,
        user_id_key: str = "user_id",
        top_k: int = 5,
        search_mode: str = "hybrid",
        rerank: bool = False,
        memory_type: str | None = None,
        scope_recall_to_session: bool = False,
        write_memories: bool = True,
        is_agent_memory: bool = False,
        tags: Sequence[str] | None = None,
        project: str | None = None,
        expose_tools: bool = True,
        system_prompt: str | None = CORTADEL_SYSTEM_PROMPT,
        raise_on_error: bool = False,
        on_error: OnError | None = None,
    ) -> None:
        """Initialize the middleware.

        Args:
            base_url: Cortadel server URL. Defaults to `$CORTADEL_BASE_URL`, then
                `http://localhost:3001`.
            user_id: Static Cortadel user id. Defaults to `$CORTADEL_USER_ID`. Leave unset for
                multi-user agents that resolve the id per run.
            api_key: Bearer token. Defaults to `$CORTADEL_API_KEY`. Omit when the server has auth
                disabled.
            app_name: Recorded on searches for access logging, and as `AddOptions.app` on writes.
            client: A caller-owned `SyncCortadelClient`. Pins the middleware to that client's user
                and is never closed by `close()`.
            client_factory: `user_id -> SyncCortadelClient`, for full control over per-user client
                construction.
            user_id_key: Attribute on `runtime.context` / key in `config["configurable"]` holding
                the user id.
            top_k: Memories recalled automatically per turn (Cortadel accepts 1-50). The
                `search_memory` tool carries its own `top_k`, defaulting to 10.
            search_mode: `hybrid` (default), `text`, or `vector`.
            rerank: Run Cortadel's cross-encoder reranker over the fused results. More accurate,
                slower.
            memory_type: Restrict recall (and tag writes made via `add_memories`) to one cognitive
                type: `episodic`, `semantic`, or `procedural`.
            scope_recall_to_session: Pass the LangGraph `thread_id` as Cortadel's `session_id` on
                *search*, restricting recall to memories from this thread (a LangGraph thread is
                the session here). Off by default: the point of long-term memory is that it
                crosses threads.
            write_memories: Persist each turn with `add_conversation` in `after_agent`. Set
                `False` for a read-only agent. The write is always awaited inside the hook — there
                is no fire-and-forget mode, because `after_agent` is the last node of the run: a
                detached write could be cut off when the run (or the process) ends, and the
                `cortadel_persisted_count` cursor could not be advanced honestly.
            is_agent_memory: Extract facts about the *assistant* rather than the user. Use for an
                agent that should accumulate its own operating knowledge.
            tags: Tags applied to every fact extracted from this agent's conversations.
            project: Cortadel project scope for extracted facts (e.g. a repo name).
            expose_tools: Also register the `search_memory` / `add_memories` tools on this
                middleware, so the agent can query and write memory itself.
            system_prompt: Prompt fragment injected into the system message. Must contain the
                `{cortadel_memories}` slot. Pass `None` to recall into state without injecting
                (useful if you render the block yourself).
            raise_on_error: Re-raise Cortadel failures instead of degrading to "no memory". Off by
                default — memory must never take the agent down. Useful in tests and CI.
            on_error: Callback invoked with the exception whenever a Cortadel call fails (recall,
                persistence, or either tool). Independent of `raise_on_error`: it observes, it
                does not decide. When it is unset, a swallowed failure is logged as a warning
                instead.

        Raises:
            TypeError: If `system_prompt` is neither `str` nor `None`.
            ValueError: If `system_prompt` is a string missing `{cortadel_memories}`.
        """
        self.system_prompt = validate_system_prompt(system_prompt)
        self.top_k = top_k
        self.search_mode = search_mode
        self.rerank = rerank
        self.memory_type = memory_type
        self.scope_recall_to_session = scope_recall_to_session
        self.write_memories = write_memories
        self.is_agent_memory = is_agent_memory
        self.tags = list(tags) if tags else None
        self.project = project
        self.raise_on_error = raise_on_error
        self.on_error = on_error

        self._provider = ClientProvider(
            base_url=base_url,
            user_id=user_id,
            api_key=api_key,
            app_name=app_name,
            client=client,
            client_factory=client_factory,
            user_id_key=user_id_key,
        )

        self.tools = (
            create_cortadel_tools(
                provider=self._provider,
                search_mode=search_mode,
                rerank=rerank,
                memory_type=memory_type,
                raise_on_error=raise_on_error,
                on_error=on_error,
            )
            if expose_tools
            else []
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _degrade(self, action: str, error: Exception) -> None:
        """Report a Cortadel failure, then swallow it — or re-raise under `raise_on_error`.

        `on_error` observes every failure, including the ones that go on to be re-raised: the two
        options are orthogonal, one reports and one decides. A swallowed failure with no observer
        falls back to a `logging` warning.
        """
        observed = notify(self.on_error, action, error)
        if self.raise_on_error:
            raise error
        if not observed:
            logger.warning(
                "cortadel-deepagents: %s failed (%s); continuing without memory.",
                action,
                describe(error),
            )
        logger.debug("Cortadel %s failure", action, exc_info=True)

    def _recall(
        self,
        cortadel: SyncCortadelClient,
        query: str,
        thread_id: str | None,
    ) -> list[RecalledMemory]:
        results = cortadel.search(
            query,
            SearchOptions(
                top_k=self.top_k,
                mode=self.search_mode,
                rerank="cross_encoder" if self.rerank else None,
                memory_type=self.memory_type,
                # A LangGraph thread is the session Cortadel scopes to.
                session_id=thread_id if self.scope_recall_to_session else None,
            ),
        )
        return [hit_to_recalled(hit) for hit in results.results]

    def _plan_recall(
        self,
        state: CortadelMemoryState,
        runtime: Runtime[ContextT] | None,
        config: RunnableConfig | None,
    ) -> tuple[SyncCortadelClient, str, str | None] | None:
        """Decide whether this turn needs a recall, and gather what it needs. `None` = skip."""
        query = latest_user_text(state.get("messages"))
        if not query:
            return None
        if state.get("cortadel_recall_query") == query:
            return None
        cortadel = self._provider.for_run(runtime, config)
        if cortadel is None:
            return None
        return cortadel, query, resolve_thread_id(config)

    def _plan_persist(
        self,
        state: CortadelMemoryState,
        runtime: Runtime[ContextT] | None,
        config: RunnableConfig | None,
    ) -> tuple[SyncCortadelClient, list[ChatMessage], int, str | None] | None:
        """Decide what to persist for this turn. `None` = nothing to do."""
        if not self.write_memories:
            return None
        messages = list(state.get("messages") or ())
        already = int(state.get("cortadel_persisted_count") or 0)
        if already >= len(messages):
            return None
        pending = to_chat_messages(messages[already:])
        if not pending:
            # Nothing storable in the new suffix (tool traffic only). The cursor stays put, which
            # is harmless: those messages are non-storable and will be skipped again next turn,
            # while any genuinely new dialogue after them is still picked up.
            return None
        cortadel = self._provider.for_run(runtime, config)
        if cortadel is None:
            return None
        return cortadel, pending, len(messages), resolve_thread_id(config)

    def _persist(
        self,
        cortadel: SyncCortadelClient,
        pending: list[ChatMessage],
        thread_id: str | None,
    ) -> None:
        cortadel.add_conversation(
            pending,
            ConversationOptions(
                is_agent_memory=self.is_agent_memory,
                tags=self.tags,
                project=self.project,
                session_id=thread_id,
            ),
        )

    # ------------------------------------------------------------------
    # Hooks: recall (once per turn)
    # ------------------------------------------------------------------

    def before_agent(
        self,
        state: CortadelMemoryState,
        runtime: Runtime[ContextT],
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """Recall memories relevant to this turn's user message."""
        plan = self._plan_recall(state, runtime, config)
        if plan is None:
            return None
        cortadel, query, thread_id = plan
        try:
            memories = self._recall(cortadel, query, thread_id)
        except Exception as error:  # noqa: BLE001 - memory degrades, the agent does not
            self._degrade("recall", error)
            return None
        return {"cortadel_memories": memories, "cortadel_recall_query": query}

    async def abefore_agent(
        self,
        state: CortadelMemoryState,
        runtime: Runtime[ContextT],
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """Async recall. Offloads the blocking client so the agent's event loop stays free."""
        plan = self._plan_recall(state, runtime, config)
        if plan is None:
            return None
        cortadel, query, thread_id = plan
        try:
            memories = await asyncio.to_thread(self._recall, cortadel, query, thread_id)
        except Exception as error:  # noqa: BLE001
            self._degrade("recall", error)
            return None
        return {"cortadel_memories": memories, "cortadel_recall_query": query}

    # ------------------------------------------------------------------
    # Hook: injection (every model call)
    # ------------------------------------------------------------------

    def _inject(self, request: ModelRequest[ContextT]) -> ModelRequest[ContextT]:
        """Append the recalled-memory block to this request's system message."""
        if self.system_prompt is None:
            return request
        memories = request.state.get("cortadel_memories")
        block = self.system_prompt.format(cortadel_memories=render_memories(memories))
        return request.override(
            system_message=append_to_system_message(request.system_message, block)
        )

    def wrap_model_call(
        self,
        request: ModelRequest[ContextT],
        handler: Callable[[ModelRequest[ContextT]], ModelResponse[ResponseT]],
    ) -> ModelResponse[ResponseT]:
        """Inject recalled memories into the system prompt for this model call."""
        return handler(self._inject(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[ContextT],
        handler: Callable[[ModelRequest[ContextT]], Awaitable[ModelResponse[ResponseT]]],
    ) -> ModelResponse[ResponseT]:
        """Async counterpart of `wrap_model_call`."""
        return await handler(self._inject(request))

    # ------------------------------------------------------------------
    # Hooks: persistence (once per turn)
    # ------------------------------------------------------------------

    def after_agent(
        self,
        state: CortadelMemoryState,
        runtime: Runtime[ContextT],
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """Persist the messages added during this turn via `add_conversation`."""
        plan = self._plan_persist(state, runtime, config)
        if plan is None:
            return None
        cortadel, pending, total, thread_id = plan
        try:
            self._persist(cortadel, pending, thread_id)
        except Exception as error:  # noqa: BLE001
            self._degrade("persist", error)
            # The cursor is deliberately NOT advanced: a failed write should be retried with the
            # next turn's suffix rather than silently dropped.
            return None
        return {"cortadel_persisted_count": total}

    async def aafter_agent(
        self,
        state: CortadelMemoryState,
        runtime: Runtime[ContextT],
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """Async counterpart of `after_agent`."""
        plan = self._plan_persist(state, runtime, config)
        if plan is None:
            return None
        cortadel, pending, total, thread_id = plan
        try:
            await asyncio.to_thread(self._persist, cortadel, pending, thread_id)
        except Exception as error:  # noqa: BLE001
            self._degrade("persist", error)
            return None
        return {"cortadel_persisted_count": total}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close every Cortadel client this middleware constructed.

        A `client=` you supplied yourself is left alone — you own its lifecycle.
        """
        self._provider.close()
