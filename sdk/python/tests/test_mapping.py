"""Tests the wire-shape mapping helpers in cortadel/mapping.py. Each case starts from a JSON
literal written with the *contract's* snake_case field names (spec/openapi.json) and runs it
through Kiota's own JsonParseNode + the real generated ``create_from_discriminator_value`` factory
— the same deserialization path a live server response goes through — before handing the result to
our mapper. Mirrors ``sdk/typescript/test/models.test.ts``."""
from __future__ import annotations

from typing import Any, TypeVar

from kiota_serialization_json.json_parse_node import JsonParseNode

from cortadel._generated.models.health_response import HealthResponse
from cortadel._generated.models.hybrid_search_result import HybridSearchResult
from cortadel._generated.models.memory_created_response import MemoryCreatedResponse
from cortadel._generated.models.memory_detail_response import MemoryDetailResponse
from cortadel._generated.models.memory_list_item_response import MemoryListItemResponse
from cortadel.mapping import (
    map_health_result,
    map_memory_created,
    map_memory_detail,
    map_memory_list_item,
    map_search_hit,
)

T = TypeVar("T")


def from_wire(json_dict: dict[str, Any], model_type: type[T]) -> T:
    """Deserializes a raw wire-shaped (snake_case) JSON literal through Kiota's real JSON parse
    node, the same path a live HTTP response body goes through."""
    node = JsonParseNode(json_dict)
    return node.get_object_value(model_type)


def test_map_search_hit_rrf_score_and_created_at() -> None:
    generated = from_wire(
        {"id": "m1", "content": "hello", "rrf_score": 0.873, "created_at": "2026-01-02T03:04:05Z", "global": True},
        HybridSearchResult,
    )

    hit = map_search_hit(generated)

    assert hit.rrf_score == 0.873
    assert hit.created_at == "2026-01-02T03:04:05Z"
    assert isinstance(hit.created_at, str)


def test_map_search_hit_maps_global_flag_not_is_global() -> None:
    """The trap that bit the .NET leg: this schema's flag is `global`, not `is_global`."""
    hit_true = map_search_hit(from_wire({"id": "m1", "global": True}, HybridSearchResult))
    hit_false = map_search_hit(from_wire({"id": "m2", "global": False}, HybridSearchResult))
    hit_absent = map_search_hit(from_wire({"id": "m3"}, HybridSearchResult))

    assert hit_true.is_global is True
    assert hit_false.is_global is False
    assert hit_absent.is_global is False


def test_map_search_hit_surfaces_freeform_attributes() -> None:
    generated = from_wire(
        {"id": "m1", "attributes": {"confidence_band": "high", "anchors": ["a", "b"]}},
        HybridSearchResult,
    )

    assert map_search_hit(generated).attributes == {"confidence_band": "high", "anchors": ["a", "b"]}


def test_map_memory_list_item_is_global_and_created_at_int() -> None:
    generated = from_wire(
        {"id": "m1", "content": "hi", "created_at": 1735689600, "is_global": True},
        MemoryListItemResponse,
    )

    item = map_memory_list_item(generated)

    assert item.is_global is True
    assert item.created_at == 1735689600
    assert isinstance(item.created_at, int)


def test_map_memory_list_item_defaults_is_global_false_when_absent() -> None:
    generated = from_wire({"id": "m1"}, MemoryListItemResponse)
    assert map_memory_list_item(generated).is_global is False


def test_map_memory_list_item_metadata_is_always_none() -> None:
    """Documented generator gap: metadata_ has no declared `type` in the OpenAPI schema, so
    Kiota's Python generator (1.34.1) drops the property entirely -- there is no attribute on
    MemoryListItemResponse to read a value from, unlike the .NET/TypeScript generators which fall
    back to an untyped node. See cortadel/mapping.py's note on map_memory_list_item."""
    generated = from_wire(
        {"id": "m1", "metadata_": {"source": "cli", "count": 3}},
        MemoryListItemResponse,
    )
    assert not hasattr(generated, "metadata") and not hasattr(generated, "metadata_")
    assert map_memory_list_item(generated).metadata is None


def test_map_memory_detail_is_global_and_created_at_int() -> None:
    generated = from_wire(
        {"id": "m1", "text": "hi", "created_at": 1735689600, "is_global": True},
        MemoryDetailResponse,
    )

    detail = map_memory_detail(generated)

    assert detail.is_global is True
    assert detail.created_at == 1735689600
    assert isinstance(detail.created_at, int)


def test_map_memory_created_keeps_created_at_as_string() -> None:
    """This endpoint, unlike list/detail, returns an ISO string for created_at."""
    generated = from_wire({"id": "m1", "created_at": "2026-01-02T03:04:05Z"}, MemoryCreatedResponse)

    created = map_memory_created(generated)
    assert created.created_at == "2026-01-02T03:04:05Z"
    assert isinstance(created.created_at, str)


def test_map_health_result_checked_at_and_nested_checks() -> None:
    generated = from_wire(
        {
            "status": "ok",
            "checked_at": "2026-01-02T03:04:05Z",
            "checks": {
                "memgraph": {"ok": True, "latency_ms": 4, "url": "bolt://localhost:7687", "user": "neo4j"},
                "embeddings": {"ok": False, "error": "timeout"},
            },
        },
        HealthResponse,
    )

    health = map_health_result(generated)

    assert health.status == "ok"
    assert health.checked_at == "2026-01-02T03:04:05Z"
    assert health.checks == {
        "memgraph": {"ok": True, "url": "bolt://localhost:7687", "user": "neo4j", "latency_ms": 4, "error": None},
        "embeddings": {"ok": False, "provider": None, "model": None, "dim": None, "latency_ms": None, "error": "timeout"},
    }
