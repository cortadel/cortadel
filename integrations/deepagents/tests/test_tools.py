"""Behaviour of the `search_memory` / `add_memories` tools.

The tools take an injected `runtime: ToolRuntime`, which the tool node builds at call time. Here
we build one by hand and call the tool's `func`/`coroutine` directly;
`test_agent_integration.py` exercises the real injection path through a compiled graph.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import OTHER_USER_ID, USER_ID, FakeCortadelClient, hit, transport_error
from cortadel_deepagents import create_cortadel_tools
from langchain.tools import ToolRuntime


def tool_runtime(**configurable: Any) -> ToolRuntime[Any, Any]:
    return ToolRuntime(
        state={},
        context=None,
        config={"configurable": {"thread_id": "thread-1", **configurable}},
        stream_writer=lambda _: None,
        tool_call_id="call-1",
        store=None,
    )


def tools_for(client: FakeCortadelClient, **kwargs: Any) -> tuple[Any, Any]:
    search, add = create_cortadel_tools(client=client, user_id=USER_ID, **kwargs)
    return search, add


# ---------------------------------------------------------------------------
# search_memory
# ---------------------------------------------------------------------------


def test_search_memory_returns_a_numbered_rendering_of_the_hits() -> None:
    client = FakeCortadelClient(
        hits=[
            hit("m1", "Prefers dark mode.", created_at="2026-01-02T03:04:05Z"),
            hit("m2", "Ships on Fridays."),
        ]
    )
    search, _ = tools_for(client)

    result = search.func(tool_runtime(), "working preferences", top_k=5)

    assert client.searches[0].query == "working preferences"
    assert client.searches[0].options.top_k == 5
    assert "1. Prefers dark mode. [recorded 2026-01-02]" in result
    assert "2. Ships on Fridays." in result


def test_search_memory_asks_for_ten_memories_when_the_model_names_no_top_k() -> None:
    # The tool default matches the Cortadel SDK's own `SearchOptions.top_k`, and is deliberately
    # wider than the middleware's automatic per-turn recall (5).
    client = FakeCortadelClient()
    search, _ = tools_for(client)

    search.func(tool_runtime(), "anything")

    assert client.searches[0].options.top_k == 10


def test_search_memory_says_so_when_nothing_matches() -> None:
    search, _ = tools_for(FakeCortadelClient())

    assert search.func(tool_runtime(), "anything", 5) == 'No memories found for "anything".'


def test_search_memory_forwards_rerank_and_memory_type() -> None:
    client = FakeCortadelClient()
    search, _ = tools_for(client, rerank=True, memory_type="procedural", search_mode="text")

    search.func(tool_runtime(), "q", 3)

    options = client.searches[0].options
    assert options.rerank == "cross_encoder"
    assert options.memory_type == "procedural"
    assert options.mode == "text"


# ---------------------------------------------------------------------------
# add_memories
# ---------------------------------------------------------------------------


def test_add_memories_stores_each_fact_and_reports_the_pipeline_event() -> None:
    client = FakeCortadelClient()
    _, add = tools_for(client)

    result = add.func(tool_runtime(), ["Prefers dark mode.", "Ships on Fridays."])

    assert [call.text for call in client.adds] == ["Prefers dark mode.", "Ships on Fridays."]
    # `app` labels the memory's creator; `app_name` on the client only affects search logging.
    assert client.adds[0].options.app == "cortadel-deepagents"
    assert "ADD: Prefers dark mode." in result


def test_add_memories_ignores_blank_entries() -> None:
    client = FakeCortadelClient()
    _, add = tools_for(client)

    result = add.func(tool_runtime(), ["  ", ""])

    assert client.adds == []
    assert "Nothing to remember" in result


# ---------------------------------------------------------------------------
# Scoping and failure handling
# ---------------------------------------------------------------------------


def test_tools_scope_to_the_runtime_user_id() -> None:
    clients: dict[str, FakeCortadelClient] = {}

    def factory(user_id: str) -> Any:
        clients[user_id] = FakeCortadelClient(user_id=user_id)
        return clients[user_id]

    search, add = create_cortadel_tools(client_factory=factory)

    search.func(tool_runtime(user_id=USER_ID), "q", 5)
    add.func(tool_runtime(user_id=OTHER_USER_ID), ["a fact"])

    assert [call.query for call in clients[USER_ID].searches] == ["q"]
    assert clients[USER_ID].adds == []
    assert [call.text for call in clients[OTHER_USER_ID].adds] == ["a fact"]


def test_tools_say_so_when_no_user_id_can_be_resolved() -> None:
    search, add = create_cortadel_tools(base_url="http://localhost:3001")

    assert "not configured" in search.func(tool_runtime(), "q", 5)
    assert "not configured" in add.func(tool_runtime(), ["a fact"])


def test_tools_never_raise_when_cortadel_is_down() -> None:
    client = FakeCortadelClient(fail_with=transport_error("connection refused"))
    search, add = tools_for(client)

    search_result = search.func(tool_runtime(), "q", 5)
    add_result = add.func(tool_runtime(), ["a fact"])

    for result in (search_result, add_result):
        assert "unavailable" in result
        assert "transport_error: connection refused" in result


def test_on_error_observes_tool_failures() -> None:
    seen: list[Exception] = []
    client = FakeCortadelClient(fail_with=transport_error("boom"))
    search, add = tools_for(client, on_error=seen.append)

    search.func(tool_runtime(), "q", 5)
    add.func(tool_runtime(), ["a fact"])

    assert [str(error) for error in seen] == ["boom", "boom"]


def test_raise_on_error_lets_a_tool_failure_out() -> None:
    # Off by default because a raising tool aborts the agent's turn; on in tests and CI.
    client = FakeCortadelClient(fail_with=transport_error("boom"))
    search, _ = tools_for(client, raise_on_error=True)

    with pytest.raises(Exception, match="boom"):
        search.func(tool_runtime(), "q", 5)


# ---------------------------------------------------------------------------
# Async parity
# ---------------------------------------------------------------------------


async def test_async_tool_paths_match_the_sync_ones() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode.")])
    search, add = tools_for(client)

    search_result = await search.coroutine(tool_runtime(), "preferences", 5)
    add_result = await add.coroutine(tool_runtime(), ["Ships on Fridays."])

    assert "1. Prefers dark mode." in search_result
    assert "ADD: Ships on Fridays." in add_result


async def test_async_tools_degrade_gracefully() -> None:
    client = FakeCortadelClient(fail_with=transport_error())
    search, add = tools_for(client)

    assert "unavailable" in await search.coroutine(tool_runtime(), "q", 5)
    assert "unavailable" in await add.coroutine(tool_runtime(), ["a fact"])
