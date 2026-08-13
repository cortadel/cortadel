"""``CortadelStore`` — Cortadel behind LangGraph's ``BaseStore`` interface.

``BaseStore`` (``langgraph/store/base/__init__.py``, shipped by ``langgraph-checkpoint``) is
LangGraph's one long-term-memory extension point: it is what ``StateGraph.compile(store=...)``,
``@entrypoint(store=...)`` and ``create_react_agent(store=...)`` accept, what
``langgraph.config.get_store()`` hands to a node, and what ``langgraph.prebuilt.InjectedStore``
injects into a tool. Implementing it is what makes Cortadel *native* here rather than bolted on.

Only two methods are abstract — ``batch`` and ``abatch``; every convenience method
(``get``/``search``/``put``/``delete``/``list_namespaces`` and the ``a*`` variants) is implemented
on the base class in terms of them. So this module implements the two, and inherits the rest.

Mapping the two models
----------------------

======================================  ==========================================================
LangGraph op                            Cortadel call
======================================  ==========================================================
``PutOp(ns, key, value)``               ``add(text, AddOptions(...))``
``PutOp(ns, key, None)`` (i.e. delete)  ``delete([id])``
``GetOp(ns, key)``                      ``get(id)``
``SearchOp(ns, query="…")``             ``search(query, SearchOptions(...))`` — BM25+vector hybrid
``SearchOp(ns, query=None)``            ``list(ListOptions(...))``
``ListNamespacesOp(...)``               *no Cortadel equivalent* — served from a process-local
                                        registry of namespaces this instance has touched
======================================  ==========================================================

Three seams deserve attention, and all three are documented in the README:

1. **Namespace -> user id.** A Cortadel client is bound to one user id at construction, so
   per-user scoping means *one client per user*. ``user_id`` therefore accepts a callable that
   derives the user id from the namespace (see :func:`~cortadel_langgraph.namespace_user_id`), and
   this store keeps a small cache of clients keyed by the resolved id.
2. **Keys.** Cortadel mints its own memory ids; it has no upsert-by-caller-key. So the store's key
   space *is* Cortadel memory ids — that is what ``search()`` returns as ``SearchItem.key``, and
   what ``get()``/``delete()`` expect. A caller-chosen key passed to ``put()`` is bridged to the
   minted id through a **process-local** alias table so ``put(); get()`` round-trips within one
   run; it does not survive a restart.
3. **Degradation.** A memory backend must never take the agent down. Every Cortadel call is
   wrapped: ``CortadelError`` (which the SDK also raises for transport failures, with
   ``code="transport_error"``) is turned into an empty result and either handed to the
   ``on_error`` callback or, when there isn't one, logged as a warning. Set
   ``raise_on_error=True`` to opt out and have failures propagate.
"""
from __future__ import annotations

import json
import logging
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    CortadelClient,
    CortadelError,
    HealthResult,
    ListOptions,
    MemoryDetail,
    MemoryListItem,
    SearchHit,
    SearchOptions,
    SyncCortadelClient,
)
from langgraph.store.base import (
    BaseStore,
    GetOp,
    Item,
    ListNamespacesOp,
    MatchCondition,
    Op,
    PutOp,
    Result,
    SearchItem,
    SearchOp,
)

from ._namespace import UserIdResolver

__all__ = ["DEFAULT_APP_NAME", "DEFAULT_TEXT_KEYS", "CortadelStore", "ErrorCallback"]

logger = logging.getLogger(__name__)

ErrorCallback = Callable[[BaseException], None]
"""Signature of the ``on_error`` observer: it is handed the exception and returns nothing."""

DEFAULT_APP_NAME = "cortadel-langgraph"
"""Recorded on writes (``AddOptions.app``) and on searches (the client's ``app_name``)."""

DEFAULT_TEXT_KEYS: tuple[str, ...] = ("content", "text", "memory", "data")
"""``Item.value`` keys checked, in order, for the string to store as the memory's text."""

# Server-side ceilings from the Cortadel REST contract, mirrored here so we clamp with a warning
# instead of letting the server 400.
_MAX_SEARCH_TOP_K = 50
_MAX_LIST_SIZE = 100

