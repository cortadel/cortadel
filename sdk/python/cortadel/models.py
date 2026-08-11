"""Facade DTOs and options for the Cortadel Python SDK.

Mirrors ``sdk/dotnet/Cortadel.Sdk/Models.cs`` / ``sdk/typescript/src/models.ts`` property-for-
property, in Python naming (snake_case fields, since that is what the wire already uses — no
camelCase conversion layer is needed here the way the .NET/TypeScript facades need one). The
mapping layer (``cortadel.mapping``) does the generated-model -> DTO conversion; every field here
is derived from ``spec/openapi.json``.

Deliberately generated-free: nothing in this module imports from ``cortadel._generated``. That is
what makes it safe to re-export wholesale from ``cortadel/__init__.py`` — its declared attributes
can never reference a generated type. Functions that DO need the generated model shapes live in
``cortadel.mapping`` instead.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

DEFAULT_LIST_SIZE = 20
"""Deliberate divergence from the REST contract's own ``size`` default of 10
(``spec/openapi.json``), kept in sync with the .NET (``ListOptions.Size = 20``) and TypeScript
(``DEFAULT_LIST_SIZE = 20``) facades so every Cortadel SDK agrees."""


# ── Client configuration ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ChatMessage:
    """A single conversation turn passed to :meth:`CortadelClient.add_conversation`."""

    role: str
    """``"user"``, ``"assistant"``, or ``"system"``."""

    content: str
    """Message text."""

    uuid: Optional[str] = None
    """Optional producer-side turn id (kept as a pointer anchor on extracted facts)."""


# ── Requests & options ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class AddOptions:
    """Options for :meth:`CortadelClient.add`."""

    app: Optional[str] = None
    """App name that created the memory."""

    metadata: Optional[dict[str, Any]] = None
    """Arbitrary metadata stored alongside the memory."""

    infer: Optional[bool] = None
    """When ``False``, store the text verbatim and skip background entity/category extraction
    (dedup still applies). Default ``True``."""

    memory_type: Optional[str] = None
    """Optional cognitive-type pin: ``episodic`` | ``semantic`` | ``procedural``. Invalid values
    are ignored (auto-classified)."""


@dataclass(frozen=True, slots=True)
class ConversationOptions:
    """Options for :meth:`CortadelClient.add_conversation`."""

    is_agent_memory: bool = False
    """When ``True``, extract facts about the assistant instead of the user."""

    tags: Optional[list[str]] = None
    """Tags applied to every extracted fact (for scoped retrieval)."""

    project: Optional[str] = None
    """Optional project scope (e.g. a repo name)."""

    session_id: Optional[str] = None
    """Optional session id grouping the extracted facts."""

    transcript_path: Optional[str] = None
    """Optional producer-local transcript path (stored as a pointer anchor)."""


@dataclass(frozen=True, slots=True)
class SearchOptions:
    """Options for :meth:`CortadelClient.search`."""

    top_k: int = 10
    """Maximum number of results (1-50). Default 10."""

    mode: str = "hybrid"
    """Search mode: ``hybrid`` (default), ``text``, or ``vector``."""

    session_id: Optional[str] = None
    """Restrict results to a session."""

    rerank: Optional[str] = None
    """Set to ``cross_encoder`` to rerank with the local cross-encoder; omit to skip."""

    memory_type: Optional[str] = None
    """Filter by cognitive type: ``episodic`` | ``semantic`` | ``procedural``."""


@dataclass(frozen=True, slots=True)
class ListOptions:
    """Options for :meth:`CortadelClient.list`."""

    page: int = 1
    """Page number (1-based). Default 1."""

    size: int = DEFAULT_LIST_SIZE
    """Page size (max 100). Default :data:`DEFAULT_LIST_SIZE` (20) — see that constant's note."""

    app_id: Optional[str] = None
    """Filter by app id."""

    categories: Optional[str] = None
    """Comma-separated category names to filter by."""

    search_query: Optional[str] = None
    """When set, runs a hybrid search instead of a plain list."""

    include_superseded: bool = False
    """Include superseded (older) versions of memories."""

    memory_type: Optional[str] = None
    """Filter by cognitive type."""


# ── Responses ────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MemoryCreated:
    """Result of storing a memory."""

    id: str
    content: Optional[str] = None
    state: Optional[str] = None
    created_at: Optional[str] = None
    """ISO 8601 creation timestamp (this endpoint returns a string; list/detail return Unix
    seconds)."""
    event: Optional[str] = None
    """What happened, e.g. ``ADD`` or ``SKIP_DUPLICATE``."""
    app_name: Optional[str] = None
    metadata: Optional[str] = None
    """Metadata as a JSON string (not a nested object, unlike :attr:`MemoryDetail.metadata`)."""


@dataclass(frozen=True, slots=True)
class SearchHit:
    """A single ranked search hit."""

    id: str
    content: str
    rrf_score: Optional[float] = None
    """Fused relevance score (RRF, sqrt-normalized)."""
    created_at: Optional[str] = None
    app_name: Optional[str] = None
    categories: Optional[list[str]] = None
    memory_type: Optional[str] = None
    tags: Optional[list[str]] = None
    source: Optional[str] = None
    """``personal`` or ``global`` — where the hit came from."""
    is_global: bool = False
    """``True`` when this hit is a globally-shared memory owned by another user."""
    gist: Optional[str] = None
    """One-line distilled gist of the memory, when the server computed one."""
    project_id: Optional[str] = None
    member_ids: Optional[list[str]] = None
    """Member memory ids folded into this hit (session-arm rollups)."""
    similar_ids: Optional[list[str]] = None
    """Ids of similar/duplicate memories, when computed."""
    text_rank: Optional[int] = None
    """Rank within the text (BM25) arm before fusion, if this hit matched it."""
    vector_rank: Optional[int] = None
    """Rank within the vector arm before fusion, if this hit matched it."""
    attributes: Optional[dict[str, Any]] = None
    """Freeform attributes attached to this hit (e.g. confidence_band, anchors)."""


