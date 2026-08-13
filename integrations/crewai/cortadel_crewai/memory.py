"""``CortadelMemory`` — CrewAI's unified ``Memory``, backed by Cortadel.

CrewAI 1.x replaced the old short-term/long-term/entity/external split with a
single ``crewai.Memory`` class. Every consumer in the framework talks to it
through two **text-level** calls:

* ``memory.recall(query: str, limit=N)`` — ``Agent`` before a task
  (``crewai/agent/core.py``), ``LiteAgent``, ``Flow``, and the built-in
  ``RecallMemoryTool``.
* ``memory.remember(content: str, ...)`` / ``remember_many([...])`` — the
  built-in ``RememberTool`` and anything that saves.

That is the seam this class implements. Overriding the text API (rather than
the ``StorageBackend`` protocol underneath it) is what lets Cortadel do the
work it is actually good at: server-side hybrid BM25 + vector retrieval with
its own embeddings, dedup, entity extraction, and bi-temporal versioning.

The layer below — ``StorageBackend.search(query_embedding: list[float], ...)``
— is embedding-only and could not be served faithfully, because Cortadel's API
takes a text query and embeds it itself. See ``_inert.py``.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime
from typing import Any, Callable, Deque, Iterable, Literal, Optional

from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ListOptions,
    MemoryCreated,
    SearchHit,
    SearchOptions,
)
from crewai.memory.types import MemoryMatch, MemoryRecord
from crewai.memory.unified_memory import Memory
from pydantic import Field, PrivateAttr

from cortadel_crewai._compat import (
    DEFAULT_APP_NAME,
    build_client,
    clamp_top_k,
    env_base_url,
    guard,
    hit_reasons,
    parse_timestamp,
)
from cortadel_crewai._inert import InertStorage


class CortadelMemory(Memory):
    """A drop-in ``crewai.Memory`` whose recall and remember hit a Cortadel server.

    Pass it wherever CrewAI accepts a memory instance::

        crew = Crew(agents=[...], tasks=[...], memory=CortadelMemory(user_id="alice"))

    A Cortadel client is bound to **one user id at construction**, so one
    ``CortadelMemory`` serves exactly one user. Build a fresh instance per user
    rather than trying to pass a user id per call — there is no such parameter.
    """

    # `storage` must not be a str, or Memory.model_post_init builds a LanceDB
    # store. An InertStorage keeps the whole local vector path out of the way.
    storage: Any = Field(default_factory=InertStorage, exclude=True)

    base_url: str = Field(
        default_factory=env_base_url,
        description="Cortadel server base URL. Defaults to $CORTADEL_BASE_URL or http://localhost:3001.",
    )
    user_id: Optional[str] = Field(
        default=None,
        description="User id owning the memories. Defaults to $CORTADEL_USER_ID. Required.",
    )
    # exclude/repr=False: this is a bearer token. Without them it shows up in
    # `repr(memory)` and in `model_dump()` — and Crew.copy() dumps every agent,
    # so an agent-level memory would put the token into an intermediate dict.
    api_key: Optional[str] = Field(
        default=None,
        exclude=True,
        repr=False,
        description="Bearer token. Defaults to $CORTADEL_API_KEY. Omit when auth is disabled.",
    )
    app_name: str = Field(
        default=DEFAULT_APP_NAME,
        description="App name recorded for access logging on searches.",
    )
    client: Any = Field(
        default=None,
        exclude=True,
        description="A pre-built cortadel.SyncCortadelClient. Built from the fields above when None.",
    )

    search_mode: str = Field(
        default="hybrid", description="Cortadel search mode: hybrid, text, or vector."
    )
    rerank: Optional[str] = Field(
        default=None,
        description="Set to 'cross_encoder' to rerank with Cortadel's local cross-encoder.",
    )
    memory_type: Optional[str] = Field(
        default=None,
        description="Pin a cognitive type on writes and filter reads: episodic | semantic | procedural.",
    )
    infer: bool = Field(
        default=True,
        description="When False, store text verbatim and skip Cortadel's entity/category extraction.",
    )
    raise_on_error: bool = Field(
        default=False,
        description="When True, Cortadel errors propagate instead of degrading to empty results.",
    )
    # exclude/repr=False: a callable is not JSON-serialisable, and Crew.copy()
    # runs every agent through model_dump() — a plain field would break that.
    on_error: Optional[Callable[[BaseException], None]] = Field(
        default=None,
        exclude=True,
        repr=False,
        description=(
            "Called with the exception on every Cortadel failure, whether or not "
            "raise_on_error re-raises it. Setting it replaces the default warning log."
        ),
    )
    dedupe_window: int = Field(
        default=0,
        description=(
            "When > 0, suppress the last N memory *ids* already returned by "
            "recall. This is a window of ids, not of recalls: with "
            "dedupe_window=50 and 10 hits per recall it spans the last five "
            "recalls. Agents re-recall on every turn, so this stops the same "
            "facts being re-injected into the prompt repeatedly. 0 disables it."
        ),
    )

    _recent_ids: Deque[str] = PrivateAttr(default_factory=deque)
    _owns_client: bool = PrivateAttr(default=False)

    def model_post_init(self, __context: Any) -> None:
        """Wire up the Cortadel client after pydantic validation."""
        super().model_post_init(__context)
        if self.dedupe_window > 0:
            # Size the ring to the window so "the last N ids" is exactly N.
            self._recent_ids = deque(maxlen=self.dedupe_window)
        if self.client is None:
            self.client = build_client(
                base_url=self.base_url,
                user_id=self.user_id,
                api_key=self.api_key,
                app_name=self.app_name,
            )
            self._owns_client = True

    # ------------------------------------------------------------------
    # Write path
    # ------------------------------------------------------------------

    def remember(
        self,
        content: str,
        scope: Optional[str] = None,
        categories: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
        importance: Optional[float] = None,
        source: Optional[str] = None,
        private: bool = False,
        agent_role: Optional[str] = None,
        root_scope: Optional[str] = None,
    ) -> Optional[MemoryRecord]:
        """Store one item in Cortadel via ``add``.

        Cortadel runs its own intent classification and dedup, so the returned
        record may describe a ``SKIP_DUPLICATE`` rather than a fresh write —
        check ``record.metadata["cortadel_event"]``.

        Returns ``None`` only when this memory is ``read_only`` (matching
        ``crewai.Memory``). If the *server* call fails and ``raise_on_error`` is
        False, this returns an unpersisted placeholder record instead —
        ``record.id == ""`` and ``record.metadata["cortadel_persisted"] is
        False`` — because CrewAI's own ``Save to memory`` tool reads
        ``record.scope`` / ``record.importance`` off this return value without a
        None check (``crewai/tools/memory_tools.py``), and a ``None`` there
        would turn a degraded write into an ``AttributeError`` inside the agent
        loop. The failure is still reported by the guard (a warning, or your
        ``on_error`` callback); use ``raise_on_error=True`` to raise instead.
        """
        if self.read_only:
            return None

        options = AddOptions(
            app=self.app_name,
            metadata=self._write_metadata(
                scope=scope,
                categories=categories,
                metadata=metadata,
                importance=importance,
                source=source,
                private=private,
                agent_role=agent_role,
                root_scope=root_scope,
            ),
            infer=self.infer,
            memory_type=self.memory_type,
        )
        created = guard(
            "add",
            lambda: self.client.add(content, options),
            None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )
        if created is None:
            return self._unpersisted_record(
                content, scope=self._effective_scope(scope, root_scope)
            )
        return self._record_from_created(
            created,
            fallback_text=content,
            scope=self._effective_scope(scope, root_scope),
            categories=categories or [],
            importance=importance,
            source=source,
            private=private,
        )

    def remember_many(
        self,
        contents: list[str],
        scope: Optional[str] = None,
        categories: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
        importance: Optional[float] = None,
        source: Optional[str] = None,
        private: bool = False,
        agent_role: Optional[str] = None,
        root_scope: Optional[str] = None,
    ) -> list[MemoryRecord]:
        """Store several items. Each failure is isolated — one bad write is skipped.

        Unlike :meth:`remember`, this returns only the records Cortadel actually
        stored: the parent's contract is "the created records", and no CrewAI
        caller dereferences them (``base_agent_executor`` discards the list), so
        there is nothing to protect from a ``None``. A fully degraded batch
        therefore returns ``[]``.
        """
        if self.read_only:
            return []
        records: list[MemoryRecord] = []
        for content in contents:
            record = self.remember(
                content,
                scope=scope,
                categories=categories,
                metadata=metadata,
                importance=importance,
                source=source,
                private=private,
                agent_role=agent_role,
                root_scope=root_scope,
            )
            if record is not None and record.metadata.get("cortadel_persisted") is not False:
                records.append(record)
        return records

    def remember_conversation(
        self,
        messages: Iterable[ChatMessage],
        *,
        session_id: Optional[str] = None,
        project: Optional[str] = None,
        tags: Optional[list[str]] = None,
        is_agent_memory: bool = False,
    ) -> list[MemoryRecord]:
        """Persist a full turn via Cortadel's ``add_conversation``.

        Unlike :meth:`remember`, which stores text as given, this hands the
        whole exchange to Cortadel's extraction pipeline, which distils the
        durable facts out of it. This is what
        :class:`~cortadel_crewai.CortadelConversationListener` calls after a task.

        Set ``is_agent_memory=True`` to extract facts about the *assistant*
        rather than about the user.
        """
        if self.read_only:
            return []
        payload = list(messages)
        if not payload:
            return []

        options = ConversationOptions(
            is_agent_memory=is_agent_memory,
            tags=tags,
            project=project,
            session_id=session_id,
        )
        result = guard(
            "add_conversation",
            lambda: self.client.add_conversation(payload, options),
            None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )
        # `results` and `no_facts_extracted` are mutually exclusive on the wire.
        if result is None or not result.results:
            return []

        records: list[MemoryRecord] = []
        for item in result.results:
            if not item.id or not item.memory:
                continue  # ERROR / INVALIDATE events carry no id
            records.append(
                MemoryRecord(
                    id=item.id,
                    content=item.memory,
                    scope=self.root_scope or "/",
                    metadata={"cortadel_event": item.event} if item.event else {},
                    importance=self.default_importance,
                )
            )
        return records

    # ------------------------------------------------------------------
    # Read path
    # ------------------------------------------------------------------

    def recall(
        self,
        query: str,
        scope: Optional[str] = None,
        categories: Optional[list[str]] = None,
        limit: int = 10,
        depth: Literal["shallow", "deep"] = "deep",
        source: Optional[str] = None,
        include_private: bool = False,
    ) -> list[MemoryMatch]:
        """Retrieve relevant memories from Cortadel via hybrid search.

        ``depth`` is accepted for signature compatibility but ignored: CrewAI's
        ``deep`` mode drives a local LLM RecallFlow over a vector store, whereas
        Cortadel already fuses BM25 and vector arms with RRF server-side (and
        will cross-encode when ``rerank='cross_encoder'``). Running CrewAI's
        flow on top would just pay for a second, weaker retrieval brain.

        ``scope``/``categories`` are likewise not retrieval filters here — see
        the README's "What does not map" section.
        """
        if not query or not query.strip():
            return []

        options = SearchOptions(
            top_k=clamp_top_k(limit),
            mode=self.search_mode,
            rerank=self.rerank,
            memory_type=self.memory_type,
        )
        results = guard(
            "search",
            lambda: self.client.search(query, options),
            None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )
        if results is None or not results.results:
            return []

        matches: list[MemoryMatch] = []
        for hit in results.results:
            if self.dedupe_window > 0 and hit.id in self._recent_ids:
                continue
            matches.append(self._match_from_hit(hit))

        if self.dedupe_window > 0:
            self._remember_returned([m.record.id for m in matches])
        return matches

    def list_records(
        self,
        scope: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
    ) -> list[MemoryRecord]:
        """List stored memories (newest first) via Cortadel's ``list``.

        ``offset`` is **approximate**. Cortadel's ``list`` is paginated by
        ``page``/``size`` with no row offset, so the offset is floored to a page
        boundary: ``list_records(limit=50, offset=25)`` returns records 0–49,
        not 25–74. Pass an offset that is a multiple of ``limit`` to get exactly
        what you asked for.
        """
        size = max(1, min(limit, 100))  # Cortadel caps page size at 100
        page = (max(offset, 0) // size) + 1
        listing = guard(
            "list",
            lambda: self.client.list(ListOptions(page=page, size=size, memory_type=self.memory_type)),
            None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )
        if listing is None or not listing.items:
            return []
        return [
            MemoryRecord(
                id=item.id,
                content=item.content,
                scope=self.root_scope or "/",
                categories=list(item.categories or []),
                created_at=parse_timestamp(item.created_at),
                importance=self.default_importance,
                metadata={
                    "cortadel_state": item.state,
                    "cortadel_memory_type": item.memory_type,
                },
            )
            for item in listing.items
        ]

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------

    def forget(
        self,
        scope: Optional[str] = None,
        categories: Optional[list[str]] = None,
        older_than: Optional[datetime] = None,
        metadata_filter: Optional[dict[str, Any]] = None,
        record_ids: Optional[list[str]] = None,
    ) -> int:
        """Delete memories **by id**.

        Cortadel's ``delete`` takes explicit ids only. The criteria-based
        filters (``scope``, ``categories``, ``older_than``, ``metadata_filter``)
        have no server-side equivalent, so a call without ``record_ids`` deletes
        nothing and returns 0 rather than silently deleting the wrong thing.

        The return value is ``len(record_ids)`` on success, **not** a count of
        rows the server actually removed: ``SyncCortadelClient.delete`` returns a
        confirmation string, not a count, so deleting two ids of which one never
        existed still reports 2. On a swallowed failure it returns 0.
        """
        if not record_ids:
            return 0
        ids = list(record_ids)
        outcome = guard(
            "delete",
            lambda: self.client.delete(ids),
            None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )
        return len(ids) if outcome is not None else 0

    def update(
        self,
        record_id: str,
        content: Optional[str] = None,
        scope: Optional[str] = None,
        categories: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
        importance: Optional[float] = None,
    ) -> Optional[MemoryRecord]:
        """Not supported: Cortadel has no update endpoint.

        Cortadel is bi-temporal — a correction is stored with :meth:`remember`
        and the server supersedes the older version itself. Editing in place
        would destroy that history, so this is a no-op returning ``None``.

        The parameter list mirrors ``crewai.Memory.update`` exactly (so
        ``memory.update("id", "new text")`` does not ``TypeError``), but the
        return type widens ``MemoryRecord`` to ``Optional[MemoryRecord]``: there
        is no record to hand back. Nothing inside CrewAI calls ``update()``.
        """
        return None

    def reset(self, scope: Optional[str] = None) -> None:
        """Not supported: Cortadel has no bulk-reset endpoint.

        Deleting requires explicit ids — use :meth:`list_records` then
        :meth:`forget`. Silently wiping a user's memories is not something this
        integration will do implicitly.
        """
        return None

    def reset_all(self) -> None:
        """Not supported — see :meth:`reset`."""
        return None

    def close(self) -> None:
        """Close the Cortadel client (only if this instance created it).

        Teardown never re-raises, whatever ``raise_on_error`` says: a failure to
        close is not worth taking down a crew that has already finished. The
        ``on_error`` callback still sees it.
        """
        if self._owns_client and self.client is not None:
            close = getattr(self.client, "close", None)
            if close is not None:
                guard("close", close, None, raise_on_error=False, on_error=self.on_error)
        super().close()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _effective_scope(
        self, scope: Optional[str], root_scope: Optional[str]
    ) -> str:
        root = root_scope if root_scope is not None else self.root_scope
        if root and scope:
            return f"{root.rstrip('/')}/{scope.lstrip('/')}"
        return scope or root or "/"

    def _write_metadata(self, **fields: Any) -> dict[str, Any]:
        """Carry CrewAI's bookkeeping into ``AddOptions.metadata``.

        Sent for provenance and for non-Python readers. Note it does **not**
        round-trip back through this SDK: ``MemoryListItem.metadata`` and
        ``MemoryDetail.metadata`` are always ``None`` from the Python client.
        """
        extra = fields.pop("metadata", None) or {}
        payload: dict[str, Any] = {
            f"crewai_{key}": value
            for key, value in fields.items()
            if value is not None and value is not False and value != []
        }
        payload.update(extra)
        payload["crewai_integration"] = DEFAULT_APP_NAME
        return payload

    def _record_from_created(
        self,
        created: MemoryCreated,
        *,
        fallback_text: str,
        scope: str,
        categories: list[str],
        importance: Optional[float],
        source: Optional[str],
        private: bool,
    ) -> MemoryRecord:
        return MemoryRecord(
            id=created.id,
            content=created.content or fallback_text,
            scope=scope,
            categories=list(categories),
            created_at=parse_timestamp(created.created_at),
            importance=self.default_importance if importance is None else importance,
            source=source,
            private=private,
            metadata={
                "cortadel_event": created.event,
                "cortadel_state": created.state,
            },
        )

    def _unpersisted_record(self, content: str, *, scope: str) -> MemoryRecord:
        """A placeholder for a write the server never accepted.

        Carries an empty ``id`` (there is no server-side memory to address) and
        ``cortadel_persisted=False``. It exists so callers that immediately read
        attributes off ``remember()``'s return — CrewAI's built-in ``Save to
        memory`` tool does exactly that — degrade to a harmless no-op instead of
        raising ``AttributeError`` on ``None``.
        """
        return MemoryRecord(
            id="",
            content=content,
            scope=scope,
            importance=self.default_importance,
            metadata={
                "cortadel_event": "DEGRADED",
                "cortadel_persisted": False,
            },
        )

    def _match_from_hit(self, hit: SearchHit) -> MemoryMatch:
        record = MemoryRecord(
            id=hit.id,
            content=hit.content,
            # Cortadel is a flat per-user namespace; there is no per-record
            # scope to recover, so every hit reports this memory's own root.
            scope=self.root_scope or "/",
            categories=list(hit.categories or []),
            created_at=parse_timestamp(hit.created_at),
            importance=self.default_importance,
            source=hit.app_name,
            metadata={
                "cortadel_rrf_score": hit.rrf_score,
                "cortadel_memory_type": hit.memory_type,
                "cortadel_tags": list(hit.tags or []),
                "cortadel_gist": hit.gist,
                "cortadel_is_global": hit.is_global,
            },
        )
        return MemoryMatch(
            record=record,
            score=hit.rrf_score if hit.rrf_score is not None else 0.0,
            match_reasons=hit_reasons(hit),
        )

    def _remember_returned(self, ids: list[str]) -> None:
        """Remember the last ``dedupe_window`` *ids* handed to a caller.

        The ring is sized to the window in ``model_post_init``; the trim below
        only matters if ``dedupe_window`` is lowered after construction.
        """
        window = self.dedupe_window
        if window <= 0:
            return
        for memory_id in ids:
            self._recent_ids.append(memory_id)
        while len(self._recent_ids) > window:
            self._recent_ids.popleft()
