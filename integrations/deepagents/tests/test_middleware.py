"""Hook-level tests for `CortadelMemoryMiddleware`.

These call the middleware's hooks directly with a hand-built `Runtime`/`RunnableConfig`, which is
exactly how DeepAgents invokes them (`before_agent`/`after_agent` are graph nodes;
`wrap_model_call` wraps the model node). `test_agent_integration.py` covers the same paths through
a real compiled `create_deep_agent` graph.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import (
    BASE_URL,
    FALLBACK_USER_ID,
    OTHER_USER_ID,
    STATIC_USER_ID,
    USER_ID,
    FakeCortadelClient,
    hit,
    transport_error,
)
from cortadel import SyncCortadelClient
from cortadel_deepagents import CortadelMemoryMiddleware
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langgraph.runtime import Runtime

CONFIG: dict[str, Any] = {"configurable": {"thread_id": "thread-1"}}


def runtime(**context: Any) -> Runtime[Any]:
    return Runtime(context=context or None)


def state(*messages: Any, **extra: Any) -> dict[str, Any]:
    return {"messages": list(messages), **extra}


def model_request(agent_state: dict[str, Any], system: str | None = "Base prompt.") -> ModelRequest[Any]:
    return ModelRequest(
        model=GenericFakeChatModel(messages=iter([AIMessage(content="ok")])),
        messages=list(agent_state.get("messages") or ()),
        system_message=SystemMessage(content=system) if system is not None else None,
        state=agent_state,
        runtime=runtime(),
    )


def capture_handler() -> tuple[list[ModelRequest[Any]], Any]:
    seen: list[ModelRequest[Any]] = []

    def handler(request: ModelRequest[Any]) -> ModelResponse[Any]:
        seen.append(request)
        return ModelResponse(result=[AIMessage(content="ok")])

    return seen, handler


# ---------------------------------------------------------------------------
# Retrieve -> inject
# ---------------------------------------------------------------------------


def test_before_agent_searches_with_the_latest_user_message() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Ships on Fridays.")])
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, top_k=3, raise_on_error=True)

    update = middleware.before_agent(
        state(HumanMessage("first question"), AIMessage("answer"), HumanMessage("second question")),
        runtime(),
        CONFIG,
    )

    assert len(client.searches) == 1
    assert client.searches[0].query == "second question"
    assert client.searches[0].options.top_k == 3
    assert client.searches[0].options.mode == "hybrid"
    assert update == {
        "cortadel_memories": [{"id": "m1", "content": "Ships on Fridays."}],
        "cortadel_recall_query": "second question",
    }


def test_recalled_memories_are_injected_into_the_system_message() -> None:
    middleware = CortadelMemoryMiddleware(client=FakeCortadelClient(), user_id=USER_ID)
    agent_state = state(
        HumanMessage("hello"),
        cortadel_memories=[{"id": "m1", "content": "Ships on Fridays.", "created_at": "2026-01-02T03:04:05Z"}],
    )
    seen, handler = capture_handler()

    middleware.wrap_model_call(model_request(agent_state), handler)

    prompt = seen[0].system_message.text
    assert "Base prompt." in prompt
    assert "<cortadel_memory>" in prompt
    assert "1. Ships on Fridays. [recorded 2026-01-02]" in prompt


def test_injection_reports_an_empty_recall_rather_than_a_stale_one() -> None:
    middleware = CortadelMemoryMiddleware(client=FakeCortadelClient(), user_id=USER_ID)
    seen, handler = capture_handler()

    middleware.wrap_model_call(model_request(state(HumanMessage("hi"))), handler)

    assert "no relevant memories recalled" in seen[0].system_message.text


def test_injection_never_mutates_the_incoming_request() -> None:
    # `wrap_model_call` runs on every model call; if it appended in place, the memory block would
    # accumulate once per call within a single turn.
    middleware = CortadelMemoryMiddleware(client=FakeCortadelClient(), user_id=USER_ID)
    agent_state = state(HumanMessage("hi"), cortadel_memories=[{"id": "m1", "content": "Fact."}])
    request = model_request(agent_state)
    seen, handler = capture_handler()

    middleware.wrap_model_call(request, handler)
    middleware.wrap_model_call(request, handler)

    assert request.system_message.text == "Base prompt."
    assert seen[0].system_message.text == seen[1].system_message.text
    assert seen[0].system_message.text.count("<cortadel_memory>") == 1


def test_system_prompt_none_recalls_without_injecting() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Fact.")])
    middleware = CortadelMemoryMiddleware(
        client=client, user_id=USER_ID, system_prompt=None, raise_on_error=True
    )

    update = middleware.before_agent(state(HumanMessage("hi")), runtime(), CONFIG)
    seen, handler = capture_handler()
    middleware.wrap_model_call(model_request(state(HumanMessage("hi"), **update)), handler)

    assert update["cortadel_memories"] == [{"id": "m1", "content": "Fact."}]
    assert seen[0].system_message.text == "Base prompt."


def test_recall_is_skipped_when_the_user_message_has_not_changed() -> None:
    # A run resumed after a human-in-the-loop interrupt re-enters `before_agent` with the same
    # last human message; re-searching would cost a round trip for identical hits.
    client = FakeCortadelClient(hits=[hit("m1", "Fact.")])
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    agent_state = state(HumanMessage("same question"))

    first = middleware.before_agent(agent_state, runtime(), CONFIG)
    second = middleware.before_agent(state(HumanMessage("same question"), **first), runtime(), CONFIG)

    assert len(client.searches) == 1
    assert second is None


def test_recall_is_skipped_when_there_is_no_user_message() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)

    assert middleware.before_agent(state(SystemMessage("boot")), runtime(), CONFIG) is None
    assert client.searches == []


def test_rerank_and_memory_type_reach_the_search_options() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(
        client=client,
        user_id=USER_ID,
        rerank=True,
        memory_type="semantic",
        search_mode="vector",
        scope_recall_to_session=True,
        raise_on_error=True,
    )

    middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG)

    options = client.searches[0].options
    assert options.rerank == "cross_encoder"
    assert options.memory_type == "semantic"
    assert options.mode == "vector"
    assert options.session_id == "thread-1"


def test_recall_is_not_session_scoped_by_default() -> None:
    # Long-term memory that only recalled within one thread would not be long-term memory.
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)

    middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG)

    assert client.searches[0].options.session_id is None


def test_top_k_defaults_to_five() -> None:
    # The repo-wide default for automatic per-turn recall; the `search_memory` tool asks for 10.
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)

    middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG)

    assert client.searches[0].options.top_k == 5


# ---------------------------------------------------------------------------
# Persist after the turn
# ---------------------------------------------------------------------------


def test_after_agent_persists_the_turn_as_a_conversation() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(
        client=client,
        user_id=USER_ID,
        tags=["deepagents"],
        project="cortadel",
        raise_on_error=True,
    )

    update = middleware.after_agent(
        state(HumanMessage("remember this", id="h1"), AIMessage("noted", id="a1")),
        runtime(),
        CONFIG,
    )

    assert len(client.conversations) == 1
    call = client.conversations[0]
    assert [(m.role, m.content, m.uuid) for m in call.messages] == [
        ("user", "remember this", "h1"),
        ("assistant", "noted", "a1"),
    ]
    assert call.options.session_id == "thread-1"
    assert call.options.tags == ["deepagents"]
    assert call.options.project == "cortadel"
    assert call.options.is_agent_memory is False
    assert update == {"cortadel_persisted_count": 2}


def test_system_and_tool_traffic_is_not_persisted() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)

    middleware.after_agent(
        state(
            SystemMessage("a very long deep-agent harness prompt"),
            HumanMessage("do the thing"),
            AIMessage(content="", tool_calls=[{"name": "ls", "args": {"path": "/"}, "id": "tc1"}]),
            ToolMessage(content="/a\n/b", tool_call_id="tc1"),
            AIMessage("done"),
        ),
        runtime(),
        CONFIG,
    )

    assert [(m.role, m.content) for m in client.conversations[0].messages] == [
        ("user", "do the thing"),
        ("assistant", "done"),
    ]


def test_only_the_new_suffix_is_persisted_on_a_second_turn() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    turn_one = state(HumanMessage("first"), AIMessage("one"))

    first_update = middleware.after_agent(turn_one, runtime(), CONFIG)
    turn_two = state(
        HumanMessage("first"),
        AIMessage("one"),
        HumanMessage("second"),
        AIMessage("two"),
        **first_update,
    )
    second_update = middleware.after_agent(turn_two, runtime(), CONFIG)

    assert [(m.role, m.content) for m in client.conversations[1].messages] == [
        ("user", "second"),
        ("assistant", "two"),
    ]
    assert second_update == {"cortadel_persisted_count": 4}


def test_nothing_is_persisted_when_there_are_no_new_messages() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)

    update = middleware.after_agent(
        state(HumanMessage("first"), AIMessage("one"), cortadel_persisted_count=2),
        runtime(),
        CONFIG,
    )

    assert update is None
    assert client.conversations == []


def test_write_memories_false_disables_persistence_but_not_recall() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Fact.")])
    middleware = CortadelMemoryMiddleware(
        client=client, user_id=USER_ID, write_memories=False, raise_on_error=True
    )
    agent_state = state(HumanMessage("q"), AIMessage("a"))

    assert middleware.before_agent(agent_state, runtime(), CONFIG) is not None
    assert middleware.after_agent(agent_state, runtime(), CONFIG) is None
    assert client.conversations == []


def test_is_agent_memory_flips_the_extraction_subject() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(
        client=client, user_id=USER_ID, is_agent_memory=True, raise_on_error=True
    )

    middleware.after_agent(state(HumanMessage("q"), AIMessage("a")), runtime(), CONFIG)

    assert client.conversations[0].options.is_agent_memory is True


# ---------------------------------------------------------------------------
# Per-user scoping
# ---------------------------------------------------------------------------


def test_user_id_comes_from_runtime_context_first() -> None:
    built: list[str] = []

    def factory(user_id: str) -> Any:
        built.append(user_id)
        return FakeCortadelClient(user_id=user_id)

    middleware = CortadelMemoryMiddleware(
        client_factory=factory, user_id=FALLBACK_USER_ID, raise_on_error=True
    )

    middleware.before_agent(state(HumanMessage("q")), runtime(user_id=USER_ID), CONFIG)

    assert built == [USER_ID]


def test_user_id_falls_back_to_configurable_then_to_the_static_argument() -> None:
    built: list[str] = []

    def factory(user_id: str) -> Any:
        built.append(user_id)
        return FakeCortadelClient(user_id=user_id)

    middleware = CortadelMemoryMiddleware(
        client_factory=factory, user_id=STATIC_USER_ID, raise_on_error=True
    )

    middleware.before_agent(
        state(HumanMessage("q")),
        runtime(),
        {"configurable": {"thread_id": "t", "user_id": OTHER_USER_ID}},
    )
    middleware.before_agent(state(HumanMessage("q2")), runtime(), CONFIG)

    assert built == [OTHER_USER_ID, STATIC_USER_ID]


def test_each_user_gets_their_own_client_and_clients_are_cached() -> None:
    clients: dict[str, FakeCortadelClient] = {}

    def factory(user_id: str) -> Any:
        clients[user_id] = FakeCortadelClient(user_id=user_id)
        return clients[user_id]

    middleware = CortadelMemoryMiddleware(client_factory=factory, raise_on_error=True)

    middleware.before_agent(state(HumanMessage("a")), runtime(user_id=USER_ID), CONFIG)
    middleware.before_agent(state(HumanMessage("b")), runtime(user_id=OTHER_USER_ID), CONFIG)
    middleware.before_agent(state(HumanMessage("c")), runtime(user_id=USER_ID), CONFIG)

    assert set(clients) == {USER_ID, OTHER_USER_ID}
    # Two searches on the first user's client, one on the second's -- never crossed over.
    assert [call.query for call in clients[USER_ID].searches] == ["a", "c"]
    assert [call.query for call in clients[OTHER_USER_ID].searches] == ["b"]


def test_a_run_with_no_resolvable_user_id_runs_without_memory() -> None:
    middleware = CortadelMemoryMiddleware(base_url=BASE_URL, raise_on_error=True)

    assert middleware.before_agent(state(HumanMessage("q")), runtime(), {}) is None
    assert middleware.after_agent(state(HumanMessage("q"), AIMessage("a")), runtime(), {}) is None


def test_close_closes_owned_clients_but_not_a_caller_supplied_one() -> None:
    owned = FakeCortadelClient(user_id=USER_ID)
    middleware = CortadelMemoryMiddleware(client_factory=lambda _: owned, raise_on_error=True)
    middleware.before_agent(state(HumanMessage("q")), runtime(user_id=USER_ID), CONFIG)
    middleware.close()
    assert owned.closed is True

    supplied = FakeCortadelClient(user_id=USER_ID)
    pinned = CortadelMemoryMiddleware(client=supplied, user_id=USER_ID)
    pinned.close()
    assert supplied.closed is False


def test_env_vars_supply_the_connection_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORTADEL_BASE_URL", "https://app.cortadel.ai")
    monkeypatch.setenv("CORTADEL_USER_ID", USER_ID)
    monkeypatch.setenv("CORTADEL_API_KEY", "not-a-real-key")

    middleware = CortadelMemoryMiddleware()
    client = middleware._provider.for_run(runtime(), CONFIG)

    try:
        assert isinstance(client, SyncCortadelClient)
    finally:
        middleware.close()


# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------


def test_a_failing_search_degrades_to_no_memory() -> None:
    client = FakeCortadelClient(fail_with=transport_error())
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID)

    assert middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG) is None


def test_a_failing_write_does_not_advance_the_cursor() -> None:
    # Retrying next turn is the safe failure mode: `add_conversation` deduplicates, whereas a
    # silently advanced cursor would lose the turn forever.
    client = FakeCortadelClient(fail_with=transport_error())
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID)

    assert middleware.after_agent(state(HumanMessage("q"), AIMessage("a")), runtime(), CONFIG) is None


def test_raise_on_error_propagates_for_tests_and_ci() -> None:
    client = FakeCortadelClient(fail_with=transport_error("boom"))
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)

    with pytest.raises(Exception, match="boom"):
        middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG)


def test_on_error_observes_every_swallowed_failure() -> None:
    seen: list[Exception] = []
    client = FakeCortadelClient(fail_with=transport_error("boom"))
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, on_error=seen.append)

    middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG)
    middleware.after_agent(state(HumanMessage("q"), AIMessage("a")), runtime(), CONFIG)

    assert [str(error) for error in seen] == ["boom", "boom"]


def test_on_error_replaces_the_warning_log(caplog: pytest.LogCaptureFixture) -> None:
    # "warn" and "ignore" are not separate modes: a callback is what replaces the log line.
    client = FakeCortadelClient(fail_with=transport_error())
    observed = CortadelMemoryMiddleware(client=client, user_id=USER_ID, on_error=lambda _: None)
    silent = CortadelMemoryMiddleware(client=client, user_id=USER_ID)

    with caplog.at_level("WARNING", logger="cortadel_deepagents.middleware"):
        observed.before_agent(state(HumanMessage("q")), runtime(), CONFIG)
        assert caplog.records == []

        silent.before_agent(state(HumanMessage("q")), runtime(), CONFIG)
        assert "recall failed (transport_error: connection refused)" in caplog.text


def test_on_error_observes_a_failure_that_is_then_re_raised() -> None:
    # The two options are orthogonal: `on_error` reports, `raise_on_error` decides.
    seen: list[Exception] = []
    client = FakeCortadelClient(fail_with=transport_error("boom"))
    middleware = CortadelMemoryMiddleware(
        client=client, user_id=USER_ID, raise_on_error=True, on_error=seen.append
    )

    with pytest.raises(Exception, match="boom"):
        middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG)

    assert [str(error) for error in seen] == ["boom"]


def test_a_raising_on_error_callback_does_not_take_the_agent_down() -> None:
    client = FakeCortadelClient(fail_with=transport_error())

    def explode(error: Exception) -> None:
        raise RuntimeError("the observer is broken")

    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, on_error=explode)

    assert middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG) is None


def test_an_unreachable_server_still_lets_the_middleware_construct() -> None:
    # Construction must never probe the network; a bad URL surfaces as "no memory", not a crash.
    middleware = CortadelMemoryMiddleware(base_url="not a url", user_id=USER_ID)
    try:
        assert middleware.before_agent(state(HumanMessage("q")), runtime(), CONFIG) is None
    finally:
        middleware.close()


# ---------------------------------------------------------------------------
# Prompt-template validation (mirrors MemoryMiddleware's own contract)
# ---------------------------------------------------------------------------


def test_system_prompt_must_contain_the_slot() -> None:
    with pytest.raises(ValueError, match=r"\{cortadel_memories\}"):
        CortadelMemoryMiddleware(client=FakeCortadelClient(), system_prompt="no slot here")


def test_system_prompt_must_be_a_string_or_none() -> None:
    with pytest.raises(TypeError, match="system_prompt must be str or None"):
        CortadelMemoryMiddleware(client=FakeCortadelClient(), system_prompt=123)  # type: ignore[arg-type]


def test_a_custom_prompt_template_is_used_verbatim() -> None:
    middleware = CortadelMemoryMiddleware(
        client=FakeCortadelClient(),
        user_id=USER_ID,
        system_prompt="Known facts:\n{cortadel_memories}",
    )
    agent_state = state(HumanMessage("hi"), cortadel_memories=[{"id": "m1", "content": "Fact."}])
    seen, handler = capture_handler()

    middleware.wrap_model_call(model_request(agent_state), handler)

    assert seen[0].system_message.text.endswith("Known facts:\n1. Fact.")


# ---------------------------------------------------------------------------
# Async parity
# ---------------------------------------------------------------------------


async def test_async_hooks_mirror_the_sync_ones() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Fact.")])
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)

    recall = await middleware.abefore_agent(state(HumanMessage("q")), runtime(), CONFIG)
    persist = await middleware.aafter_agent(
        state(HumanMessage("q"), AIMessage("a")), runtime(), CONFIG
    )

    assert recall == {"cortadel_memories": [{"id": "m1", "content": "Fact."}], "cortadel_recall_query": "q"}
    assert persist == {"cortadel_persisted_count": 2}
    assert len(client.searches) == 1
    assert len(client.conversations) == 1


async def test_async_injection_matches_sync_injection() -> None:
    middleware = CortadelMemoryMiddleware(client=FakeCortadelClient(), user_id=USER_ID)
    agent_state = state(HumanMessage("hi"), cortadel_memories=[{"id": "m1", "content": "Fact."}])
    seen: list[ModelRequest[Any]] = []

    async def handler(request: ModelRequest[Any]) -> ModelResponse[Any]:
        seen.append(request)
        return ModelResponse(result=[AIMessage(content="ok")])

    await middleware.awrap_model_call(model_request(agent_state), handler)

    assert "1. Fact." in seen[0].system_message.text


async def test_async_failure_degrades_too() -> None:
    client = FakeCortadelClient(fail_with=transport_error())
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID)

    assert await middleware.abefore_agent(state(HumanMessage("q")), runtime(), CONFIG) is None
    assert await middleware.aafter_agent(state(HumanMessage("q"), AIMessage("a")), runtime(), CONFIG) is None