@dataclass(frozen=True, slots=True)
class SearchResults:
    """A page of search hits."""

    query: str
    results: list[SearchHit] = field(default_factory=list)
    total: int = 0


@dataclass(frozen=True, slots=True)
class MemoryListItem:
    """A memory in a list response."""

    id: str
    content: str
    created_at: int
    """Creation time as Unix seconds."""
    state: str = "active"
    app_id: Optional[str] = None
    app_name: Optional[str] = None
    categories: list[str] = field(default_factory=list)
    memory_type: Optional[str] = None
    extraction_status: Optional[str] = None
    """Extraction pipeline status: ``done``, ``pending``, or ``failed``."""
    valid_at: Optional[str] = None
    """ISO 8601 timestamp from which this memory version is valid."""
    invalid_at: Optional[str] = None
    """ISO 8601 timestamp at which this memory was invalidated/superseded."""
    is_current: Optional[bool] = None
    """Whether this is the current (non-superseded) version of the memory."""
    is_global: bool = False
    """``True`` when this is a globally-shared memory owned by another user."""
    metadata: Optional[Any] = None
    """Always ``None`` from :class:`CortadelClient` today: the wire's ``metadata_`` field has no
    declared ``type`` in the OpenAPI schema, and Kiota's Python generator (1.34.1) drops
    properties with no declared type instead of falling back to an untyped/"any" node the way the
    .NET and TypeScript generators do — see the SDK's task report for detail. Kept on this DTO for
    source-level parity with the other SDKs; do not rely on it being populated."""


@dataclass(frozen=True, slots=True)
class MemoryList:
    """A paginated list of memories."""

    items: list[MemoryListItem] = field(default_factory=list)
    total: int = 0
    page: int = 0
    size: int = 0
    pages: int = 0


@dataclass(frozen=True, slots=True)
class MemoryDetail:
    """A single memory (from :meth:`CortadelClient.get`). Note the content field is ``text``."""

    id: str
    text: str
    created_at: int
    """Creation time as Unix seconds."""
    state: str = "active"
    app_id: Optional[str] = None
    app_name: Optional[str] = None
    categories: list[str] = field(default_factory=list)
    metadata: Optional[Any] = None
    """Always ``None`` from :class:`CortadelClient` today — same generator gap documented on
    :attr:`MemoryListItem.metadata`."""
    valid_at: Optional[str] = None
    invalid_at: Optional[str] = None
    is_current: Optional[bool] = None
    superseded_by: Optional[str] = None
    is_global: bool = False
    """``True`` when this is a globally-shared memory owned by another user."""


@dataclass(frozen=True, slots=True)
class ConversationIngestItem:
    """One fact distilled from a conversation and stored."""

    id: Optional[str] = None
    """Id of the stored memory. Empty when the underlying pipeline event carries no id (e.g.
    ``ERROR``, ``INVALIDATE``)."""
    memory: Optional[str] = None
    """The distilled fact text."""
    event: Optional[str] = None
    """What the store pipeline did, e.g. ``ADD``, ``SKIP_DUPLICATE``, or ``ERROR``."""
    error: Optional[str] = None
    """Failure detail when :attr:`event` is ``ERROR`` (or another failed branch); absent
    otherwise."""


@dataclass(frozen=True, slots=True)
class ConversationResult:
    """Result of ingesting a conversation. The two members are mutually exclusive on the wire:
    the server sends :attr:`results` when it distilled facts, or :attr:`no_facts_extracted` when
    it didn't — never both."""

    results: Optional[list[ConversationIngestItem]] = None
    """One entry per distilled fact. Absent when nothing was extracted."""
    no_facts_extracted: Optional[bool] = None
    """``True`` when the conversation yielded no storable facts; absent otherwise."""


@dataclass(frozen=True, slots=True)
class HealthResult:
    """Server health snapshot."""

    status: str
    """Overall status: ``ok`` when every check passed, ``degraded`` otherwise."""
    checked_at: Optional[str] = None
    checks: Optional[dict[str, Any]] = None
    """Per-dependency check details, keyed by dependency name (``memgraph``, ``embeddings``,
    ``indexes`` today)."""


# ── Errors ───────────────────────────────────────────────────────────────────────────────────


class CortadelError(Exception):
    """Raised when the Cortadel server returns a non-success response.

    Never raised for cancellation: ``asyncio.CancelledError`` propagates untouched instead of
    becoming a :class:`CortadelError` — see ``cortadel.client``'s ``_execute``.
    """

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        """HTTP status code returned by the server. 0 when the transport failed before a status
        was known."""
        self.code = code
        """Machine-readable error code (e.g. ``not_found``, ``validation_error``)."""
        self.message = message

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"CortadelError(status={self.status!r}, code={self.code!r}, message={self.message!r})"
