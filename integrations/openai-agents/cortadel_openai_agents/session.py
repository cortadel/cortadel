"""``CortadelSession`` — Cortadel long-term memory behind the Agents SDK's ``Session`` protocol.

Why this shape
--------------

The SDK's conversation-history seam is the ``Session`` protocol (``agents/memory/session.py``),
whose own docstring says: *"Third-party libraries should implement the Session protocol instead"*
of subclassing ``SessionABC``. So this class is structural — no base class — exactly as
``docs/sessions/index.md`` ("Custom session implementations") prescribes.

But a ``Session`` is a **verbatim transcript store**, and Cortadel is not one. The runner
round-trips items through it and matches them by fingerprint to rewind, retry, and pop
(``agents/run_internal/session_persistence.py``: ``rewind_session_items``,
``_rewind_session_tail_suffix``). Cortadel deliberately does not store transcripts: it distils
conversations into deduplicated facts, so two identical turns collapse into one and item order is
not preserved. Backing ``get_items``/``pop_item`` with Cortadel would corrupt the run loop.

So ``CortadelSession`` follows the SDK's own **wrapper-session** pattern — the one
``agents.extensions.memory.EncryptedSession(session_id, underlying_session, ...)`` uses. It holds
a *transcript* session (an in-memory ``SQLiteSession`` by default, or any ``Session`` you pass)
for exact short-term fidelity, and layers long-term memory on top:

* ``add_items`` → also distils the turn into Cortadel via ``add_conversation`` (**store**)
* :attr:`input_filter` → searches Cortadel and injects the hits into the model call (**recall**)

Why recall is a ``RunConfig.call_model_input_filter`` and not ``get_items``
--------------------------------------------------------------------------

``get_items()`` takes no query, and the runner calls it *before* the new turn's input exists
(``run.py`` calls ``prepare_input_with_session`` once, up front). On the very first turn there is
nothing at all to search on. ``call_model_input_filter`` runs immediately before each model call
with the full input in hand, is documented for exactly this ("you can use this to add a system
prompt to the input" — ``agents/run_config.py``), and receives a copy, so nothing we add is
written back into history. That last property matters: the injected block is **ephemeral**, so
context never accumulates memories turn after turn.
"""

from __future__ import annotations

import asyncio
import dataclasses
from typing import TYPE_CHECKING, Any, Literal

from agents import SessionSettings
from agents.items import TResponseInputItem
from agents.run import CallModelData, CallModelInputFilter, ModelInputData, RunConfig
from cortadel import ChatMessage, ConversationOptions, CortadelClient, SearchOptions

