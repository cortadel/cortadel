"""End-to-end through a real ``Runner.run()`` with a fake model.

These are the tests that prove the seams are real: the runner itself calls ``get_items`` /
``add_items`` on our session and ``call_model_input_filter`` on our filter. No stubbing of the
Agents SDK — only the model and the Cortadel server are faked.
"""

from __future__ import annotations

import pytest
from agents import Agent, Runner
from conftest import SESSION_ID, USER_ID, FakeModel, hit
from cortadel_openai_agents import DEFAULT_MEMORY_HEADER, CortadelSession


@pytest.fixture
def agent() -> Agent:
    return Agent(name="Assistant", instructions="You are helpful.", model=FakeModel(["Noted."]))


async def test_memories_reach_the_model_and_the_turn_reaches_cortadel(
    agent: Agent, fake_client
) -> None:
    fake_client.hits = [hit("Alice's editor is Neovim.")]
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)

    result = await Runner.run(
        agent,
        "What editor do I use?",
        session=session,
        run_config=session.run_config(),
    )

    assert result.final_output == "Noted."

    # (1) recall: the memory block was in the system prompt the model actually received.
    model: FakeModel = agent.model  # type: ignore[assignment]
    assert model.last_instructions is not None
    assert model.last_instructions.startswith("You are helpful.")
    assert "Alice's editor is Neovim." in model.last_instructions

    # …and the search used the question the user just asked.
    assert fake_client.searches[0][0] == "What editor do I use?"

    # (2) persist: the finished exchange was distilled into Cortadel.
    messages, options = fake_client.conversations[0]
    assert [(m.role, m.content) for m in messages] == [
        ("user", "What editor do I use?"),
        ("assistant", "Noted."),
    ]
    assert options is not None and options.session_id == SESSION_ID


async def test_the_injected_block_is_never_written_into_history(
    agent: Agent, fake_client
) -> None:
    """The filter receives a copy, so recall cannot pollute the transcript or re-enter Cortadel."""
    fake_client.hits = [hit("Alice's editor is Neovim.")]
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)

    await Runner.run(agent, "hello", session=session, run_config=session.run_config())

    history = await session.get_items()
    assert [item.get("role") for item in history] == ["user", "assistant"]
    for item in history:
        assert DEFAULT_MEMORY_HEADER not in str(item)

    stored_messages, _ = fake_client.conversations[0]
    for message in stored_messages:
        assert DEFAULT_MEMORY_HEADER not in message.content


async def test_context_does_not_accumulate_memories_across_turns(fake_client) -> None:
    """Injection is ephemeral: turn two carries one memory block, not two."""
    fake_client.hits = [hit("Alice's editor is Neovim.")]
    model = FakeModel(["First.", "Second."])
    agent = Agent(name="Assistant", instructions="You are helpful.", model=model)
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)

    await Runner.run(agent, "turn one", session=session, run_config=session.run_config())
    await Runner.run(agent, "turn two", session=session, run_config=session.run_config())

    assert len(model.calls) == 2
    assert model.calls[1]["system_instructions"].count(DEFAULT_MEMORY_HEADER) == 1

    # History still grew normally, and each turn was stored once.
    assert len(await session.get_items()) == 4
    assert len(fake_client.conversations) == 2


async def test_history_is_replayed_to_the_model_on_the_second_turn(fake_client) -> None:
    model = FakeModel(["First.", "Second."])
    agent = Agent(name="Assistant", model=model)
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)

    await Runner.run(agent, "turn one", session=session)
    await Runner.run(agent, "turn two", session=session)

    second_input = model.last_input
    assert [item.get("role") for item in second_input] == [
        "user",
        "assistant",
        "user",
    ]


async def test_a_run_without_the_run_config_still_stores_but_does_not_recall(
    agent: Agent, fake_client
) -> None:
    """Documented trade-off: recall is a ``RunConfig`` field, so it needs that second wiring."""
    fake_client.hits = [hit("Alice's editor is Neovim.")]
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)

    await Runner.run(agent, "hello", session=session)

    model: FakeModel = agent.model  # type: ignore[assignment]
    assert model.last_instructions == "You are helpful."
    assert fake_client.searches == []
    assert len(fake_client.conversations) == 1


async def test_a_down_cortadel_server_does_not_break_the_run(
    agent: Agent, unreachable_client
) -> None:
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=unreachable_client)

    result = await Runner.run(
        agent, "hello", session=session, run_config=session.run_config()
    )

    assert result.final_output == "Noted."
    assert len(await session.get_items()) == 2
