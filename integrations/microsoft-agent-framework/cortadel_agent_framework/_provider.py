# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Cortadel long-term memory as a Microsoft Agent Framework :class:`ContextProvider`.

The provider implements the ``before_run`` / ``after_run`` hook pair defined by
``agent_framework._sessions.ContextProvider`` (Agent Framework Python 1.13.0):

* ``before_run``  — hybrid-searches Cortadel with the current turn's input and injects the
  hits into the invocation context, so the model sees them without the agent asking.
* ``after_run``   — hands the completed turn to Cortadel's conversation pipeline, which
  distills durable facts out of it asynchronously.

Both hooks are best-effort: a Cortadel outage degrades the agent to "no long-term memory",
never to "no agent". See :class:`CortadelContextProvider` for the details.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, ClassVar, Optional

from agent_framework import ContextProvider, Message
from cortadel import ChatMessage, ConversationOptions, CortadelClient, SearchOptions
from cortadel.client import DEFAULT_APP_NAME as _CORTADEL_DEFAULT_APP_NAME

from ._errors import ErrorCallback, report_failure

if TYPE_CHECKING:  # pragma: no cover - typing only
    from types import TracebackType

    # `Self` is stdlib only from 3.11; importing it under TYPE_CHECKING keeps the 3.10 floor
    # without adding a runtime dependency (`from __future__ import annotations` makes every
    # annotation a string, so nothing is evaluated at import time).
    from agent_framework import AgentSession, SessionContext, SupportsAgentRun
    from typing_extensions import Self

__all__ = ["CortadelContextProvider"]

logger = logging.getLogger(__name__)

#: App name recorded on Cortadel access logs for traffic coming from this integration.
APP_NAME = "cortadel-agent-framework"

#: Roles the Cortadel conversation endpoint accepts. Agent Framework also emits ``"tool"``
#: messages, which carry function-call plumbing rather than anything worth remembering.
_INGESTIBLE_ROLES = frozenset({"user", "assistant", "system"})

#: Key under which already-injected memory ids are remembered inside the provider-scoped
#: ``state`` dict. Must hold a JSON-native value (``list``, not ``set``) because Agent
#: Framework session stores serialize ``AgentSession.state`` — see the ``ContextProvider``
#: docstring on state persistence in ``_sessions.py``.
_STATE_INJECTED_IDS = "injected_memory_ids"

#: Warning text for a failed write. One constant because the same failure is reported from two
#: places — composing the turn and sending it — and both mean the same thing to the operator.
_STORE_FAILED = "Cortadel add_conversation failed; this turn was not stored."


def _role_of(message: Any) -> str:
    """Return a message's role as a plain string.

    ``Message.role`` is typed ``str`` in Agent Framework 1.13.0, but older/newer builds and
    some chat clients hand back an enum-like object. Normalising here keeps the role filter
    honest either way.
    """
    role = getattr(message, "role", None)
    return role.value if hasattr(role, "value") else str(role)


