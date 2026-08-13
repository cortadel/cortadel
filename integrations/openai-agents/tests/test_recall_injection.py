"""The retrieve-and-inject path — ``RunConfig.call_model_input_filter``.

Exercised directly here (a ``CallModelData`` in, a ``ModelInputData`` out);
``test_runner_integration.py`` then proves the runner really calls it.
"""

from __future__ import annotations

import pytest
from agents import Agent, RunConfig
from agents.run import CallModelData, ModelInputData
from conftest import SESSION_ID, USER_ID, hit
from cortadel import CortadelError
from cortadel_openai_agents import DEFAULT_MEMORY_HEADER, CortadelSession


def call_data(
    items: list[dict], instructions: str | None = None
) -> CallModelData:
    return CallModelData(
        model_data=ModelInputData(input=list(items), instructions=instructions),
        agent=Agent(name="Assistant"),
        context=None,
    )


@pytest.fixture
def session(fake_client) -> CortadelSession:
    fake_client.hits = [
        hit("Alice prefers dark mode.", memory_id="m1"),
        hit("Alice ships on Fridays.", memory_id="m2"),
    ]
    return CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)


async def test_memories_are_appended_to_the_instructions(
    session: CortadelSession, fake_client
) -> None:
    result = await session.input_filter(
        call_data([{"role": "user", "content": "what are my preferences?"}], "You are helpful.")
    )

    assert result.instructions is not None
    assert result.instructions.startswith("You are helpful.")
    assert DEFAULT_MEMORY_HEADER in result.instructions
    assert "1. Alice prefers dark mode." in result.instructions
    assert "2. Alice ships on Fridays." in result.instructions
    # The item list is untouched, so nothing synthetic can be persisted back into history.
    assert result.input == [{"role": "user", "content": "what are my preferences?"}]


async def test_the_last_user_message_is_the_search_query(
    session: CortadelSession, fake_client
) -> None:
    await session.input_filter(
        call_data(
            [
                {"role": "user", "content": "older question"},
                {"role": "assistant", "content": "older answer"},
                {"role": "user", "content": "what editor do I use?"},
            ]
        )
    )

    query, options = fake_client.searches[0]
    assert query == "what editor do I use?"
    assert options is not None
    assert options.top_k == 5
    assert options.mode == "hybrid"


async def test_instructions_are_created_when_the_agent_has_none(
    session: CortadelSession,
) -> None:
    result = await session.input_filter(call_data([{"role": "user", "content": "hi"}], None))

    assert result.instructions is not None
    assert result.instructions.startswith(DEFAULT_MEMORY_HEADER)


async def test_input_mode_inserts_a_system_item_before_the_last_user_message(
    fake_client,
) -> None:
    fake_client.hits = [hit("Alice prefers dark mode.")]
    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=fake_client, inject_as="input"
    )

    result = await session.input_filter(
        call_data(
            [
                {"role": "user", "content": "earlier"},
                {"role": "assistant", "content": "sure"},
                {"role": "user", "content": "and now?"},
            ],
            "You are helpful.",
        )
    )

    roles = [item["role"] for item in result.input]
    assert roles == ["user", "assistant", "system", "user"]
    assert DEFAULT_MEMORY_HEADER in result.input[2]["content"]
    # Everything before the injection point is byte-identical, so a prompt-prefix cache holds.
    assert result.input[:2] == [
        {"role": "user", "content": "earlier"},
        {"role": "assistant", "content": "sure"},
    ]
    assert result.instructions == "You are helpful."


async def test_no_user_message_means_no_search_and_no_change(
    session: CortadelSession, fake_client
) -> None:
    data = call_data([{"type": "function_call_output", "call_id": "c1", "output": "x"}], "sys")

    result = await session.input_filter(data)

    assert result is data.model_data
    assert fake_client.searches == []


async def test_no_hits_means_nothing_is_injected(session: CortadelSession, fake_client) -> None:
    fake_client.hits = []

    result = await session.input_filter(call_data([{"role": "user", "content": "hi"}], "sys"))

    assert result.instructions == "sys"


async def test_repeat_calls_within_a_turn_search_once(
    session: CortadelSession, fake_client
) -> None:
    """The filter fires per model call; a tool-using turn must not re-query Cortadel."""
    data = call_data([{"role": "user", "content": "same question"}])

    await session.input_filter(data)
    await session.input_filter(call_data([{"role": "user", "content": "same question"}]))

    assert len(fake_client.searches) == 1


async def test_the_cache_is_invalidated_when_the_conversation_advances(
    session: CortadelSession, fake_client
) -> None:
    await session.input_filter(call_data([{"role": "user", "content": "same question"}]))
    await session.add_items(
        [{"role": "user", "content": "same question"}, {"role": "assistant", "content": "ok"}]
    )
    await session.input_filter(call_data([{"role": "user", "content": "same question"}]))

    assert len(fake_client.searches) == 2


async def test_an_already_injected_block_is_not_injected_twice(
    session: CortadelSession,
) -> None:
    first = await session.input_filter(call_data([{"role": "user", "content": "hi"}], "sys"))
    second = await session.input_filter(
        call_data([{"role": "user", "content": "hi"}], first.instructions)
    )

    assert second.instructions is not None
    assert second.instructions.count(DEFAULT_MEMORY_HEADER) == 1


async def test_min_score_drops_weak_hits(fake_client) -> None:
    fake_client.hits = [hit("strong", memory_id="m1", score=0.9), hit("weak", memory_id="m2", score=0.1)]
    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=fake_client, min_score=0.5
    )

    result = await session.input_filter(call_data([{"role": "user", "content": "hi"}]))

    assert result.instructions is not None
    assert "strong" in result.instructions
    assert "weak" not in result.instructions


