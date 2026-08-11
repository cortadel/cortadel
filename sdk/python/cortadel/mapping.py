"""Generated-model -> facade-DTO mapping.

Deliberately its own module, separate from ``models.py``: these functions accept the *generated*
model types (``cortadel._generated.models.*``) so a future field rename in the generated tree
fails this file (an ``AttributeError`` at call time, absent a type checker) rather than silently
mismapping. If they lived in ``models.py`` instead, that module would gain a dependency on
``cortadel._generated`` — exactly the leak ``tests/test_public_api.py``'s encapsulation test
checks for, since ``models.py``'s types are re-exported wholesale from ``cortadel/__init__.py``
and this module's functions are not.

Kiota's Python generator keeps generated field names as the wire's own snake_case names (unlike
the .NET/TypeScript generators, which convert to PascalCase/camelCase) — so most of this file is a
straight attribute copy. The three places field names genuinely diverge, or the wire shape needs
real conversion, are called out below.
"""
from __future__ import annotations

import dataclasses
from typing import Any, Optional, Union

from cortadel._generated.models.conversation_ingest_item import (
    ConversationIngestItem as GeneratedConversationIngestItem,
)
from cortadel._generated.models.conversation_ingest_response import ConversationIngestResponse
from cortadel._generated.models.embedding_check import EmbeddingCheck
from cortadel._generated.models.health_checks import HealthChecks
from cortadel._generated.models.health_response import HealthResponse
from cortadel._generated.models.hybrid_search_result import HybridSearchResult
from cortadel._generated.models.indexes_check import IndexesCheck
from cortadel._generated.models.memgraph_check import MemgraphCheck
from cortadel._generated.models.memory_created_response import MemoryCreatedResponse
from cortadel._generated.models.memory_detail_response import MemoryDetailResponse
from cortadel._generated.models.memory_list_item_response import MemoryListItemResponse
from cortadel._generated.models.memory_list_paged_response import MemoryListPagedResponse
from cortadel._generated.models.search_response import SearchResponse

from cortadel.models import (
    ConversationIngestItem,
    ConversationResult,
    HealthResult,
    MemoryCreated,
    MemoryDetail,
    MemoryList,
    MemoryListItem,
    SearchHit,
    SearchResults,
)


def map_memory_created(r: MemoryCreatedResponse) -> MemoryCreated:
    return MemoryCreated(
        id=r.id or "",
        content=r.content,
        state=r.state,
        created_at=r.created_at,
        event=r.event,
        app_name=r.app_name,
        metadata=r.metadata,
    )


def map_conversation_ingest_item(i: GeneratedConversationIngestItem) -> ConversationIngestItem:
    return ConversationIngestItem(id=i.id, memory=i.memory, event=i.event, error=i.error)


def map_conversation_result(r: ConversationIngestResponse) -> ConversationResult:
    return ConversationResult(
        results=[map_conversation_ingest_item(i) for i in r.results] if r.results else None,
        no_facts_extracted=r.no_facts_extracted,
    )


def map_search_hit(h: HybridSearchResult) -> SearchHit:
    return SearchHit(
        id=h.id or "",
        content=h.content or "",
        rrf_score=h.rrf_score,
        created_at=h.created_at,
        app_name=h.app_name,
        categories=h.categories,
        memory_type=h.memory_type,
        tags=h.tags,
        source=h.source,
        # Trap: this schema's flag is `global` (kept as `global_` on the generated dataclass,
        # since `global` is a Python keyword) — MemoryListItemResponse/MemoryDetailResponse use
        # `is_global` instead. The same asymmetry is documented on the .NET and TypeScript legs.
        is_global=h.global_ or False,
        gist=h.gist,
        project_id=h.project_id,
        member_ids=h.member_ids,
        similar_ids=h.similar_ids,
        text_rank=h.text_rank,
        vector_rank=h.vector_rank,
        attributes=dict(h.attributes.additional_data) if h.attributes is not None else None,
    )


def map_search_results(r: SearchResponse) -> SearchResults:
    return SearchResults(
        query=r.query or "",
        results=[map_search_hit(h) for h in r.results] if r.results else [],
        total=r.total or 0,
    )


def map_memory_list_item(i: MemoryListItemResponse) -> MemoryListItem:
    return MemoryListItem(
        id=i.id or "",
        content=i.content or "",
        created_at=i.created_at or 0,
        state=i.state or "active",
        app_id=i.app_id,
        app_name=i.app_name,
        categories=i.categories or [],
        memory_type=i.memory_type,
        extraction_status=i.extraction_status,
        valid_at=i.valid_at,
        invalid_at=i.invalid_at,
        is_current=i.is_current,
        is_global=i.is_global or False,
        # Known generator gap, not a mapping bug: MemoryListItemResponse.metadata_ carries no
        # `type` in the OpenAPI schema (spec/openapi.json), and Kiota's Python generator (1.34.1)
        # drops properties with no declared type entirely instead of falling back to an
        # untyped/"any" node the way the .NET and TypeScript generators do. There is no
        # `metadata_`/`metadata` attribute on `MemoryListItemResponse` to read a value from — see
        # the task report for the with/without-flag comparison that confirmed this.
        metadata=None,
    )


def map_memory_list(r: MemoryListPagedResponse) -> MemoryList:
    return MemoryList(
        items=[map_memory_list_item(i) for i in r.items] if r.items else [],
        total=r.total or 0,
        page=r.page or 0,
        size=r.size or 0,
        pages=r.pages or 0,
    )


def map_memory_detail(d: MemoryDetailResponse) -> MemoryDetail:
    return MemoryDetail(
        id=d.id or "",
        text=d.text or "",
        created_at=d.created_at or 0,
        state=d.state or "active",
        app_id=d.app_id,
        app_name=d.app_name,
        categories=d.categories or [],
        # Same known gap as map_memory_list_item's `metadata` above.
        metadata=None,
        valid_at=d.valid_at,
        invalid_at=d.invalid_at,
        is_current=d.is_current,
        superseded_by=d.superseded_by,
        is_global=d.is_global or False,
    )


def _check_to_dict(
    check: Optional[Union[EmbeddingCheck, IndexesCheck, MemgraphCheck]],
) -> Optional[dict[str, Any]]:
    """``EmbeddingCheck``/``IndexesCheck``/``MemgraphCheck`` are plain flat dataclasses (leaf
    fields only, no nested Parsable), so ``dataclasses.asdict`` reproduces exactly the wire-named
    dict the .NET/TypeScript legs hand-build field-by-field, without a second hand-rolled copy
    that could drift if a check schema grows a field."""
    return dataclasses.asdict(check) if check is not None else None


def map_health_checks(c: HealthChecks) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if c.embeddings is not None:
        out["embeddings"] = _check_to_dict(c.embeddings)
    if c.indexes is not None:
        out["indexes"] = _check_to_dict(c.indexes)
    if c.memgraph is not None:
        out["memgraph"] = _check_to_dict(c.memgraph)
    return out


def map_health_result(r: HealthResponse) -> HealthResult:
    return HealthResult(
        status=r.status or "",
        checked_at=r.checked_at,
        checks=map_health_checks(r.checks) if r.checks is not None else None,
    )


__all__ = [
    "map_memory_created",
    "map_conversation_ingest_item",
    "map_conversation_result",
    "map_search_hit",
    "map_search_results",
    "map_memory_list_item",
    "map_memory_list",
    "map_memory_detail",
    "map_health_checks",
    "map_health_result",
]
