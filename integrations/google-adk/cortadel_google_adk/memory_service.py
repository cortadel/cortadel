# Copyright 2026 Cortadel
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Cortadel as a Google ADK :class:`~google.adk.memory.BaseMemoryService`."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Mapping
from collections.abc import Sequence
import logging
import os
from typing import Any
from typing import Callable
from typing import Optional
from typing import TYPE_CHECKING

from cortadel import AddOptions
from cortadel import ConversationOptions
from cortadel import CortadelClient
from cortadel import CortadelError
from cortadel import MemoryCreated
from cortadel import SearchOptions
from google.adk.memory.base_memory_service import BaseMemoryService
from google.adk.memory.base_memory_service import SearchMemoryResponse
from google.adk.memory.memory_entry import MemoryEntry
from typing_extensions import override

from ._clients import ClientPool
from ._clients import DEFAULT_MAX_CLIENTS
from ._convert import event_fingerprint
from ._convert import events_to_messages
from ._convert import hits_to_memory_entries
from ._convert import memory_entry_text

if TYPE_CHECKING:  # pragma: no cover - import cycle avoidance only
    from google.adk.events.event import Event
    from google.adk.sessions.session import Session

logger = logging.getLogger(__name__)

DEFAULT_APP_NAME = "cortadel-google-adk"
"""Recorded by Cortadel for access logging on searches."""

DEFAULT_BASE_URL = "http://localhost:3001"
"""Where a self-hosted `docker compose up` puts the server."""

BASE_URL_ENV = "CORTADEL_BASE_URL"
API_KEY_ENV = "CORTADEL_API_KEY"

DEFAULT_DEDUPE_SESSIONS = 256

DEFAULT_TOP_K = 5
"""Hits per search.

Deliberately below the Cortadel SDK's own ``SearchOptions`` default of 10: the
dominant caller here is *automatic* injection (ADK's ``preload_memory`` runs
before every model call, as does the plugin's ``inject=True``), where every hit
is prompt budget spent on every turn.
"""

UserIdResolver = Callable[[str, str], str]
"""``(adk_app_name, adk_user_id) -> cortadel_user_id``."""

ErrorObserver = Callable[[BaseException], None]
"""Called with the exception behind a failed Cortadel call. See ``on_error``."""

_SESSIONLESS = "__no_session__"