from ._items import last_user_index, last_user_text, message_pairs
from ._memory import (
    DEFAULT_APP_NAME,
    DEFAULT_MEMORY_HEADER,
    OnError,
    build_client,
    call_safely,
    filter_hits,
    format_memory_block,
    header_already_present,
    logger,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from agents.memory import Session
    from agents.tool import FunctionTool

__all__ = ["CortadelSession", "InjectionSite"]

#: Where the recalled-memory block is placed in the model call.
#:
#: * ``"instructions"`` appends it to the system prompt — the plainest reading of the SDK's own
#:   suggestion for this filter, and unambiguous for the model.
#: * ``"input"`` inserts it as a system message immediately *before* the latest user message.
#:   That leaves the instructions and the earlier history byte-identical between turns, so a
#:   provider's prompt-prefix cache still hits, and it puts the facts next to the question.
InjectionSite = Literal["instructions", "input"]


class CortadelSession:
    """A ``Session`` that keeps short-term history locally and long-term memory in Cortadel.

    Wire both halves into a run::

        session = CortadelSession(session_id="chat-1", user_id="e2e-alice")
        result = await Runner.run(
            agent, "…", session=session, run_config=session.run_config()
        )

    Passing only ``session=`` still stores memories and keeps history; recall additionally needs
    the run config, because the filter is a ``RunConfig`` field.

    Args:
        session_id: Conversation identifier. Used as the transcript's key and sent to Cortadel as
            ``ConversationOptions.session_id`` so recalled facts stay groupable by conversation.
        user_id: The memory namespace owner. A Cortadel client is bound to one user id at
            construction, so one ``CortadelSession`` serves exactly one user — never share an
            instance across users.
        base_url: Cortadel server URL. Defaults to ``$CORTADEL_BASE_URL`` then
            ``http://localhost:3001``.
        api_key: Bearer token. Defaults to ``$CORTADEL_API_KEY``; omit when auth is disabled.
        app_name: Recorded for access logging on searches.
        client: A pre-built :class:`cortadel.CortadelClient` to use instead of constructing one.
            It must already be scoped to ``user_id``. When supplied, this session will not close
            it for you.
        transcript: The ``Session`` that holds verbatim history. Defaults to an in-memory
            ``SQLiteSession(session_id)``; pass a file-backed or Redis session to survive restarts.
        top_k: Number of memories to recall per turn.
        search_mode: Cortadel search mode — ``hybrid`` (default), ``text``, or ``vector``.
        rerank: Set to ``"cross_encoder"`` to rerank with the server's cross-encoder.
        min_score: Drop hits whose ``rrf_score`` is below this. ``None`` keeps everything.
        scope_recall_to_session: Restrict recall to facts extracted from *this* conversation
            (``SearchOptions.session_id``). Off by default — the point of long-term memory is that
            it crosses conversations.
        inject_as: See :data:`InjectionSite`.
        memory_header: Heading of the injected block; also the marker used to avoid
            double-injection.
        retrieve: Set ``False`` to disable recall while keeping storage.
        store: Set ``False`` to disable storage while keeping recall (a read-only agent).
        await_persist: Whether the write is awaited before the turn returns. ``True`` by default:
            ``Runner.run()`` is often the last thing a process does, and a fire-and-forget write
            would be cancelled at loop shutdown and silently lost. Set ``False`` to keep the turn
            off Cortadel's extraction latency — then close the session (``aclose()`` or
            ``async with``) so pending writes are drained.
        tags: Tags applied to every fact extracted from this conversation.
        project: Project scope applied to every fact extracted from this conversation.
        raise_on_error: By default Cortadel failures are reported and swallowed so the agent keeps
            running. Set ``True`` to surface them instead. It cannot apply to a background write
            (``await_persist=False``), which nothing is awaiting — those always go to ``on_error``
            or the log.
        on_error: Called with the exception on every Cortadel failure. Replaces the default
            warning log; may be ``async``. Use it to route memory failures into your own telemetry.
        session_settings: Standard SDK session settings (``limit``), forwarded to the transcript.
    """

    #: Part of the ``Session`` protocol. The runner reads it via ``getattr(session,
    #: "session_settings", None)`` in ``prepare_input_with_session``.
    session_settings: SessionSettings | None = None

    def __init__(
        self,
        session_id: str,
        user_id: str,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        app_name: str = DEFAULT_APP_NAME,
        client: CortadelClient | None = None,
        transcript: Session | None = None,
        top_k: int = 5,
        search_mode: str = "hybrid",
        rerank: str | None = None,
        min_score: float | None = None,
        scope_recall_to_session: bool = False,
        inject_as: InjectionSite = "instructions",
        memory_header: str = DEFAULT_MEMORY_HEADER,
        retrieve: bool = True,
        store: bool = True,
        await_persist: bool = True,
        tags: list[str] | None = None,
        project: str | None = None,
        raise_on_error: bool = False,
        on_error: OnError | None = None,
        session_settings: SessionSettings | dict[str, Any] | None = None,
    ) -> None:
        if not session_id:
            raise ValueError("session_id is required.")
        if not user_id:
            raise ValueError("user_id is required.")
        if inject_as not in ("instructions", "input"):
            raise ValueError(f'inject_as must be "instructions" or "input", got: {inject_as!r}')

        self.session_id = session_id
        self.user_id = user_id

        self._owns_client = client is None
        self.client: CortadelClient = client or build_client(
            user_id, base_url=base_url, api_key=api_key, app_name=app_name
        )

        self._owns_transcript = transcript is None
        self._transcript: Session = (
            transcript if transcript is not None else _default_transcript(session_id)
        )

        self.top_k = top_k
        self.search_mode = search_mode
        self.rerank = rerank
        self.min_score = min_score
        self.scope_recall_to_session = scope_recall_to_session
        self.inject_as: InjectionSite = inject_as
        self.memory_header = memory_header
        self.retrieve = retrieve
        self.store = store
        self.await_persist = await_persist
        self.tags = tags
        self.project = project
        self.raise_on_error = raise_on_error
        self.on_error = on_error

        if session_settings is None:
            self.session_settings = None
        elif isinstance(session_settings, SessionSettings):
            self.session_settings = session_settings
        else:
            self.session_settings = SessionSettings(**session_settings)

        # Messages seen since the last flush. Held until the assistant speaks so a turn reaches
        # Cortadel as a coherent user→assistant exchange rather than two half-exchanges.
        self._pending: list[ChatMessage] = []
        # One-entry search cache, invalidated whenever the conversation advances. The filter runs
        # once per model call, so without it a tool-using turn would search Cortadel repeatedly
        # for the same unchanged question.
        self._cached_query: str | None = None
        self._cached_block: str = ""
        # In-flight background writes when ``await_persist`` is False. Held so :meth:`aclose` can
        # drain them — an untracked task is a task the event loop will happily cancel on shutdown.
        self._persist_tasks: set[asyncio.Task[None]] = set()
        # Bound once so :attr:`input_filter` has a stable identity — attribute access on a method
        # otherwise mints a fresh bound object each time, which defeats identity comparisons and
        # any de-duplication a caller might do across run configs.
        self._bound_filter = self._call_model_input_filter

    # ------------------------------------------------------------------
    # Session protocol — verbatim history, delegated to the transcript
    # ------------------------------------------------------------------

    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        """Return conversation history. Pure passthrough — no memories are mixed in here.

        Recall deliberately happens in :attr:`input_filter` instead. Injecting into ``get_items``
        would put synthetic items into the list the runner fingerprints for rewind and pop.
        """
        return await self._transcript.get_items(limit)

    async def add_items(self, items: list[TResponseInputItem]) -> None:
        """Append items to history, and distil the exchange into Cortadel once complete."""
        await self._transcript.add_items(items)

        # New turn content invalidates the recall cache: the next question deserves a fresh
        # search, and it may now match the fact we are about to store.
        self._cached_query = None
        self._cached_block = ""

        if not self.store:
            return

        new_messages = [
            ChatMessage(role=role, content=text) for role, text in message_pairs(items)
        ]
        if not new_messages:
            return

        self._pending.extend(new_messages)
        if any(message.role == "assistant" for message in new_messages):
            if self.await_persist:
                await self.flush()
            else:
                self._persist_in_background()

    async def pop_item(self) -> TResponseInputItem | None:
        """Remove and return the most recent history item.

        If the popped item is still sitting unflushed in the pending buffer it is dropped too, so
        a rewound turn is never stored. Facts already written to Cortadel are **not** deleted —
        the store is bi-temporal and supersedes rather than erases.
        """
        item = await self._transcript.pop_item()
        if item is None:
            return None

        if self._pending:
            pairs = message_pairs([item])
            if pairs:
                role, text = pairs[-1]
                last = self._pending[-1]
                if last.role == role and last.content == text:
                    self._pending.pop()
        return item

    async def clear_session(self) -> None:
        """Clear the conversation transcript and any unflushed buffer.

        Long-term memories in Cortadel survive: clearing a chat window is not a request to forget
        the user. Delete memories explicitly with ``client.delete([...])`` if that is what you
        want.
        """
        await self._transcript.clear_session()
        self._pending.clear()
        self._cached_query = None
        self._cached_block = ""

    # ------------------------------------------------------------------
    # Storage
    # ------------------------------------------------------------------

    async def flush(self) -> None:
        """Send everything this session still owes Cortadel, and wait for it to land.

        That is any background write started under ``await_persist=False`` plus the current
        buffer: an awaited ``flush()`` is a hard synchronisation point, whatever ``await_persist``
        says. Called automatically once the assistant replies (when ``await_persist`` is on). Call
        it yourself before shutting down if a run ended without an assistant message — a tripped
        guardrail, say — and you do not want to wait for the next turn.
        """
        await self._drain_background_persists()
        await self._write_pending(raise_on_error=self.raise_on_error)

    async def _write_pending(self, *, raise_on_error: bool) -> None:
        if not self._pending:
            return

        # Clear before awaiting: a failure drops the batch rather than retrying it forever and
        # growing without bound while the server is down.
        batch, self._pending = self._pending, []
        await call_safely(
            lambda: self.client.add_conversation(
                batch,
                ConversationOptions(
                    session_id=self.session_id,
                    tags=self.tags,
                    project=self.project,
                ),
            ),
            description="add_conversation",
            raise_on_error=raise_on_error,
            default=None,
            on_error=self.on_error,
        )

    def _persist_in_background(self) -> None:
        """Start the write without waiting for it (``await_persist=False``).

        ``raise_on_error`` is deliberately forced off here: nothing awaits this task, so raising
        would only produce a never-retrieved task exception. Failures reach ``on_error`` (or the
        log) exactly as they do in the fail-open case.
        """
        task = asyncio.create_task(self._write_pending(raise_on_error=False))
        self._persist_tasks.add(task)
        task.add_done_callback(self._persist_tasks.discard)

    async def _drain_background_persists(self) -> None:
        tasks = tuple(self._persist_tasks)
        self._persist_tasks.clear()
        if tasks:
            await asyncio.gather(*tasks)

    # ------------------------------------------------------------------
    # Recall
    # ------------------------------------------------------------------

    @property
    def input_filter(self) -> CallModelInputFilter:
        """A ``CallModelInputFilter`` bound to this session.

        Assign it to ``RunConfig.call_model_input_filter``, or use :meth:`run_config`.
        """
        return self._bound_filter

    def run_config(self, base: RunConfig | None = None) -> RunConfig:
        """Return a ``RunConfig`` with :attr:`input_filter` installed.

        ``base`` is copied rather than mutated, so your other run settings are preserved::

            run_config=session.run_config(RunConfig(model="gpt-4.1-mini"))
        """
        if base is None:
            return RunConfig(call_model_input_filter=self.input_filter)

        if base.call_model_input_filter is not None:
            # A RunConfig holds exactly one filter, so this one wins. Say so rather than letting
            # the caller's filter vanish silently.
            logger.warning(
                "Replacing the existing call_model_input_filter on the supplied RunConfig with "
                "Cortadel's. Compose them yourself if you need both."
            )
        return dataclasses.replace(base, call_model_input_filter=self.input_filter)

    async def _call_model_input_filter(self, data: CallModelData[Any]) -> ModelInputData:
        model_data = data.model_data
        if not self.retrieve:
            return model_data

        items = list(model_data.input)
        query = last_user_text(items)
        if not query:
            # Nothing to search on (an image-only or tool-only turn). Leave the call untouched.
            return model_data

        if header_already_present(self.memory_header, [model_data.instructions, *_texts(items)]):
            return model_data

        block = await self._recall(query)
        if not block:
            return model_data

        if self.inject_as == "instructions":
            instructions = (
                f"{model_data.instructions}\n\n{block}" if model_data.instructions else block
            )
            return ModelInputData(input=items, instructions=instructions)

        insert_at = last_user_index(items)
        memory_item: TResponseInputItem = {"role": "system", "content": block}  # type: ignore[typeddict-item]
        position = len(items) if insert_at is None else insert_at
        return ModelInputData(
            input=[*items[:position], memory_item, *items[position:]],
            instructions=model_data.instructions,
        )

    async def _recall(self, query: str) -> str:
        if self._cached_query == query:
            return self._cached_block

        results = await call_safely(
            lambda: self.client.search(
                query,
                SearchOptions(
                    top_k=self.top_k,
                    mode=self.search_mode,
                    rerank=self.rerank,
                    session_id=self.session_id if self.scope_recall_to_session else None,
                ),
            ),
            description="search",
            raise_on_error=self.raise_on_error,
            default=None,
            on_error=self.on_error,
        )

        hits = filter_hits(results.results, self.min_score) if results is not None else []
        block = format_memory_block(hits, self.memory_header)

        self._cached_query = query
        self._cached_block = block
        logger.debug(
            "Cortadel recall for session=%s user=%s: %d hit(s)",
            self.session_id,
            self.user_id,
            len(hits),
        )
        return block

    # ------------------------------------------------------------------
    # Tools and lifecycle
    # ------------------------------------------------------------------

    def tools(self) -> list[FunctionTool]:
        """Memory tools bound to this session's client, for agents that call memory explicitly.

        The session's own retrieval settings are inherited, so a tool call and an automatic recall
        see the same memories. That includes ``top_k``: these tools therefore default to **5**,
        this session's default, not the 10 a standalone ``cortadel_memory_tools()`` uses.
        """
        from .tools import cortadel_memory_tools

        return cortadel_memory_tools(
            client=self.client,
            top_k=self.top_k,
            search_mode=self.search_mode,
            rerank=self.rerank,
            min_score=self.min_score,
            session_id=self.session_id if self.scope_recall_to_session else None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )

    async def aclose(self) -> None:
        """Flush pending memories, then release anything this session created itself.

        Background writes started with ``await_persist=False`` are drained by that flush, so
        closing is the point at which every memory this session produced has actually been sent.

        A ``client`` or ``transcript`` you passed in is yours to close; only the defaults this
        session built are closed here.
        """
        await self.flush()

        if self._owns_transcript:
            closer = getattr(self._transcript, "close", None)
            if callable(closer):
                result = closer()
                if hasattr(result, "__await__"):
                    await result

        if self._owns_client:
            await self.client.aclose()

    async def __aenter__(self) -> CortadelSession:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    def __repr__(self) -> str:
        return (
            f"CortadelSession(session_id={self.session_id!r}, user_id={self.user_id!r}, "
            f"top_k={self.top_k}, inject_as={self.inject_as!r})"
        )


def _default_transcript(session_id: str) -> Session:
    """An in-memory ``SQLiteSession`` — the SDK's own transcript, lost when the process exits."""
    from agents import SQLiteSession

    return SQLiteSession(session_id)


def _texts(items: list[TResponseInputItem]) -> list[Any]:
    return [item.get("content") if isinstance(item, dict) else None for item in items]