class CortadelContextProvider(ContextProvider):
    """Give an Agent Framework agent long-term memory backed by Cortadel.

    Attach it to any agent through the framework's own extension point::

        from agent_framework import Agent
        from cortadel_agent_framework import CortadelContextProvider

        provider = CortadelContextProvider(base_url="http://localhost:3001", user_id="e2e-alice")
        agent = Agent(client=chat_client, context_providers=[provider])

    **One provider instance per user.** A Cortadel client is bound to a single ``user_id`` at
    construction — no Cortadel method takes a user id per call — so a provider instance *is* a
    per-user object. Never share one across end users; build one per user and cache it.

    **Sessions.** Agent Framework's :class:`~agent_framework.AgentSession` maps onto Cortadel's
    ``session_id``: turns are *written* tagged with the current session, but *recalled* across
    every session by default, which is what makes the memory long-term rather than a transcript
    buffer. Set ``scope_recall_to_session=True`` to restrict retrieval to the live session.

    **Failure behaviour.** Every Cortadel call is best-effort and fails open: transport errors,
    HTTP errors and unexpected exceptions are swallowed so a memory outage cannot take the agent
    down. Pass ``on_error`` to observe them, or ``raise_on_error=True`` to propagate them instead;
    a failure that is neither observed nor propagated is logged as a warning.
    ``asyncio.CancelledError`` is deliberately re-raised — cancellation is the caller's intent,
    not a Cortadel failure.
    """

    #: Prepended to the injected block. Deliberately generic: Cortadel is domain-agnostic.
    DEFAULT_CONTEXT_PROMPT: ClassVar[str] = (
        "## Memories\n"
        "Consider the following memories about this user when answering. They come from earlier "
        "conversations and may be incomplete — prefer what the user says now if they conflict."
    )

    #: Default attribution id. Agent Framework keys ``context_messages``, provider ``state`` and
    #: message attribution off this, so it must be stable across turns.
    DEFAULT_SOURCE_ID: ClassVar[str] = "cortadel"

    def __init__(
        self,
        base_url: Optional[str] = None,
        user_id: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        app_name: str = APP_NAME,
        client: Optional[CortadelClient] = None,
        source_id: str = DEFAULT_SOURCE_ID,
        top_k: int = 5,
        search_mode: str = "hybrid",
        rerank: Optional[str] = None,
        memory_type: Optional[str] = None,
        context_prompt: Optional[str] = None,
        inject_as: str = "message",
        scope_recall_to_session: bool = False,
        deduplicate_across_turns: bool = True,
        max_remembered_ids: int = 256,
        store_turns: bool = True,
        await_persist: bool = True,
        is_agent_memory: bool = False,
        tags: Optional[list[str]] = None,
        project: Optional[str] = None,
        raise_on_error: bool = False,
        on_error: Optional[ErrorCallback] = None,
    ) -> None:
        """Initialise the provider.

        Either pass ``base_url`` and ``user_id`` and let the provider build (and own) a
        :class:`~cortadel.CortadelClient`, or pass a pre-built ``client`` you own yourself.

        Args:
            base_url: Cortadel server URL, e.g. ``https://app.cortadel.ai`` or
                ``http://localhost:3001``. Required unless ``client`` is given.
            user_id: The user whose memories this provider reads and writes. Required unless
                ``client`` is given. Every call is scoped to it.

        Keyword Args:
            api_key: Bearer token. Omit when the server runs with auth disabled.
            app_name: App name Cortadel records for access logging on searches.
            client: A pre-built Cortadel client. When supplied, ``base_url``/``user_id``/
                ``api_key``/``app_name`` are ignored and **you** own its lifecycle — the
                provider will not close it.
            source_id: Attribution id for injected messages and provider state.
            top_k: Maximum memories to retrieve per turn (Cortadel accepts 1–50).
            search_mode: ``hybrid`` (default), ``text`` or ``vector``.
            rerank: Set to ``"cross_encoder"`` to rerank with the server's cross-encoder.
                Cortadel accepts no other value; omit to skip reranking.
            memory_type: Restrict retrieval to one cognitive type — ``episodic``,
                ``semantic`` or ``procedural``.
            context_prompt: Header placed above the injected memories.
            inject_as: ``"message"`` (default) injects a user-role context message, matching
                the shape Microsoft's own Mem0 provider uses; ``"instructions"`` appends to the
                system instructions instead.
            scope_recall_to_session: Restrict recall to the current Agent Framework session
                (the framework's word for it is a *thread* of turns). Off by default —
                cross-session recall is the point of long-term memory.
            deduplicate_across_turns: Skip memories already injected earlier in this session,
                so a long conversation does not re-pay for the same context every turn.
            max_remembered_ids: Cap on remembered ids per session, bounding state growth. ``0``
                remembers nothing, so every hit stays eligible for re-injection each turn.
            store_turns: Persist each completed turn via Cortadel's conversation pipeline.
                Set ``False`` for a read-only agent.
            await_persist: Await the write before ``after_run`` returns. **Defaults to ``True``**
                here, unlike most Cortadel integrations: Agent Framework gives a provider no
                shutdown hook, so a script that returns from ``agent.run()`` and exits would drop
                an in-flight write. Set ``False`` to take the write off the turn's critical path —
                then you must close the provider (``async with`` / :meth:`aclose`) to flush it,
                and a failed write can only be seen through ``on_error``.
            is_agent_memory: Extract facts about the *assistant* rather than the user.
            tags: Tags applied to every fact extracted from stored turns.
            project: Project scope (e.g. a repo name) applied to stored turns.
            raise_on_error: Propagate Cortadel failures to the caller instead of swallowing them.
                Defaults to ``False`` — a memory outage must never take the agent down.
            on_error: Callback invoked with the exception when a Cortadel call fails. Replaces the
                warning log; use it to route failures into your own telemetry. A callback that
                itself raises is logged and swallowed.

        Raises:
            ValueError: If neither ``client`` nor both ``base_url`` and ``user_id`` are given,
                if ``inject_as`` is not ``"message"``/``"instructions"``, or if ``top_k`` /
                ``max_remembered_ids`` are out of range.
        """
        super().__init__(source_id)

        if inject_as not in ("message", "instructions"):
            raise ValueError(f'inject_as must be "message" or "instructions", got: {inject_as!r}')
        if top_k < 1:
            raise ValueError(f"top_k must be at least 1, got: {top_k}")
        if max_remembered_ids < 0:
            raise ValueError(f"max_remembered_ids must not be negative, got: {max_remembered_ids}")

        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            if not base_url or not user_id:
                raise ValueError(
                    "CortadelContextProvider needs either a pre-built `client`, or both "
                    "`base_url` and `user_id`."
                )
            # Let the SDK validate base_url/user_id — it raises ValueError with a good message.
            self._client = CortadelClient(
                base_url,
                user_id,
                api_key=api_key,
                app_name=app_name or _CORTADEL_DEFAULT_APP_NAME,
            )
            self._owns_client = True

        self.top_k = top_k
        self.search_mode = search_mode
        self.rerank = rerank
        self.memory_type = memory_type
        self.context_prompt = context_prompt or self.DEFAULT_CONTEXT_PROMPT
        self.inject_as = inject_as
        self.scope_recall_to_session = scope_recall_to_session
        self.deduplicate_across_turns = deduplicate_across_turns
        self.max_remembered_ids = max_remembered_ids
        self.store_turns = store_turns
        self.await_persist = await_persist
        self.is_agent_memory = is_agent_memory
        self.tags = tags
        self.project = project
        self.raise_on_error = raise_on_error
        self.on_error = on_error

        #: In-flight fire-and-forget writes (``await_persist=False``). Held in a strong reference
        #: because asyncio only keeps a weak one — an untracked task can be garbage-collected
        #: mid-write. Drained by :meth:`aclose`.
        self._pending: set[asyncio.Task[None]] = set()

    # -- Lifecycle -------------------------------------------------------------------------

    @property
    def client(self) -> CortadelClient:
        """The underlying Cortadel client, for direct access to the seven SDK methods."""
        return self._client

    async def __aenter__(self) -> Self:
        """Enter the async context manager."""
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Flush pending writes, then close the Cortadel client if this provider created it."""
        await self.aclose()

    async def aclose(self) -> None:
        """Flush pending writes, then close the Cortadel client if this provider owns it.

        Any fire-and-forget write started under ``await_persist=False`` is awaited first —
        closing the client out from under an in-flight write would lose the turn it carries.

        A caller-supplied ``client`` is never closed here — you own its lifecycle, mirroring
        the Cortadel SDK's own ``aclose()`` contract. Pending writes are still drained, because
        they belong to this provider whoever owns the client.
        """
        await self._drain()
        if self._owns_client:
            await self._client.aclose()

    async def _drain(self) -> None:
        """Await every in-flight background write.

        The set is snapshotted and cleared before awaiting: ``add_done_callback`` fires on the
        next loop iteration, so a "wait until the set empties" loop would spin on tasks that have
        already finished but not yet been discarded.
        """
        while self._pending:
            in_flight = tuple(self._pending)
            self._pending.clear()
            # Failures were already reported inside `_persist`; this only waits for the writes.
            await asyncio.gather(*in_flight, return_exceptions=True)

    # -- ContextProvider hooks -------------------------------------------------------------

    async def before_run(
        self,
        *,
        agent: SupportsAgentRun,
        session: AgentSession,
        context: SessionContext,
        state: dict[str, Any],
    ) -> None:
        """Search Cortadel for memories relevant to this turn and inject them.

        Implements ``ContextProvider.before_run``. Fails open by default: a search failure leaves
        the context untouched and the agent runs without long-term memory for this turn. With
        ``raise_on_error=True`` the failure is propagated to the framework instead.
        """
        # Reading the turn's messages is inside the guard too: the "never takes your agent down"
        # promise has to cover the whole recall path, not just the network call. Stock framework
        # `Message`s always expose `.text`, but a custom message type or a chat client's own
        # subclass need not, and that must not be the thing that kills a run.
        try:
            query = self._query_from(context.input_messages)
            if not query:
                return

            options = SearchOptions(
                top_k=self.top_k,
                mode=self.search_mode,
                rerank=self.rerank,
                memory_type=self.memory_type,
                session_id=session.session_id if self.scope_recall_to_session else None,
            )

            hits = await self._client.search(query, options)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Degrade to "no memory", never take the agent down (unless asked to).
            self._report(exc, "Cortadel search failed; continuing without memories.")
            return

        results = list(hits.results or [])
        if self.deduplicate_across_turns:
            results = self._drop_already_injected(results, state)
        if not results:
            return

        block = "\n".join(f"- {line}" for line in (self._render(hit) for hit in results) if line)
        if not block:
            return

        rendered = f"{self.context_prompt}\n{block}"
        if self.inject_as == "instructions":
            context.extend_instructions(self.source_id, rendered)
        else:
            # Passing `self` (not just the id) makes Agent Framework record `source_type` in the
            # message's `_attribution`, so downstream observers can see which provider spoke.
            context.extend_messages(self, [Message("user", [rendered])])

        if self.deduplicate_across_turns:
            self._remember(results, state)

    async def after_run(
        self,
        *,
        agent: SupportsAgentRun,
        session: AgentSession,
        context: SessionContext,
        state: dict[str, Any],
    ) -> None:
        """Persist the completed turn to Cortadel.

        Implements ``ContextProvider.after_run``. Sends the turn's input plus the agent's
        response to Cortadel's conversation pipeline, which distils durable facts from it off
        the request path. Fails open by default; see ``raise_on_error`` / ``on_error``.
        """
        if not self.store_turns:
            return

        # Composing the turn is inside the guard for the same reason as in `before_run`: a message
        # object that does not expose `.text` must cost you this turn's memory, not the turn.
        try:
            turn: list[Any] = list(context.input_messages)
            response = context.response
            if response is not None and response.messages:
                turn.extend(response.messages)

            # Deliberately only the *new* turn: `input_messages` plus the response.
            # Provider-injected context (this provider's memories, a HistoryProvider's replayed
            # history, a sibling provider's additions) lives in `context.context_messages`, which
            # is not read here — so replayed history is never re-ingested turn after turn.
            messages = self._to_chat_messages(turn)
            if not messages:
                return

            options = ConversationOptions(
                is_agent_memory=self.is_agent_memory,
                tags=self.tags,
                project=self.project,
                session_id=session.session_id,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._report(exc, _STORE_FAILED)
            return

        if self.await_persist:
            await self._persist(messages, options, propagate=True)
            return

        # Fire-and-forget: keep a strong reference so the task cannot be collected mid-write,
        # and drop it again once it lands. `aclose()` awaits whatever is still in the set.
        task = asyncio.create_task(self._persist(messages, options, propagate=False))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    # -- Internals -------------------------------------------------------------------------

    async def _persist(
        self,
        messages: list[ChatMessage],
        options: ConversationOptions,
        *,
        propagate: bool,
    ) -> None:
        """Send one composed turn to Cortadel, reporting a failure rather than escaping.

        ``propagate=False`` on the fire-and-forget path: ``after_run`` has already returned, so
        there is no caller left for ``raise_on_error`` to raise into and the failure would become
        an unretrieved task exception. It is reported through ``on_error`` (or logged) instead.
        """
        try:
            await self._client.add_conversation(messages, options)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._report(exc, _STORE_FAILED, propagate=propagate)

    def _report(self, exc: Exception, message: str, *, propagate: bool = True) -> None:
        """Route a Cortadel failure to ``on_error``/the log, and re-raise if asked to."""
        report_failure(
            exc,
            message,
            logger=logger,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
            propagate=propagate,
        )

    @staticmethod
    def _query_from(messages: Sequence[Any]) -> str:
        """Build the retrieval query from the turn's input messages."""
        parts = [m.text.strip() for m in messages if m is not None and m.text and m.text.strip()]
        return "\n".join(parts)

    def _to_chat_messages(self, messages: Sequence[Any]) -> list[ChatMessage]:
        """Map Agent Framework messages onto Cortadel ``ChatMessage``s.

        Drops tool/function plumbing and anything with no text, and skips this provider's own
        injected context block so retrieved memories are never written back as if the user had
        said them — a feedback loop that would amplify a memory a little more on every turn.

        In the stock 1.13.0 pipeline ``input_messages`` never contains our injection, so that last
        filter is belt-and-braces; it earns its keep for callers that hand ``after_run`` a
        pre-composed turn (as the direct-hook tests do) and against future pipeline changes.
        """
        out: list[ChatMessage] = []
        for message in messages:
            if message is None or self._is_own_injection(message):
                continue
            role = _role_of(message)
            if role not in _INGESTIBLE_ROLES:
                continue
            text = message.text
            if not text or not text.strip():
                continue
            out.append(
                ChatMessage(
                    role=role,
                    content=text,
                    uuid=getattr(message, "message_id", None),
                )
            )
        return out

    def _is_own_injection(self, message: Any) -> bool:
        """True when this message is a context block this provider itself injected."""
        properties = getattr(message, "additional_properties", None) or {}
        attribution = properties.get("_attribution")
        if not isinstance(attribution, dict):
            return False
        return attribution.get("source_id") == self.source_id

    @staticmethod
    def _render(hit: Any) -> str:
        """Render one search hit as a single memory line, preferring the server's gist."""
        text = (getattr(hit, "gist", None) or getattr(hit, "content", None) or "").strip()
        return text.replace("\n", " ") if text else ""

    @staticmethod
    def _injected_ids(state: dict[str, Any]) -> list[str]:
        """Read the remembered-id list out of provider state, tolerating a corrupt value."""
        stored = state.get(_STATE_INJECTED_IDS)
        if not isinstance(stored, list):
            return []
        return [value for value in stored if isinstance(value, str)]

    def _drop_already_injected(self, hits: list[Any], state: dict[str, Any]) -> list[Any]:
        """Filter out hits injected earlier in this session."""
        seen = set(self._injected_ids(state))
        if not seen:
            return hits
        return [hit for hit in hits if getattr(hit, "id", None) not in seen]

    def _remember(self, hits: Sequence[Any], state: dict[str, Any]) -> None:
        """Record the injected ids in provider state, newest last, bounded in size.

        Stored as a ``list[str]`` rather than a ``set`` on purpose: Agent Framework persists
        ``AgentSession.state`` through session stores that accept only JSON-native values.
        """
        remembered = self._injected_ids(state)
        known = set(remembered)
        for hit in hits:
            hit_id = getattr(hit, "id", None)
            if isinstance(hit_id, str) and hit_id not in known:
                remembered.append(hit_id)
                known.add(hit_id)
        if self.max_remembered_ids == 0:
            # A cap of zero means remember nothing. Special-cased because `remembered[-0:]` is
            # `remembered[0:]` — the whole list — which would silently make 0 mean "unbounded",
            # the exact opposite of the cap the caller asked for.
            remembered = []
        elif len(remembered) > self.max_remembered_ids:
            remembered = remembered[-self.max_remembered_ids :]
        state[_STATE_INJECTED_IDS] = remembered
