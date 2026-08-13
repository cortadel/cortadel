"""An inert :class:`~crewai.memory.storage.backend.StorageBackend`.

:class:`~cortadel_crewai.CortadelMemory` overrides every text-level method of
CrewAI's ``Memory`` (``remember``/``recall``/``forget``/...) and routes them at
Cortadel over HTTP, so it never needs a local vector store.

It still needs *something* in the ``storage`` slot, for two reasons:

1. ``Memory.model_post_init`` builds a **LanceDB** store whenever ``storage`` is
   a ``str``. Handing it a non-``str`` object short-circuits that branch, so
   importing this package never pulls in LanceDB, never writes ``./.crewai``,
   and never needs an embedder or an ``OPENAI_API_KEY``.
2. Any inherited scope-introspection helper we deliberately do not override
   (``list_scopes``, ``info``, ``tree``, ``list_categories``) still calls
   through to ``_storage``. Returning empty results keeps those degrading to
   "nothing here" instead of raising ``AttributeError``.

Cortadel is a flat per-user namespace with its own server-side organisation
(entity graph, categories, bi-temporal versioning), so CrewAI's local scope
hierarchy genuinely has no counterpart to report.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from crewai.memory.types import MemoryRecord, ScopeInfo


class InertStorage:
    """A no-op ``StorageBackend``: accepts writes, reports nothing stored locally.

    Structurally compatible with CrewAI's ``runtime_checkable`` ``StorageBackend``
    protocol. Deliberately not a subclass — the protocol is duck-typed, and
    inheriting it would drag ``crewai.memory.storage.backend`` into import time
    for no benefit.
    """

    def save(self, records: list[MemoryRecord]) -> None:
        return None

    def search(
        self,
        query_embedding: list[float],
        scope_prefix: str | None = None,
        categories: list[str] | None = None,
        metadata_filter: dict[str, Any] | None = None,
        limit: int = 10,
        min_score: float = 0.0,
    ) -> list[tuple[MemoryRecord, float]]:
        # Cortadel searches by *text*, not by a caller-supplied embedding, so
        # this vector-only entry point can never be served faithfully.
        # CortadelMemory.recall() overrides the text path instead.
        return []

    def delete(
        self,
        scope_prefix: str | None = None,
        categories: list[str] | None = None,
        record_ids: list[str] | None = None,
        older_than: datetime | None = None,
        metadata_filter: dict[str, Any] | None = None,
    ) -> int:
        return 0

    def update(self, record: MemoryRecord) -> None:
        return None

    def get_record(self, record_id: str) -> MemoryRecord | None:
        return None

    def list_records(
        self,
        scope_prefix: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> list[MemoryRecord]:
        return []

    def get_scope_info(self, scope: str) -> ScopeInfo:
        return ScopeInfo(path=scope)

    def list_scopes(self, parent: str = "/") -> list[str]:
        return []

    def list_categories(self, scope_prefix: str | None = None) -> dict[str, int]:
        return {}

    def count(self, scope_prefix: str | None = None) -> int:
        return 0

    def reset(self, scope_prefix: str | None = None) -> None:
        return None

    async def asave(self, records: list[MemoryRecord]) -> None:
        return None

    async def asearch(
        self,
        query_embedding: list[float],
        scope_prefix: str | None = None,
        categories: list[str] | None = None,
        metadata_filter: dict[str, Any] | None = None,
        limit: int = 10,
        min_score: float = 0.0,
    ) -> list[tuple[MemoryRecord, float]]:
        return []

    async def adelete(
        self,
        scope_prefix: str | None = None,
        categories: list[str] | None = None,
        record_ids: list[str] | None = None,
        older_than: datetime | None = None,
        metadata_filter: dict[str, Any] | None = None,
    ) -> int:
        return 0

    def close(self) -> None:
        return None