async def test_search_options_carry_top_k_and_rerank(fake_client) -> None:
    session = CortadelSession(
        session_id=SESSION_ID,
        user_id=USER_ID,
        client=fake_client,
        top_k=3,
        search_mode="vector",
        rerank="cross_encoder",
    )

    await session.input_filter(call_data([{"role": "user", "content": "hi"}]))

    _, options = fake_client.searches[0]
    assert options is not None
    assert (options.top_k, options.mode, options.rerank) == (3, "vector", "cross_encoder")


async def test_recall_spans_conversations_by_default(
    session: CortadelSession, fake_client
) -> None:
    """The point of long-term memory: an earlier chat window is still searchable."""
    await session.input_filter(call_data([{"role": "user", "content": "hi"}]))

    _, options = fake_client.searches[0]
    assert options is not None
    assert options.session_id is None


async def test_scope_recall_to_session_restricts_the_search_to_this_conversation(
    fake_client,
) -> None:
    session = CortadelSession(
        session_id=SESSION_ID,
        user_id=USER_ID,
        client=fake_client,
        scope_recall_to_session=True,
    )

    await session.input_filter(call_data([{"role": "user", "content": "hi"}]))

    _, options = fake_client.searches[0]
    assert options is not None
    assert options.session_id == SESSION_ID


async def test_retrieve_false_skips_the_search_entirely(fake_client) -> None:
    fake_client.hits = [hit("Alice prefers dark mode.")]
    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=fake_client, retrieve=False
    )

    result = await session.input_filter(call_data([{"role": "user", "content": "hi"}], "sys"))

    assert result.instructions == "sys"
    assert fake_client.searches == []


async def test_an_unreachable_server_leaves_the_model_call_untouched(
    unreachable_client,
) -> None:
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=unreachable_client)

    result = await session.input_filter(call_data([{"role": "user", "content": "hi"}], "sys"))

    assert result.instructions == "sys"
    assert result.input == [{"role": "user", "content": "hi"}]


async def test_raise_on_error_surfaces_search_failures(unreachable_client) -> None:
    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=unreachable_client, raise_on_error=True
    )

    with pytest.raises(CortadelError):
        await session.input_filter(call_data([{"role": "user", "content": "hi"}]))


async def test_on_error_observes_the_failure_instead_of_the_warning_log(
    unreachable_client, caplog
) -> None:
    seen: list[Exception] = []
    session = CortadelSession(
        session_id=SESSION_ID,
        user_id=USER_ID,
        client=unreachable_client,
        on_error=seen.append,
    )

    with caplog.at_level("WARNING", logger="cortadel_openai_agents"):
        result = await session.input_filter(call_data([{"role": "user", "content": "hi"}], "sys"))

    assert [type(exc) for exc in seen] == [CortadelError]
    assert seen[0].code == "transport_error"
    # The callback replaces the fallback warning rather than doubling it.
    assert caplog.text == ""
    # …and the agent still runs: observing a failure is not surfacing it.
    assert result.instructions == "sys"


async def test_an_async_on_error_callback_is_awaited(unreachable_client) -> None:
    seen: list[Exception] = []

    async def record(exc: Exception) -> None:
        seen.append(exc)

    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=unreachable_client, on_error=record
    )

    await session.input_filter(call_data([{"role": "user", "content": "hi"}]))

    assert len(seen) == 1


async def test_on_error_and_raise_on_error_compose(unreachable_client) -> None:
    """Observation and propagation are independent knobs: the callback fires, then it raises."""
    seen: list[Exception] = []
    session = CortadelSession(
        session_id=SESSION_ID,
        user_id=USER_ID,
        client=unreachable_client,
        raise_on_error=True,
        on_error=seen.append,
    )

    with pytest.raises(CortadelError):
        await session.input_filter(call_data([{"role": "user", "content": "hi"}]))

    assert len(seen) == 1


async def test_a_broken_on_error_callback_cannot_mask_the_memory_failure(
    unreachable_client, caplog
) -> None:
    def explode(exc: Exception) -> None:
        raise RuntimeError("telemetry is down too")

    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=unreachable_client, on_error=explode
    )

    with caplog.at_level("WARNING", logger="cortadel_openai_agents"):
        result = await session.input_filter(call_data([{"role": "user", "content": "hi"}], "sys"))

    assert result.instructions == "sys"
    assert "on_error callback raised" in caplog.text


def test_run_config_installs_the_filter_without_clobbering_other_settings(
    fake_client,
) -> None:
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)

    plain = session.run_config()
    assert plain.call_model_input_filter is session.input_filter

    base = RunConfig(workflow_name="my-workflow", trace_include_sensitive_data=False)
    merged = session.run_config(base)
    assert merged.call_model_input_filter is session.input_filter
    assert merged.workflow_name == "my-workflow"
    assert merged.trace_include_sensitive_data is False
    assert base.call_model_input_filter is None, "the base config was copied, not mutated"


def test_run_config_warns_before_displacing_an_existing_filter(fake_client, caplog) -> None:
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)
    existing = RunConfig(call_model_input_filter=lambda data: data.model_data)

    with caplog.at_level("WARNING", logger="cortadel_openai_agents"):
        merged = session.run_config(existing)

    assert merged.call_model_input_filter is session.input_filter
    assert "Replacing the existing call_model_input_filter" in caplog.text
