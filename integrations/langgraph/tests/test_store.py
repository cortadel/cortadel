"""``CortadelStore`` — the BaseStore op mapping, scoping, and failure behaviour."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from conftest import NAMESPACE, OTHER_USER, USER, Backend, detail, hit, list_item
from cortadel import CortadelError
from langgraph.store.base import (
    BaseStore,
    Item,
    ListNamespacesOp,
    MatchCondition,
    SearchItem,
)

from cortadel_langgraph import CortadelStore, namespace_user_id


# ── The interface itself ─────────────────────────────────────────────────────────────────────


def test_is_a_basestore_with_no_abstract_methods_left(store: CortadelStore) -> None:
    assert isinstance(store, BaseStore)
    assert not getattr(CortadelStore, "__abstractmethods__", frozenset())


def test_ttl_is_declared_unsupported_and_rejected(store: CortadelStore) -> None:
    assert store.supports_ttl is False
    with pytest.raises(NotImplementedError, match="TTL is not supported"):
        store.put(NAMESPACE, "k", {"content": "x"}, ttl=60)


def test_unknown_op_type_is_rejected(store: CortadelStore) -> None:
    with pytest.raises(ValueError, match="Unknown operation type"):
        store.batch([object()])  # type: ignore[list-item]


# ── PutOp -> add ─────────────────────────────────────────────────────────────────────────────


def test_put_stores_the_content_key_as_the_memory_text(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.put(NAMESPACE, "k1", {"content": "Prefers dark mode.", "topic": "ui"})

    text, options = fake_cortadel.first("add")
    assert text == "Prefers dark mode."
    assert options.app == "cortadel-langgraph"
    assert options.infer is True
    # The remainder of the value, plus provenance, rides along as metadata.
    assert options.metadata["topic"] == "ui"
    assert options.metadata["langgraph_key"] == "k1"
    assert options.metadata["langgraph_namespace"] == "memories/" + USER


@pytest.mark.parametrize("key", ["content", "text", "memory", "data"])
def test_put_accepts_any_of_the_default_text_keys(
    store: CortadelStore, fake_cortadel: Backend, key: str
) -> None:
    store.put(NAMESPACE, "k", {key: "a fact"})
    assert fake_cortadel.first("add")[0] == "a fact"


def test_put_falls_back_to_deterministic_json_when_no_text_key_matches(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.put(NAMESPACE, "k", {"b": 2, "a": 1})
    text, _options = fake_cortadel.first("add")
    assert text == json.dumps({"a": 1, "b": 2}, sort_keys=True)


def test_put_with_index_false_disables_cortadel_extraction(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.put(NAMESPACE, "k", {"content": "verbatim"}, index=False)
    assert fake_cortadel.first("add")[1].infer is False


def test_delete_goes_through_putop_with_a_none_value(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.delete(NAMESPACE, "cortadel-9")
    assert fake_cortadel.first("delete") == (["cortadel-9"],)


# ── Keys and the alias bridge ────────────────────────────────────────────────────────────────


def test_a_caller_key_is_bridged_to_the_minted_cortadel_id(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    fake_cortadel.detail = detail("cortadel-1", "Prefers dark mode.")
    store.put(NAMESPACE, "my-own-key", {"content": "Prefers dark mode."})

    item = store.get(NAMESPACE, "my-own-key")

    # The GET went to the id Cortadel minted, not to the caller's key.
    assert fake_cortadel.first("get") == ("cortadel-1",)
    assert item is not None
    # ...while the Item still reports the key the caller asked for, per the BaseStore contract.
    assert item.key == "my-own-key"
    assert item.value["id"] == "cortadel-1"
    assert item.value["content"] == "Prefers dark mode."


def test_deleting_through_the_alias_targets_the_minted_id(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.put(NAMESPACE, "my-own-key", {"content": "x"})
    store.delete(NAMESPACE, "my-own-key")
    assert fake_cortadel.first("delete") == (["cortadel-1"],)


def test_an_unknown_key_is_passed_through_as_a_cortadel_id(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.get(NAMESPACE, "cortadel-abc")
    assert fake_cortadel.first("get") == ("cortadel-abc",)


def test_the_alias_table_is_bounded(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER, max_alias_entries=2)
    for index in range(5):
        store.put(NAMESPACE, f"k{index}", {"content": "x"})
    assert len(store._aliases) == 2


# ── GetOp -> get ─────────────────────────────────────────────────────────────────────────────


def test_get_returns_none_for_a_missing_memory(store: CortadelStore) -> None:
    assert store.get(NAMESPACE, "nope") is None


def test_get_maps_unix_seconds_to_an_aware_datetime(store: CortadelStore, fake_cortadel: Backend) -> None:
    fake_cortadel.detail = detail("m1", "text", created_at=1_754_049_600, categories=["work"])
    item = store.get(NAMESPACE, "m1")
    assert isinstance(item, Item)
    assert item.created_at == datetime(2025, 8, 1, 12, 0, tzinfo=timezone.utc)
    assert item.value["categories"] == ["work"]


# ── SearchOp -> search / list ────────────────────────────────────────────────────────────────


def test_search_with_a_query_uses_hybrid_search(store: CortadelStore, fake_cortadel: Backend) -> None:
    fake_cortadel.search_hits = [hit("m1", "Ships on Fridays.", score=0.87)]

    results = store.search(NAMESPACE, query="when does she ship?", limit=3)

    query, options = fake_cortadel.first("search")
    assert query == "when does she ship?"
    assert options.mode == "hybrid"
    assert options.top_k == 3
    assert len(results) == 1
    found = results[0]
    assert isinstance(found, SearchItem)
    assert found.key == "m1"
    assert found.value["content"] == "Ships on Fridays."
    assert found.score == 0.87
    assert found.created_at == datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)


def test_search_without_a_query_lists_instead(store: CortadelStore, fake_cortadel: Backend) -> None:
    fake_cortadel.list_items = [list_item("m1", "A stored fact.")]

    results = store.search(NAMESPACE, limit=5)

    assert fake_cortadel.methods() == ["list"]
    (options,) = fake_cortadel.first("list")
    assert options.page == 1 and options.size == 5
    # A plain list is unranked, so there is deliberately no score.
    assert results[0].score is None
    assert results[0].value["content"] == "A stored fact."


def test_offset_is_honoured_by_overfetching_then_slicing(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit(f"m{i}", f"fact {i}") for i in range(5)]

    results = store.search(NAMESPACE, query="q", limit=2, offset=2)

    assert fake_cortadel.first("search")[1].top_k == 4  # limit + offset
    assert [item.key for item in results] == ["m2", "m3"]


def test_top_k_is_clamped_to_the_server_ceiling(store: CortadelStore, fake_cortadel: Backend) -> None:
    store.search(NAMESPACE, query="q", limit=500)
    assert fake_cortadel.first("search")[1].top_k == 50


def test_search_mode_and_rerank_are_configurable(fake_cortadel: Backend) -> None:
    store = CortadelStore(
        "http://localhost:3001", USER, search_mode="vector", rerank="cross_encoder"
    )
    store.search(NAMESPACE, query="q")
    options = fake_cortadel.first("search")[1]
    assert options.mode == "vector"
    assert options.rerank == "cross_encoder"


# ── Filters ──────────────────────────────────────────────────────────────────────────────────


def test_a_server_side_filter_key_is_pushed_into_search_options(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.search(NAMESPACE, query="q", filter={"memory_type": "semantic"})
    assert fake_cortadel.first("search")[1].memory_type == "semantic"


def test_a_client_side_filter_key_is_applied_to_the_results(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [
        hit("m1", "work fact", categories=["work"]),
        hit("m2", "home fact", categories=["home"]),
    ]
    results = store.search(NAMESPACE, query="q", filter={"categories": "work"})
    assert [item.key for item in results] == ["m1"]


def test_an_unusable_filter_key_warns_once_and_is_ignored(
    store: CortadelStore, fake_cortadel: Backend, caplog: pytest.LogCaptureFixture
) -> None:
    fake_cortadel.search_hits = [hit("m1", "a fact")]
    with caplog.at_level("WARNING", logger="cortadel_langgraph"):
        store.search(NAMESPACE, query="q", filter={"nonsense": 1})
        store.search(NAMESPACE, query="q", filter={"nonsense": 1})

    warnings = [record for record in caplog.records if "nonsense" in record.getMessage()]
    assert len(warnings) == 1, "the unusable-filter warning must not repeat per call"
    # ...and the filter genuinely does not exclude anything, which is what the warning says.
    assert len(store.search(NAMESPACE, query="q", filter={"nonsense": 1})) == 1


# ── ListNamespacesOp ─────────────────────────────────────────────────────────────────────────


def test_list_namespaces_reports_namespaces_this_instance_touched(store: CortadelStore) -> None:
    store.put(("memories", "e2e-alice"), "k", {"content": "x"})
    store.put(("memories", "e2e-bob"), "k", {"content": "x"})
    store.put(("notes", "e2e-alice"), "k", {"content": "x"})

    assert store.list_namespaces() == [
        ("memories", "e2e-alice"),
        ("memories", "e2e-bob"),
        ("notes", "e2e-alice"),
    ]
    assert store.list_namespaces(prefix=("memories",)) == [
        ("memories", "e2e-alice"),
        ("memories", "e2e-bob"),
    ]
    assert store.list_namespaces(suffix=("e2e-alice",)) == [
        ("memories", "e2e-alice"),
        ("notes", "e2e-alice"),
    ]
    assert store.list_namespaces(max_depth=1) == [("memories",), ("notes",)]


def test_list_namespaces_supports_wildcards(store: CortadelStore) -> None:
    store.batch([ListNamespacesOp()])  # no-op, proves the op type is routed
    store.put(("memories", "e2e-alice"), "k", {"content": "x"})
    matched = store.batch(
        [ListNamespacesOp(match_conditions=(MatchCondition("prefix", ("memories", "*")),))]
    )[0]
    assert matched == [("memories", "e2e-alice")]


def test_list_namespaces_is_empty_before_anything_is_touched(store: CortadelStore) -> None:
    assert store.list_namespaces() == []


# ── User-id scoping ──────────────────────────────────────────────────────────────────────────


def test_a_fixed_user_id_is_used_for_every_namespace(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    store.put(("memories", "whatever"), "k", {"content": "x"})
    assert fake_cortadel.users() == [USER]


def test_the_namespace_can_select_the_user_and_gets_its_own_client(
    fake_cortadel: Backend,
) -> None:
    store = CortadelStore("http://localhost:3001", namespace_user_id(-1), api_key="test-key")

    store.put(("memories", USER), "k", {"content": "x"})
    store.put(("memories", OTHER_USER), "k", {"content": "y"})
    store.put(("memories", USER), "k2", {"content": "z"})

    assert fake_cortadel.users() == [USER, OTHER_USER, USER]
    # One client per distinct user, reused thereafter — Cortadel binds user id at construction.
    assert [c["user_id"] for c in fake_cortadel.constructed] == [USER, OTHER_USER]
    assert fake_cortadel.constructed[0]["api_key"] == "test-key"
    assert fake_cortadel.constructed[0]["base_url"] == "http://localhost:3001"
    assert fake_cortadel.constructed[0]["app_name"] == "cortadel-langgraph"


def test_a_namespace_that_yields_no_user_degrades_instead_of_raising(
    fake_cortadel: Backend,
) -> None:
    store = CortadelStore("http://localhost:3001", namespace_user_id(5))
    assert store.search(("memories",), query="q") == []
    assert store.get(("memories",), "k") is None
    assert fake_cortadel.calls == []


def test_a_namespace_that_yields_no_user_raises_when_asked_to(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", namespace_user_id(5), raise_on_error=True)
    with pytest.raises(ValueError, match="no label at index 5"):
        store.search(("memories",), query="q")


def test_a_blank_user_id_from_the_resolver_is_reported(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", lambda ns: "", raise_on_error=True)
    with pytest.raises(ValueError, match="No Cortadel user id could be derived"):
        store.search(("memories",), query="q")


# ── Error handling ───────────────────────────────────────────────────────────────────────────


def test_a_server_failure_degrades_to_an_empty_result_by_default(
    fake_cortadel: Backend, caplog: pytest.LogCaptureFixture
) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    fake_cortadel.failures["search"] = CortadelError(0, "transport_error", "connection refused")
    fake_cortadel.failures["get"] = CortadelError(500, "http_error", "boom")

    with caplog.at_level("WARNING", logger="cortadel_langgraph"):
        assert store.search(NAMESPACE, query="q") == []
        assert store.get(NAMESPACE, "k") is None

    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "connection refused" in logged
    assert "transport_error" in logged


def test_a_write_failure_never_raises_by_default(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    fake_cortadel.failures["add"] = CortadelError(503, "http_error", "unavailable")
    assert store.put(NAMESPACE, "k", {"content": "x"}) is None


def test_an_on_error_callback_observes_the_failure_instead_of_the_log(
    fake_cortadel: Backend, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[BaseException] = []
    store = CortadelStore("http://localhost:3001", USER, on_error=seen.append)
    fake_cortadel.failures["search"] = CortadelError(500, "http_error", "boom")

    with caplog.at_level("WARNING", logger="cortadel_langgraph"):
        assert store.search(NAMESPACE, query="q") == []

    assert [type(exc).__name__ for exc in seen] == ["CortadelError"]
    assert isinstance(seen[0], CortadelError) and seen[0].status == 500
    # The callback replaces the default warning — that is how you silence it, too.
    assert caplog.records == []


def test_a_callback_that_itself_raises_does_not_take_the_agent_down(
    fake_cortadel: Backend, caplog: pytest.LogCaptureFixture
) -> None:
    def explode(exc: BaseException) -> None:
        raise RuntimeError("the observer is broken")

    store = CortadelStore("http://localhost:3001", USER, on_error=explode)
    fake_cortadel.failures["search"] = CortadelError(500, "http_error", "boom")

    with caplog.at_level("WARNING", logger="cortadel_langgraph"):
        assert store.search(NAMESPACE, query="q") == []

    assert any("on_error callback raised" in r.getMessage() for r in caplog.records)


def test_raise_on_error_propagates_the_cortadel_error(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER, raise_on_error=True)
    fake_cortadel.failures["search"] = CortadelError(401, "unauthorized", "bad key")
    with pytest.raises(CortadelError) as excinfo:
        store.search(NAMESPACE, query="q")
    assert excinfo.value.status == 401
    assert excinfo.value.code == "unauthorized"


def test_raise_on_error_wins_over_the_callback(fake_cortadel: Backend) -> None:
    """``on_error`` observes *swallowed* failures; if nothing is swallowed there is nothing to
    observe, and the exception reaches the caller unchanged."""
    seen: list[BaseException] = []
    store = CortadelStore(
        "http://localhost:3001", USER, raise_on_error=True, on_error=seen.append
    )
    fake_cortadel.failures["search"] = CortadelError(401, "unauthorized", "bad key")
    with pytest.raises(CortadelError):
        store.search(NAMESPACE, query="q")
    assert seen == []


def test_the_old_on_error_mode_string_is_rejected_loudly() -> None:
    """``on_error`` used to be a mode string here. Anyone still passing one gets told, rather
    than getting a callback that is never called."""
    with pytest.raises(TypeError, match="on_error must be a callable"):
        CortadelStore("http://localhost:3001", USER, on_error="raise")  # type: ignore[arg-type]


# ── Cortadel-specific extensions ─────────────────────────────────────────────────────────────


def test_add_conversation_passes_options_through(store: CortadelStore, fake_cortadel: Backend) -> None:
    from cortadel import ChatMessage

    result = store.add_conversation(
        NAMESPACE,
        [ChatMessage(role="user", content="hi")],
        session_id="thread-1",
        project="demo",
        tags=["chat"],
    )

    messages, options = fake_cortadel.first("add_conversation")
    assert [m.role for m in messages] == ["user"]
    assert options.session_id == "thread-1"
    assert options.project == "demo"
    assert options.tags == ["chat"]
    assert options.is_agent_memory is False
    assert result is not None and result.results is not None


def test_add_conversation_skips_an_empty_turn_list(store: CortadelStore, fake_cortadel: Backend) -> None:
    assert store.add_conversation(NAMESPACE, []) is None
    assert fake_cortadel.calls == []


def test_health_is_exposed_and_does_not_raise_when_degraded(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    from cortadel import HealthResult

    fake_cortadel.health = HealthResult(status="degraded")
    result = store.health(NAMESPACE)
    assert result is not None and result.status == "degraded"


# ── Lifecycle ────────────────────────────────────────────────────────────────────────────────


def test_close_releases_every_per_user_client(fake_cortadel: Backend) -> None:
    with CortadelStore("http://localhost:3001", namespace_user_id(-1)) as store:
        store.put(("memories", USER), "k", {"content": "x"})
        store.put(("memories", OTHER_USER), "k", {"content": "y"})

    assert sorted(fake_cortadel.closed) == sorted([f"sync:{USER}", f"sync:{OTHER_USER}"])


def test_using_a_closed_store_is_a_loud_programming_error(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    store.close()
    with pytest.raises(RuntimeError, match="CortadelStore is closed"):
        store.put(NAMESPACE, "k", {"content": "x"})


# ── Async parity ─────────────────────────────────────────────────────────────────────────────


async def test_the_async_path_uses_the_async_client(store: CortadelStore, fake_cortadel: Backend) -> None:
    fake_cortadel.search_hits = [hit("m1", "an async fact")]
    fake_cortadel.detail = detail("m1", "an async fact")

    await store.aput(NAMESPACE, "k", {"content": "an async fact"})
    results = await store.asearch(NAMESPACE, query="q")
    item = await store.aget(NAMESPACE, "k")
    await store.adelete(NAMESPACE, "k")

    assert [c["kind"] for c in fake_cortadel.constructed] == ["async"]
    assert fake_cortadel.methods() == ["add", "search", "get", "delete"]
    assert results[0].value["content"] == "an async fact"
    assert item is not None and item.key == "k"


async def test_aclose_releases_the_async_clients(fake_cortadel: Backend) -> None:
    async with CortadelStore("http://localhost:3001", USER) as store:
        await store.aput(NAMESPACE, "k", {"content": "x"})
    assert f"async:{USER}" in fake_cortadel.closed


async def test_async_add_conversation_reaches_the_server(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    from cortadel import ChatMessage

    await store.aadd_conversation(NAMESPACE, [ChatMessage(role="user", content="hi")])
    assert fake_cortadel.count("add_conversation") == 1


async def test_the_async_path_degrades_on_failure(fake_cortadel: Backend) -> None:
    seen: list[BaseException] = []
    store = CortadelStore("http://localhost:3001", USER, on_error=seen.append)
    fake_cortadel.failures["search"] = CortadelError(0, "transport_error", "down")
    assert await store.asearch(NAMESPACE, query="q") == []
    assert [getattr(exc, "code", None) for exc in seen] == ["transport_error"]