class CortadelMemoryService(BaseMemoryService):
    """Long-term memory for ADK agents, backed by a Cortadel server.

    This is the idiomatic seam: ADK routes *all* memory through
    ``BaseMemoryService``, so a single instance handed to
    ``Runner(memory_service=...)`` (or ``InMemoryRunner``'s replacement) serves
    the built-in ``load_memory`` and ``preload_memory`` tools, every
    ``Context.search_memory`` / ``Context.add_session_to_memory`` call, and the
    whole sub-agent tree — with no per-agent wiring.

    Three things it does that ``InMemoryMemoryService`` does not:

    * **Real retrieval.** Cortadel fuses BM25 and vector arms with RRF instead
      of matching bare keywords, and the results survive a process restart.
    * **Delta ingestion.** ``add_session_to_memory`` is documented as callable
      many times per session; this implementation remembers which events it has
      already shipped and sends only what is new, so a ten-turn conversation
      costs ten small extractions rather than fifty-five re-extracted ones.
    * **Direct writes.** ``add_memory`` maps onto Cortadel's ``add``, so an
      agent can commit a distilled fact without replaying a transcript.

    Failure policy: with ``raise_on_error=False`` (the default) an unreachable
    or erroring server degrades the agent to no-memory — searches return no
    memories and writes are dropped — rather than raising into the run. Set
    ``raise_on_error=True`` to surface :class:`CortadelError` instead, and
    ``on_error`` to observe failures either way.

    Args:
      base_url: Cortadel server URL. Defaults to ``$CORTADEL_BASE_URL``, then
        ``http://localhost:3001``.
      user_id: Pins **every** memory to this Cortadel user, ignoring the ADK
        session's user. Use for single-user or shared-knowledge-base agents.
        Leave ``None`` (default) to scope memory to the ADK session's user.
      api_key: Bearer token. Defaults to ``$CORTADEL_API_KEY``. Omit when the
        server runs with auth disabled.
      app_name: App name Cortadel records for access logging on searches. Note
        this is *Cortadel's* app name, unrelated to ADK's ``app_name``.
      top_k: Maximum hits per search (Cortadel accepts 1–50). Defaults to 5;
        see :data:`DEFAULT_TOP_K`.
      search_mode: ``hybrid`` (default), ``text`` or ``vector``.
      rerank: Set to ``"cross_encoder"`` to rerank with Cortadel's local
        cross-encoder. ``None`` skips reranking.
      memory_type: Restrict searches to one cognitive type — ``episodic``,
        ``semantic`` or ``procedural``.
      scope_recall_to_session: When ``True``, recall only returns memories
        written from the same ADK session id. Off by default: cross-session
        recall is the point of long-term memory.
      is_agent_memory: When ``True``, conversation ingestion extracts facts
        about the *assistant* rather than about the user.
      project: Cortadel project scope stamped on ingested conversations.
      tags: Tags stamped on every fact extracted from ingested conversations.
      raise_on_error: Propagate Cortadel failures to the caller. Off by
        default — a memory outage degrades the agent to no-memory instead of
        taking the run down.
      on_error: Called with the exception behind **every** failed Cortadel
        call, whether it is then swallowed or re-raised. When it is ``None``
        and the failure is swallowed, a warning is logged instead.
      timeout: Per-client HTTP timeout in seconds.
      user_id_resolver: Maps ``(adk_app_name, adk_user_id)`` to the Cortadel
        user id. Overrides ``user_id`` when both are given. Use it to namespace
        per ADK app, e.g. ``lambda app, user: f"{app}:{user}"``.
      client_factory: Builds a Cortadel client from a resolved user id.
        Overrides ``base_url``/``api_key``/``app_name``/``timeout`` entirely.
        Primarily a test seam.
      max_clients: Cap on pooled per-user clients (LRU; evicted ones close).
      dedupe_sessions: How many session ids to track for delta ingestion.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        user_id: Optional[str] = None,
        api_key: Optional[str] = None,
        app_name: str = DEFAULT_APP_NAME,
        top_k: int = DEFAULT_TOP_K,
        search_mode: str = "hybrid",
        rerank: Optional[str] = None,
        memory_type: Optional[str] = None,
        scope_recall_to_session: bool = False,
        is_agent_memory: bool = False,
        project: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        raise_on_error: bool = False,
        on_error: Optional[ErrorObserver] = None,
        timeout: float = 100.0,
        user_id_resolver: Optional[UserIdResolver] = None,
        client_factory: Optional[Callable[[str], Any]] = None,
        max_clients: int = DEFAULT_MAX_CLIENTS,
        dedupe_sessions: int = DEFAULT_DEDUPE_SESSIONS,
    ) -> None:
        resolved_base_url = base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL
        resolved_api_key = api_key if api_key is not None else os.environ.get(API_KEY_ENV)

        self._base_url = resolved_base_url
        self._pinned_user_id = user_id
        self._cortadel_app_name = app_name
        self._top_k = top_k
        self._search_mode = search_mode
        self._rerank = rerank
        self._memory_type = memory_type
        self._scope_recall_to_session = scope_recall_to_session
        self._is_agent_memory = is_agent_memory
        self._project = project
        self._tags = list(tags) if tags else None
        self._raise_on_error = raise_on_error
        self._on_error = on_error
        self._user_id_resolver = user_id_resolver

        factory = client_factory or self._default_client_factory(
            resolved_base_url, resolved_api_key, app_name, timeout
        )
        self._pool = ClientPool(factory, max_clients=max_clients)

        if dedupe_sessions < 1:
            raise ValueError("dedupe_sessions must be at least 1.")
        self._dedupe_sessions = dedupe_sessions
        # (cortadel_user_id, session_id) -> fingerprints already ingested.
        self._ingested: "OrderedDict[tuple[str, str], set[str]]" = OrderedDict()
        self._ingest_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _default_client_factory(
        base_url: str,
        api_key: Optional[str],
        app_name: str,
        timeout: float,
    ) -> Callable[[str], CortadelClient]:
        def factory(resolved_user_id: str) -> CortadelClient:
            return CortadelClient(
                base_url,
                resolved_user_id,
                api_key=api_key,
                app_name=app_name,
                timeout=timeout,
            )

        return factory

    def resolve_user_id(self, app_name: str, user_id: str) -> str:
        """Maps ADK's ``(app_name, user_id)`` onto one Cortadel user id.

        A Cortadel client is bound to a single user at construction, so this is
        the one place where ADK's per-call scoping becomes a namespace.
        """
        if self._user_id_resolver is not None:
            return self._user_id_resolver(app_name, user_id)
        if self._pinned_user_id is not None:
            return self._pinned_user_id
        return user_id

    async def client_for(self, app_name: str, user_id: str) -> Any:
        """Returns the pooled Cortadel client serving this ADK scope."""
        return await self._pool.get(self.resolve_user_id(app_name, user_id))

    # ------------------------------------------------------------------
    # BaseMemoryService
    # ------------------------------------------------------------------

    @override
    async def add_session_to_memory(self, session: "Session") -> None:
        """Ingests everything in ``session`` that has not been ingested yet.

        ADK explicitly permits repeat calls for one session, so this sends only
        the delta.
        """
        await self._ingest(
            app_name=session.app_name,
            user_id=session.user_id,
            session_id=session.id,
            events=session.events,
            custom_metadata=None,
        )

    @override
    async def add_events_to_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        events: Sequence["Event"],
        session_id: Optional[str] = None,
        custom_metadata: Optional[Mapping[str, object]] = None,
    ) -> None:
        """Ingests one turn's worth of events.

        Recognised ``custom_metadata`` keys: ``tags`` (list of str), ``project``
        (str), ``is_agent_memory`` (bool), ``transcript_path`` (str). Anything
        else is ignored.
        """
        await self._ingest(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            events=events,
            custom_metadata=custom_metadata,
        )

    @override
    async def add_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        memories: Sequence[MemoryEntry],
        custom_metadata: Optional[Mapping[str, object]] = None,
    ) -> None:
        """Writes distilled facts straight into Cortadel, no transcript needed.

        Recognised ``custom_metadata`` keys: ``memory_type``
        (``episodic``/``semantic``/``procedural``), ``infer`` (bool — ``False``
        stores verbatim and skips entity extraction; dedup still applies),
        ``app`` (str, the app credited with creating the memory, defaults to
        ADK's ``app_name``) and ``metadata`` (dict stored alongside).
        """
        meta = dict(custom_metadata or {})
        for entry in memories:
            text = memory_entry_text(entry)
            if not text:
                continue
            await self.add_fact(
                app_name=app_name,
                user_id=user_id,
                text=text,
                app=_as_str(meta.get("app")),
                metadata=_as_dict(meta.get("metadata")),
                infer=_as_opt_bool(meta.get("infer")),
                memory_type=_as_str(meta.get("memory_type")),
            )

    async def add_fact(
        self,
        *,
        app_name: str,
        user_id: str,
        text: str,
        app: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        infer: Optional[bool] = None,
        memory_type: Optional[str] = None,
    ) -> Optional[MemoryCreated]:
        """Writes one distilled fact and reports what the pipeline did with it.

        ``BaseMemoryService.add_memory`` returns ``None``, which hides whether a
        write landed, was deduped, or failed. This is the same write with the
        answer attached — used by the ``add_memories`` tool so the model can see
        ``SKIP_DUPLICATE`` and stop repeating itself.

        Returns:
          The created memory, or ``None`` when the write failed and
          ``raise_on_error`` is off.
        """
        fact = (text or "").strip()
        if not fact:
            return None

        options = AddOptions(
            app=app or app_name,
            metadata=metadata,
            # Must stay None (not False) when unset: Cortadel reads None as
            # "use the default", and False would silently disable extraction.
            infer=infer,
            memory_type=memory_type or self._memory_type,
        )
        # The client is acquired *inside* the guard so that a failing client
        # factory (a bad base_url, a closed pool) is subject to the same failure
        # policy as the call itself, rather than escaping it.
        async def run() -> MemoryCreated:
            client = await self.client_for(app_name, user_id)
            return await client.add(fact, options)

        return await self._guard("add", run, default=None)

    @override
    async def search_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        query: str,
    ) -> SearchMemoryResponse:
        """Retrieves the memories most relevant to ``query`` for this user."""
        return await self._search(app_name=app_name, user_id=user_id, query=query)

    # ------------------------------------------------------------------
    # Session-scoped search
    # ------------------------------------------------------------------

    async def search_memory_in_session(
        self,
        *,
        app_name: str,
        user_id: str,
        query: str,
        session_id: str,
    ) -> SearchMemoryResponse:
        """Like :meth:`search_memory`, restricted to one ADK session id.

        ``BaseMemoryService.search_memory`` has no session parameter, so this
        sits alongside it for callers that hold a session (tools do — see
        :func:`cortadel_google_adk.tools.cortadel_memory_tools`).
        """
        return await self._search(
            app_name=app_name,
            user_id=user_id,
            query=query,
            session_id=session_id,
        )

    async def _search(
        self,
        *,
        app_name: str,
        user_id: str,
        query: str,
        session_id: Optional[str] = None,
    ) -> SearchMemoryResponse:
        if not query or not query.strip():
            return SearchMemoryResponse()

        options = SearchOptions(
            top_k=self._top_k,
            mode=self._search_mode,
            rerank=self._rerank,
            memory_type=self._memory_type,
            session_id=session_id,
        )
        async def run() -> Any:
            client = await self.client_for(app_name, user_id)
            return await client.search(query, options)

        results = await self._guard("search", run, default=None)
        if results is None:
            return SearchMemoryResponse()
        return SearchMemoryResponse(memories=hits_to_memory_entries(results.results))

    @property
    def scope_recall_to_session(self) -> bool:
        """Whether recall issued by this package's tools pins to a session."""
        return self._scope_recall_to_session

    # ------------------------------------------------------------------
    # Ingestion
    # ------------------------------------------------------------------

    async def _ingest(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: Optional[str],
        events: Sequence["Event"],
        custom_metadata: Optional[Mapping[str, object]],
    ) -> None:
        if not events:
            return

        cortadel_user_id = self.resolve_user_id(app_name, user_id)
        key = (cortadel_user_id, session_id or _SESSIONLESS)

        fresh = await self._claim_new_events(key, events)
        if not fresh:
            return

        messages = events_to_messages(fresh)
        if not messages:
            return

        meta = dict(custom_metadata or {})
        tags = _as_str_list(meta.get("tags")) or self._tags
        options = ConversationOptions(
            is_agent_memory=_as_bool(meta.get("is_agent_memory"), self._is_agent_memory),
            tags=tags,
            project=_as_str(meta.get("project")) or self._project,
            session_id=session_id,
            transcript_path=_as_str(meta.get("transcript_path")),
        )

        async def run() -> Any:
            client = await self._pool.get(cortadel_user_id)
            return await client.add_conversation(messages, options)

        try:
            result = await self._guard("add_conversation", run, default=_FAILED)
        except BaseException:
            # raise_on_error=True re-raises, and cancellation always propagates.
            # Either way the write never landed, so the claim must not stick.
            await self._release_events(key, fresh)
            raise
        if result is _FAILED:
            # Swallowed (raise_on_error=False). Forget the claim so the next
            # call (or the next turn's re-ingest) tries these events again.
            await self._release_events(key, fresh)

    async def _claim_new_events(
        self,
        key: tuple[str, str],
        events: Sequence["Event"],
    ) -> list["Event"]:
        """Returns the events not yet ingested for ``key``, marking them taken.

        Claiming under the lock (rather than marking after the write) keeps two
        concurrent invocations on the same session from shipping the same turn
        twice.
        """
        async with self._ingest_lock:
            seen = self._ingested.get(key)
            if seen is None:
                seen = set()
                self._ingested[key] = seen
            self._ingested.move_to_end(key)
            while len(self._ingested) > self._dedupe_sessions:
                self._ingested.popitem(last=False)

            fresh: list["Event"] = []
            for event in events:
                fingerprint = event_fingerprint(event)
                if fingerprint in seen:
                    continue
                seen.add(fingerprint)
                fresh.append(event)
            return fresh

    async def _release_events(
        self,
        key: tuple[str, str],
        events: Sequence["Event"],
    ) -> None:
        async with self._ingest_lock:
            seen = self._ingested.get(key)
            if seen is None:
                return
            for event in events:
                seen.discard(event_fingerprint(event))

    # ------------------------------------------------------------------
    # Error policy and lifecycle
    # ------------------------------------------------------------------

    async def _guard(self, operation: str, call: Callable[[], Any], *, default: Any) -> Any:
        """Runs a Cortadel call under this service's failure policy."""
        try:
            return await call()
        except asyncio.CancelledError:
            # Cancellation is control flow, never a Cortadel failure — the SDK
            # deliberately lets CancelledError through untouched, and so do we.
            # It is not reported to on_error either.
            raise
        except Exception as exc:
            self._report_failure(operation, exc)
            if self._raise_on_error:
                raise
            return default

    def _report_failure(self, operation: str, exc: Exception) -> None:
        """Surfaces a failed Cortadel call.

        ``on_error`` observes *every* failure, swallowed or re-raised. With no
        observer, a swallowed failure would otherwise vanish silently, so it is
        logged; a re-raised one needs no log because the caller gets the
        exception itself.
        """
        if self._on_error is not None:
            try:
                self._on_error(exc)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning(
                    "Cortadel on_error callback raised; ignoring it.", exc_info=True
                )
            return

        if self._raise_on_error:
            return
        if isinstance(exc, CortadelError):
            logger.warning(
                "Cortadel %s failed (status=%s code=%s): %s — continuing without memory.",
                operation,
                exc.status,
                exc.code,
                exc.message,
            )
        else:
            logger.warning(
                "Cortadel %s failed unexpectedly — continuing without memory.",
                operation,
                exc_info=exc,
            )

    async def aclose(self) -> None:
        """Closes every pooled Cortadel client. Safe to call more than once."""
        await self._pool.aclose()

    async def __aenter__(self) -> "CortadelMemoryService":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()


class _Failed:
    """Sentinel distinguishing "the call failed" from "the call returned None"."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<cortadel-call-failed>"


_FAILED = _Failed()


def _as_str(value: object) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _as_bool(value: object, default: bool = False) -> bool:
    return value if isinstance(value, bool) else default


def _as_opt_bool(value: object) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _as_dict(value: object) -> Optional[dict[str, Any]]:
    return dict(value) if isinstance(value, Mapping) else None


def _as_str_list(value: object) -> Optional[list[str]]:
    if isinstance(value, str) or not isinstance(value, (list, tuple, set)):
        return None
    items = [item for item in value if isinstance(item, str) and item]
    return items or None