# Cortadel returns timestamps in two shapes (ISO strings on search hits, Unix seconds on list/
# detail rows). When one is missing or unparseable we still owe LangGraph a datetime; this sentinel
# is deterministic (unlike "now"), which keeps tests and diffs stable.
_UNKNOWN_TIME = datetime(1970, 1, 1, tzinfo=timezone.utc)

# Keys this store ever writes into ``Item.value``. A ``SearchOp.filter`` naming anything else
# cannot be evaluated, so it is warned about once and ignored rather than silently excluding rows.
_FILTERABLE_KEYS = frozenset(
    {
        "id",
        "content",
        "text",
        "memory",
        "data",
        "categories",
        "tags",
        "memory_type",
        "app_name",
        "source",
        "gist",
        "project_id",
        "state",
        "is_global",
        "is_current",
    }
)

# Filter keys the Cortadel search endpoint can enforce itself, so they are lifted out of the
# post-filter and pushed into SearchOptions.
_SERVER_FILTER_KEYS = ("memory_type", "session_id")


class CortadelStore(BaseStore):
    """A LangGraph :class:`~langgraph.store.base.BaseStore` backed by a Cortadel server.

    Args:
        base_url: Cortadel server, e.g. ``"http://localhost:3001"`` (self-hosted) or
            ``"https://app.cortadel.ai"`` (hosted).
        user_id: Either a fixed Cortadel user id, or a callable mapping a LangGraph namespace to
            one. Use :func:`~cortadel_langgraph.namespace_user_id` for the common
            ``("memories", "<user>")`` layout.
        api_key: Bearer token. Omit when the server has auth disabled (the self-hosted default).
        app_name: Recorded for access logging, and used as ``AddOptions.app`` on writes.
        search_mode: Cortadel search mode — ``"hybrid"`` (default), ``"text"`` or ``"vector"``.
        rerank: Set to ``"cross_encoder"`` to rerank with the server's cross-encoder. Any other
            value is silently ignored by the server.
        infer: Default for Cortadel's background entity/category extraction on writes. ``False``
            stores text verbatim (dedup still applies).
        text_keys: ``Item.value`` keys checked, in order, for the text to store. If none match,
            the whole value is stored as sorted JSON.
        value_key: Key the memory text is exposed under on read.
        raise_on_error: ``False`` (the default) fails open — a Cortadel failure becomes an empty
            result and the agent keeps running. ``True`` propagates the exception instead.
        on_error: Optional callback invoked with the exception whenever a failure is swallowed
            (``raise_on_error=False``). Supplying one replaces the default warning log, so it is
            also how you route memory failures into your own telemetry — or silence them.
        timeout: Per-client HTTP timeout in seconds.
        max_alias_entries: Cap on the process-local caller-key -> memory-id alias table.
        logger: Logger to use. Defaults to this module's ``cortadel_langgraph.store`` logger.
    """

    # BaseStore declares __slots__ = ("__weakref__",); this subclass deliberately does not, so it
    # gets a normal __dict__ for the caches below.

    supports_ttl = False
    """Cortadel is bi-temporal — memories are superseded, never expired on a timer — so TTL is not
    supported. ``BaseStore.put`` raises ``NotImplementedError`` for a non-``None`` ``ttl``."""

    def __init__(
        self,
        base_url: str,
        user_id: UserIdResolver,
        *,
        api_key: Optional[str] = None,
        app_name: str = DEFAULT_APP_NAME,
        search_mode: str = "hybrid",
        rerank: Optional[str] = None,
        infer: bool = True,
        text_keys: Sequence[str] = DEFAULT_TEXT_KEYS,
        value_key: str = "content",
        raise_on_error: bool = False,
        on_error: Optional[ErrorCallback] = None,
        timeout: float = 100.0,
        max_alias_entries: int = 10_000,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        if on_error is not None and not callable(on_error):
            # Guards the pre-1.0 spelling, where on_error was the mode string "warn"/"ignore"/
            # "raise". Failing loudly here beats a callback that is silently never called.
            raise TypeError(
                "on_error must be a callable taking the exception, not "
                f"{on_error!r}. To make failures fatal use raise_on_error=True; to silence the "
                "default warning pass on_error=lambda exc: None."
            )
        if not text_keys:
            raise ValueError("text_keys must name at least one key.")

        self._base_url = base_url
        self._user_id = user_id
        self._api_key = api_key
        self._app_name = app_name
        self._search_mode = search_mode
        self._rerank = rerank
        self._infer = infer
        self._text_keys = tuple(text_keys)
        self._value_key = value_key
        self._raise_on_error = raise_on_error
        self._on_error = on_error
        self._timeout = timeout
        self._max_alias_entries = max_alias_entries
        self._log = logger if logger is not None else globals()["logger"]

        self._lock = threading.Lock()
        self._sync_clients: dict[str, SyncCortadelClient] = {}
        self._async_clients: dict[str, CortadelClient] = {}
        # Caller-chosen key -> Cortadel-minted memory id. Process-local; see the module docstring.
        self._aliases: "OrderedDict[tuple[tuple[str, ...], str], str]" = OrderedDict()
        self._namespaces: set[tuple[str, ...]] = set()
        self._warned_filter_keys: set[str] = set()
        self._warned_overfetch = False
        self._closed = False

    # ── BaseStore: the only two abstract methods ────────────────────────────────────────────

    def batch(self, ops: Iterable[Op]) -> list[Result]:
        """Execute operations synchronously, in order, against Cortadel's blocking client.

        Operations run sequentially rather than concurrently: a batch may legitimately contain a
        write and a read of the same key, and Cortadel offers no batch endpoint that would
        preserve that ordering for us.
        """
        return [self._execute_sync(op) for op in ops]

    async def abatch(self, ops: Iterable[Op]) -> list[Result]:
        """Execute operations asynchronously, in order, against Cortadel's async client."""
        return [await self._execute_async(op) for op in ops]

    # ── Cortadel-specific extensions (beyond BaseStore) ─────────────────────────────────────

    def add_conversation(
        self,
        namespace: tuple[str, ...],
        messages: Iterable[ChatMessage],
        *,
        session_id: Optional[str] = None,
        project: Optional[str] = None,
        tags: Optional[list[str]] = None,
        is_agent_memory: bool = False,
    ) -> Optional[ConversationResult]:
        """Ingest a conversation so Cortadel distils durable facts from it.

        This has no ``BaseStore`` equivalent — ``put`` stores a fact you already wrote, whereas
        this hands Cortadel raw turns and lets its extraction pipeline decide what is worth
        remembering. It is what :class:`~cortadel_langgraph.memory.CortadelMemory` calls after a
        turn completes.

        Returns:
            The server's result, or ``None`` when the call failed and ``raise_on_error`` is
            ``False``.
        """
        turns = list(messages)
        if not turns:
            return None
        client = self._sync_client(namespace)
        if client is None:
            return None
        options = ConversationOptions(
            is_agent_memory=is_agent_memory,
            tags=tags,
            project=project,
            session_id=session_id,
        )
        try:
            return client.add_conversation(turns, options)
        except CortadelError as exc:
            self._handle_error("add_conversation", exc)
            return None

    async def aadd_conversation(
        self,
        namespace: tuple[str, ...],
        messages: Iterable[ChatMessage],
        *,
        session_id: Optional[str] = None,
        project: Optional[str] = None,
        tags: Optional[list[str]] = None,
        is_agent_memory: bool = False,
    ) -> Optional[ConversationResult]:
        """Async twin of :meth:`add_conversation`."""
        turns = list(messages)
        if not turns:
            return None
        client = self._async_client(namespace)
        if client is None:
            return None
        options = ConversationOptions(
            is_agent_memory=is_agent_memory,
            tags=tags,
            project=project,
            session_id=session_id,
        )
        try:
            return await client.add_conversation(turns, options)
        except CortadelError as exc:
            self._handle_error("add_conversation", exc)
            return None

    def health(self, namespace: tuple[str, ...] = ()) -> Optional[HealthResult]:
        """Check the Cortadel server.

        Note that Cortadel's ``health`` does not raise for a *degraded* server — inspect
        ``result.status`` yourself. ``None`` means the call itself failed.
        """
        client = self._sync_client(namespace)
        if client is None:
            return None
        try:
            return client.health()
        except CortadelError as exc:
            self._handle_error("health", exc)
            return None

    async def ahealth(self, namespace: tuple[str, ...] = ()) -> Optional[HealthResult]:
        """Async twin of :meth:`health`."""
        client = self._async_client(namespace)
        if client is None:
            return None
        try:
            return await client.health()
        except CortadelError as exc:
            self._handle_error("health", exc)
            return None

    # ── Lifecycle ───────────────────────────────────────────────────────────────────────────

    def close(self) -> None:
        """Close every blocking client this store created. Idempotent.

        Each distinct user id gets its own :class:`cortadel.SyncCortadelClient`, and each of those
        owns a background thread — so closing matters for long-lived multi-tenant processes.
        """
        with self._lock:
            clients = list(self._sync_clients.values())
            self._sync_clients.clear()
            self._closed = True
        for client in clients:
            client.close()

    async def aclose(self) -> None:
        """Close every async client this store created. Idempotent."""
        with self._lock:
            clients = list(self._async_clients.values())
            self._async_clients.clear()
        for client in clients:
            await client.aclose()

    def __enter__(self) -> "CortadelStore":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    async def __aenter__(self) -> "CortadelStore":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()
        self.close()

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        target = self._user_id if isinstance(self._user_id, str) else "<callable>"
        return f"CortadelStore(base_url={self._base_url!r}, user_id={target!r})"

    # ── Op dispatch ─────────────────────────────────────────────────────────────────────────

    def _execute_sync(self, op: Op) -> Result:
        if isinstance(op, GetOp):
            return self._get(op, self._sync_client(op.namespace))
        if isinstance(op, SearchOp):
            return self._search(op, self._sync_client(op.namespace_prefix))
        if isinstance(op, PutOp):
            return self._put(op, self._sync_client(op.namespace))
        if isinstance(op, ListNamespacesOp):
            return self._list_namespaces(op)
        raise ValueError(f"Unknown operation type: {type(op)}")

    async def _execute_async(self, op: Op) -> Result:
        if isinstance(op, GetOp):
            return await self._aget(op)
        if isinstance(op, SearchOp):
            return await self._asearch(op)
        if isinstance(op, PutOp):
            return await self._aput(op)
        if isinstance(op, ListNamespacesOp):
            return self._list_namespaces(op)
        raise ValueError(f"Unknown operation type: {type(op)}")

    # ── GetOp ───────────────────────────────────────────────────────────────────────────────

    def _get(self, op: GetOp, client: Any) -> Optional[Item]:
        self._register_namespace(op.namespace)
        if client is None:
            return None
        memory_id = self._resolve_key(op.namespace, op.key)
        try:
            detail = client.get(memory_id)
        except CortadelError as exc:
            self._handle_error("get", exc)
            return None
        return self._detail_to_item(op.namespace, op.key, detail)

    async def _aget(self, op: GetOp) -> Optional[Item]:
        self._register_namespace(op.namespace)
        client = self._async_client(op.namespace)
        if client is None:
            return None
        memory_id = self._resolve_key(op.namespace, op.key)
        try:
            detail = await client.get(memory_id)
        except CortadelError as exc:
            self._handle_error("get", exc)
            return None
        return self._detail_to_item(op.namespace, op.key, detail)

    # ── SearchOp ────────────────────────────────────────────────────────────────────────────

    def _search(self, op: SearchOp, client: Any) -> list[SearchItem]:
        self._register_namespace(op.namespace_prefix)
        if client is None:
            return []
        server_filter, post_filter = self._split_filter(op.filter)
        try:
            if op.query:
                results = client.search(op.query, self._search_options(op, server_filter))
                rows: list[Any] = list(results.results or [])
            else:
                page = client.list(self._list_options(op, server_filter))
                rows = list(page.items or [])
        except CortadelError as exc:
            self._handle_error("search", exc)
            return []
        items = [self._row_to_search_item(op.namespace_prefix, row) for row in rows]
        items = self._apply_filter(items, post_filter)
        return items[op.offset : op.offset + op.limit]

    async def _asearch(self, op: SearchOp) -> list[SearchItem]:
        self._register_namespace(op.namespace_prefix)
        client = self._async_client(op.namespace_prefix)
        if client is None:
            return []
        server_filter, post_filter = self._split_filter(op.filter)
        try:
            if op.query:
                results = await client.search(op.query, self._search_options(op, server_filter))
                rows: list[Any] = list(results.results or [])
            else:
                page = await client.list(self._list_options(op, server_filter))
                rows = list(page.items or [])
        except CortadelError as exc:
            self._handle_error("search", exc)
            return []
        items = [self._row_to_search_item(op.namespace_prefix, row) for row in rows]
        items = self._apply_filter(items, post_filter)
        return items[op.offset : op.offset + op.limit]

    def _search_options(self, op: SearchOp, server_filter: Mapping[str, Any]) -> SearchOptions:
        wanted = max(1, op.limit + op.offset)
        top_k = min(_MAX_SEARCH_TOP_K, wanted)
        if wanted > _MAX_SEARCH_TOP_K:
            self._warn_overfetch("search", wanted, _MAX_SEARCH_TOP_K)
        return SearchOptions(
            top_k=top_k,
            mode=self._search_mode,
            session_id=server_filter.get("session_id"),
            rerank=self._rerank,
            memory_type=server_filter.get("memory_type"),
        )

    def _list_options(self, op: SearchOp, server_filter: Mapping[str, Any]) -> ListOptions:
        wanted = max(1, op.limit + op.offset)
        size = min(_MAX_LIST_SIZE, wanted)
        if wanted > _MAX_LIST_SIZE:
            self._warn_overfetch("list", wanted, _MAX_LIST_SIZE)
        return ListOptions(
            page=1,
            size=size,
            memory_type=server_filter.get("memory_type"),
        )

    def _split_filter(
        self, raw: Optional[Mapping[str, Any]]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Split a ``SearchOp.filter`` into what the server can enforce and what we post-filter."""
        if not raw:
            return {}, {}
        server: dict[str, Any] = {}
        post: dict[str, Any] = {}
        for key, value in raw.items():
            if key in _SERVER_FILTER_KEYS and isinstance(value, str):
                server[key] = value
                # memory_type is also present on SearchHit, so leaving it out of the post-filter
                # is safe; session_id is not exposed on a hit at all and could not be checked here.
                continue
            if key not in _FILTERABLE_KEYS:
                self._warn_unknown_filter_key(key)
                continue
            post[key] = value
        return server, post

    def _apply_filter(
        self, items: list[SearchItem], post_filter: Mapping[str, Any]
    ) -> list[SearchItem]:
        if not post_filter:
            return items
        return [
            item
            for item in items
            if all(_matches(item.value.get(key), expected) for key, expected in post_filter.items())
        ]

    # ── PutOp ───────────────────────────────────────────────────────────────────────────────

    def _put(self, op: PutOp, client: Any) -> None:
        self._register_namespace(op.namespace)
        if client is None:
            return None
        if op.value is None:
            memory_id = self._resolve_key(op.namespace, op.key)
            try:
                client.delete([memory_id])
            except CortadelError as exc:
                self._handle_error("delete", exc)
            self._forget_alias(op.namespace, op.key)
            return None
        text, options = self._value_to_add(op)
        try:
            created = client.add(text, options)
        except CortadelError as exc:
            self._handle_error("put", exc)
            return None
        if created is not None and created.id:
            self._remember_alias(op.namespace, op.key, created.id)
        return None

    async def _aput(self, op: PutOp) -> None:
        self._register_namespace(op.namespace)
        client = self._async_client(op.namespace)
        if client is None:
            return None
        if op.value is None:
            memory_id = self._resolve_key(op.namespace, op.key)
            try:
                await client.delete([memory_id])
            except CortadelError as exc:
                self._handle_error("delete", exc)
            self._forget_alias(op.namespace, op.key)
            return None
        text, options = self._value_to_add(op)
        try:
            created = await client.add(text, options)
        except CortadelError as exc:
            self._handle_error("put", exc)
            return None
        if created is not None and created.id:
            self._remember_alias(op.namespace, op.key, created.id)
        return None

    def _value_to_add(self, op: PutOp) -> tuple[str, AddOptions]:
        value = dict(op.value or {})
        text: Optional[str] = None
        for key in self._text_keys:
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                text = candidate
                value.pop(key, None)
                break
        if text is None:
            # No recognised text key: keep the caller's data intact as deterministic JSON rather
            # than silently dropping it. Cortadel will happily store it, but its extraction
            # pipeline works far better on prose — hence the README's "use {'content': ...}".
            text = json.dumps(op.value, sort_keys=True, default=str)
            value = {}
        metadata: dict[str, Any] = {
            "langgraph_namespace": "/".join(op.namespace),
            "langgraph_key": op.key,
        }
        metadata.update(value)
        return text, AddOptions(
            app=self._app_name,
            metadata=metadata,
            # LangGraph's index=False means "do not make this semantically searchable". Cortadel
            # always embeds for hybrid search, so the closest honest analogue is infer=False:
            # store verbatim, skip background entity/category extraction. A list of field paths
            # (index=["a", "b"]) has no Cortadel equivalent and is ignored.
            infer=False if op.index is False else self._infer,
        )

    # ── ListNamespacesOp ────────────────────────────────────────────────────────────────────

    def _list_namespaces(self, op: ListNamespacesOp) -> list[tuple[str, ...]]:
        """Serve namespaces from a process-local registry.

        Cortadel stores memories per user, not per namespace path — there is no endpoint that
        enumerates namespaces. Rather than always returning ``[]``, this returns the namespaces
        *this store instance* has read from or written to, with the same prefix/suffix/wildcard/
        ``max_depth`` semantics as ``InMemoryStore._handle_list_namespaces``. It is therefore
        accurate but not durable, and empty in a freshly-started process.
        """
        namespaces = list(self._namespaces)
        if op.match_conditions:
            namespaces = [
                ns
                for ns in namespaces
                if all(_does_match(condition, ns) for condition in op.match_conditions)
            ]
        if op.max_depth is not None:
            namespaces = sorted({ns[: op.max_depth] for ns in namespaces})
        else:
            namespaces = sorted(namespaces)
        return namespaces[op.offset : op.offset + op.limit]

    # ── Row -> Item mapping ─────────────────────────────────────────────────────────────────

    def _detail_to_item(
        self,
        namespace: tuple[str, ...],
        requested_key: str,
        detail: Optional[MemoryDetail],
    ) -> Optional[Item]:
        if detail is None:
            return None
        created = _from_epoch(detail.created_at)
        value: dict[str, Any] = {self._value_key: detail.text, "id": detail.id}
        _put_if(value, "categories", list(detail.categories) if detail.categories else None)
        _put_if(value, "state", detail.state)
        _put_if(value, "app_name", detail.app_name)
        _put_if(value, "is_current", detail.is_current)
        if detail.is_global:
            value["is_global"] = True
        return Item(
            value=value,
            # The key the caller asked for, per the BaseStore contract. The Cortadel-minted id is
            # always available as value["id"].
            key=requested_key,
            namespace=namespace,
            created_at=created,
            updated_at=_parse_iso(detail.valid_at) or created,
        )

    def _row_to_search_item(self, namespace: tuple[str, ...], row: Any) -> SearchItem:
        if isinstance(row, SearchHit):
            created = _parse_iso(row.created_at) or _UNKNOWN_TIME
            value: dict[str, Any] = {self._value_key: row.content, "id": row.id}
            _put_if(value, "categories", row.categories)
            _put_if(value, "tags", row.tags)
            _put_if(value, "memory_type", row.memory_type)
            _put_if(value, "app_name", row.app_name)
            _put_if(value, "source", row.source)
            _put_if(value, "gist", row.gist)
            _put_if(value, "project_id", row.project_id)
            if row.is_global:
                value["is_global"] = True
            return SearchItem(
                namespace=namespace,
                key=row.id,
                value=value,
                created_at=created,
                updated_at=created,
                score=row.rrf_score,
            )
        # Otherwise a MemoryListItem, from the query-less (list) path.
        item: MemoryListItem = row
        created = _from_epoch(item.created_at)
        value = {self._value_key: item.content, "id": item.id}
        _put_if(value, "categories", list(item.categories) if item.categories else None)
        _put_if(value, "memory_type", item.memory_type)
        _put_if(value, "app_name", item.app_name)
        _put_if(value, "state", item.state)
        _put_if(value, "is_current", item.is_current)
        if item.is_global:
            value["is_global"] = True
        return SearchItem(
            namespace=namespace,
            key=item.id,
            value=value,
            created_at=created,
            updated_at=_parse_iso(item.valid_at) or created,
            # A plain list is unranked, so there is no score to report. Reporting a fabricated
            # one would be worse than None.
            score=None,
        )

    # ── Clients ─────────────────────────────────────────────────────────────────────────────

    def _resolve_user_id(self, namespace: tuple[str, ...]) -> Optional[str]:
        resolver = self._user_id
        if isinstance(resolver, str):
            return resolver
        try:
            user_id = resolver(tuple(namespace))
        except Exception as exc:  # a user-supplied callable — never let it kill the graph
            self._handle_error(f"resolving a user id for namespace {namespace}", exc)
            return None
        if not user_id:
            self._handle_error(
                f"resolving a user id for namespace {namespace}",
                ValueError(f"No Cortadel user id could be derived from namespace {namespace}."),
            )
            return None
        return user_id

    def _sync_client(self, namespace: tuple[str, ...]) -> Optional[SyncCortadelClient]:
        user_id = self._resolve_user_id(namespace)
        if user_id is None:
            return None
        with self._lock:
            if self._closed:
                raise RuntimeError("CortadelStore is closed.")
            client = self._sync_clients.get(user_id)
            if client is None:
                client = SyncCortadelClient(
                    self._base_url,
                    user_id,
                    api_key=self._api_key,
                    app_name=self._app_name,
                    timeout=self._timeout,
                )
                self._sync_clients[user_id] = client
            return client

    def _async_client(self, namespace: tuple[str, ...]) -> Optional[CortadelClient]:
        user_id = self._resolve_user_id(namespace)
        if user_id is None:
            return None
        with self._lock:
            client = self._async_clients.get(user_id)
            if client is None:
                client = CortadelClient(
                    self._base_url,
                    user_id,
                    api_key=self._api_key,
                    app_name=self._app_name,
                    timeout=self._timeout,
                )
                self._async_clients[user_id] = client
            return client

    # ── Aliases, namespaces, diagnostics ────────────────────────────────────────────────────

    def _resolve_key(self, namespace: tuple[str, ...], key: str) -> str:
        """Translate a caller-chosen key to the Cortadel memory id, if we minted one for it."""
        return self._aliases.get((tuple(namespace), key), key)

    def _remember_alias(self, namespace: tuple[str, ...], key: str, memory_id: str) -> None:
        if key == memory_id:
            return
        with self._lock:
            self._aliases[(tuple(namespace), key)] = memory_id
            self._aliases.move_to_end((tuple(namespace), key))
            while len(self._aliases) > self._max_alias_entries:
                self._aliases.popitem(last=False)

    def _forget_alias(self, namespace: tuple[str, ...], key: str) -> None:
        with self._lock:
            self._aliases.pop((tuple(namespace), key), None)

    def _register_namespace(self, namespace: Sequence[str]) -> None:
        if namespace:
            self._namespaces.add(tuple(namespace))

    def _handle_error(self, action: str, exc: BaseException) -> None:
        """Fail open (the default) or propagate, per ``raise_on_error``.

        Fail-open hands the exception to the ``on_error`` callback when there is one, and
        otherwise logs a warning — those are the two halves of the old ``"warn"``/``"ignore"``
        modes, collapsed into one knob.
        """
        if self._raise_on_error:
            raise exc
        if self._on_error is not None:
            try:
                self._on_error(exc)
            except Exception:  # an observer must not be able to take the agent down either
                self._log.warning(
                    "Cortadel on_error callback raised while observing a %s failure; ignoring it.",
                    action,
                    exc_info=True,
                )
            return
        if isinstance(exc, CortadelError):
            self._log_error(
                "%s failed (status=%s code=%s): %s", action, exc.status, exc.code, exc.message
            )
        else:
            self._log_error("%s failed: %s", action, exc)

    def _log_error(self, message: str, *args: Any) -> None:
        self._log.warning("Cortadel memory unavailable — " + message, *args)

    def _warn_unknown_filter_key(self, key: str) -> None:
        if key in self._warned_filter_keys:
            return
        self._warned_filter_keys.add(key)
        self._log.warning(
            "CortadelStore cannot evaluate the search filter key %r (Cortadel exposes %s on a "
            "hit); it is being ignored, so results are NOT filtered by it.",
            key,
            ", ".join(sorted(_FILTERABLE_KEYS)),
        )

    def _warn_overfetch(self, endpoint: str, wanted: int, ceiling: int) -> None:
        if self._warned_overfetch:
            return
        self._warned_overfetch = True
        self._log.warning(
            "CortadelStore needed %d rows from %s to honour limit+offset, but Cortadel caps that "
            "at %d; results are truncated.",
            wanted,
            endpoint,
            ceiling,
        )


# ── Module-level helpers ─────────────────────────────────────────────────────────────────────


def _put_if(target: dict[str, Any], key: str, value: Any) -> None:
    """Add ``key`` only when it carries information — keeps ``Item.value`` free of null noise."""
    if value is None or value == [] or value == "":
        return
    target[key] = value


def _from_epoch(seconds: Optional[int]) -> datetime:
    """Cortadel's list/detail rows carry Unix seconds (search hits carry ISO strings instead)."""
    if seconds is None:
        return _UNKNOWN_TIME
    try:
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (OverflowError, OSError, ValueError, TypeError):
        return _UNKNOWN_TIME


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO 8601 timestamp, tolerating a trailing ``Z`` and >6 fractional digits.

    Python 3.10's ``datetime.fromisoformat`` accepts neither, and Cortadel's .NET server emits
    both, so a naive call would throw away every timestamp on 3.10.
    """
    if not value:
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    if "." in text:
        head, _, tail = text.partition(".")
        digits = ""
        rest = ""
        for index, char in enumerate(tail):
            if char.isdigit():
                digits += char
            else:
                rest = tail[index:]
                break
        if digits:
            text = f"{head}.{digits[:6]}{rest}"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _matches(actual: Any, expected: Any) -> bool:
    """Compare one ``Item.value`` field against a ``SearchOp.filter`` value.

    Scalar-against-list means membership (``{"categories": "work"}`` matches a memory tagged
    ``["work", "travel"]``). MongoDB-style operator dicts (``{"$gt": 3}``) are not supported.
    """
    if isinstance(expected, dict):
        return False
    if isinstance(actual, (list, tuple)) and not isinstance(expected, (list, tuple)):
        return expected in actual
    if isinstance(expected, (list, tuple)) and isinstance(actual, (list, tuple)):
        return list(actual) == list(expected)
    return actual == expected


def _does_match(condition: MatchCondition, namespace: tuple[str, ...]) -> bool:
    """Prefix/suffix namespace matching with ``*`` wildcards.

    Same semantics as ``langgraph.store.memory.InMemoryStore``'s ``_does_match``, so
    ``list_namespaces`` behaves identically whichever store a graph is compiled with.
    """
    path = condition.path
    if len(namespace) < len(path):
        return False
    if condition.match_type == "prefix":
        pairs: Iterable[tuple[str, str]] = zip(namespace, path)
    elif condition.match_type == "suffix":
        pairs = zip(reversed(namespace), reversed(path))
    else:
        raise ValueError(f"Unsupported match type: {condition.match_type}")
    return all(expected == "*" or actual == expected for actual, expected in pairs)
