# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Tests for the CortadelContextProvider hooks — retrieval, injection, persistence, failure."""

from __future__ import annotations

import asyncio
import logging

import pytest
from agent_framework import AgentSession, ContextProvider, Message
from conftest import TEST_USER_ID, CortadelError, FakeCortadelClient, hit, make_context

from cortadel_agent_framework import CortadelContextProvider

# No module-level `pytest.mark.asyncio`: `asyncio_mode = "auto"` already collects the async tests,
# and marking the sync ones would emit a PytestWarning that `filterwarnings = ["error"]` escalates.


def provider(client: FakeCortadelClient, **kwargs: object) -> CortadelContextProvider:
    """Build a provider over a fake client."""
    return CortadelContextProvider(client=client, **kwargs)  # type: ignore[arg-type]


# -- Wiring ---------------------------------------------------------------------------------


def test_is_a_context_provider() -> None:
    """It must actually satisfy the framework's extension point, not merely resemble it."""
    instance = provider(FakeCortadelClient())
    assert isinstance(instance, ContextProvider)
    assert instance.source_id == "cortadel"


def test_source_id_is_configurable() -> None:
    """Two providers on one agent need distinct attribution ids."""
    assert provider(FakeCortadelClient(), source_id="memory-a").source_id == "memory-a"


def test_requires_client_or_url_and_user() -> None:
    """Neither a client nor a base_url/user_id pair is a construction error, not a runtime one."""
    with pytest.raises(ValueError, match="base_url"):
        CortadelContextProvider()
    with pytest.raises(ValueError, match="base_url"):
        CortadelContextProvider(base_url="http://localhost:3001")


def test_rejects_bad_inject_as() -> None:
    with pytest.raises(ValueError, match="inject_as"):
        provider(FakeCortadelClient(), inject_as="system")


def test_rejects_bad_top_k() -> None:
    with pytest.raises(ValueError, match="top_k"):
        provider(FakeCortadelClient(), top_k=0)


# -- before_run: retrieve then inject -------------------------------------------------------


async def test_before_run_injects_memories(session: AgentSession, state: dict, agent: object) -> None:
    """The retrieve->inject path: hits become an attributed context message."""
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode"), hit("m2", "Ships on Fridays")])
    context = make_context([Message("user", ["What are my preferences?"])])

    await provider(client).before_run(agent=agent, session=session, context=context, state=state)

    assert client.search_calls[0][0] == "What are my preferences?"
    injected = context.context_messages["cortadel"]
    assert len(injected) == 1
    assert "Prefers dark mode" in injected[0].text
    assert "Ships on Fridays" in injected[0].text
    assert "## Memories" in injected[0].text
    # Injecting via `self` records the provider class for downstream observers.
    attribution = injected[0].additional_properties["_attribution"]
    assert attribution["source_id"] == "cortadel"
    assert attribution["source_type"] == "CortadelContextProvider"


async def test_before_run_prefers_gist_over_content(
    session: AgentSession, state: dict, agent: object
) -> None:
    """When the server computed a one-line gist, that is the better line to inject."""
    client = FakeCortadelClient(hits=[hit("m1", "a long rambling memory", gist="Likes concision")])
    context = make_context([Message("user", ["hi"])])

    await provider(client).before_run(agent=agent, session=session, context=context, state=state)

    text = context.context_messages["cortadel"][0].text
    assert "Likes concision" in text
    assert "rambling" not in text


async def test_before_run_can_inject_as_instructions(
    session: AgentSession, state: dict, agent: object
) -> None:
    """`inject_as="instructions"` uses the other real SessionContext seam."""
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode")])
    context = make_context([Message("user", ["hi"])])

    await provider(client, inject_as="instructions").before_run(
        agent=agent, session=session, context=context, state=state
    )

    assert not context.context_messages
    assert len(context.instructions) == 1
    assert "Prefers dark mode" in context.instructions[0]


async def test_before_run_search_options_carry_configuration(
    session: AgentSession, state: dict, agent: object
) -> None:
    """Provider configuration must reach SearchOptions with the SDK's real field names."""
    client = FakeCortadelClient()
    context = make_context([Message("user", ["hi"])])

    await provider(
        client, top_k=3, search_mode="vector", rerank="cross_encoder", memory_type="semantic"
    ).before_run(agent=agent, session=session, context=context, state=state)

    options = client.search_calls[0][1]
    assert options is not None
    assert options.top_k == 3
    assert options.mode == "vector"
    assert options.rerank == "cross_encoder"
    assert options.memory_type == "semantic"
    # Long-term memory is cross-session by default.
    assert options.session_id is None


async def test_automatic_injection_defaults_to_five_memories(
    session: AgentSession, state: dict, agent: object
) -> None:
    """Ambient injection is paid for on every turn, so it retrieves fewer than an explicit search.

    Five for the provider, ten for the `search_memory` tool: the tool only runs when the model
    decided it needed memory, so it can afford a wider net.
    """
    client = FakeCortadelClient()
    await provider(client).before_run(
        agent=agent, session=session, context=make_context([Message("user", ["hi"])]), state=state
    )
    assert client.search_calls[0][1].top_k == 5  # type: ignore[union-attr]


async def test_recall_can_be_scoped_to_the_session(
    session: AgentSession, state: dict, agent: object
) -> None:
    client = FakeCortadelClient()
    context = make_context([Message("user", ["hi"])])

    await provider(client, scope_recall_to_session=True).before_run(
        agent=agent, session=session, context=context, state=state
    )

    assert client.search_calls[0][1].session_id == "e2e-session-1"  # type: ignore[union-attr]


async def test_before_run_skips_empty_input(session: AgentSession, state: dict, agent: object) -> None:
    """No text means no query worth spending a search on."""
    client = FakeCortadelClient(hits=[hit("m1", "unused")])
    context = make_context([Message("user", ["   "])])

    await provider(client).before_run(agent=agent, session=session, context=context, state=state)

    assert client.search_calls == []
    assert not context.context_messages


async def test_before_run_injects_nothing_when_no_hits(
    session: AgentSession, state: dict, agent: object
) -> None:
    """An empty result set must not inject an empty 'Memories' header."""
    client = FakeCortadelClient(hits=[])
    context = make_context([Message("user", ["hi"])])

    await provider(client).before_run(agent=agent, session=session, context=context, state=state)

    assert not context.context_messages


# -- Cross-turn deduplication ---------------------------------------------------------------


async def test_memories_are_not_reinjected_next_turn(
    session: AgentSession, state: dict, agent: object
) -> None:
    """Turn two must not re-pay for context the model already has."""
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode")])
    instance = provider(client)

    first = make_context([Message("user", ["hi"])])
    await instance.before_run(agent=agent, session=session, context=first, state=state)
    assert first.context_messages["cortadel"]

    second = make_context([Message("user", ["hi again"])])
    await instance.before_run(agent=agent, session=session, context=second, state=state)
    assert not second.context_messages


async def test_new_memories_still_arrive_after_dedup(
    session: AgentSession, state: dict, agent: object
) -> None:
    """Deduplication must suppress only what was already sent."""
    client = FakeCortadelClient(hits=[hit("m1", "Old fact")])
    instance = provider(client)

    await instance.before_run(
        agent=agent, session=session, context=make_context([Message("user", ["hi"])]), state=state
    )

    client._hits = [hit("m1", "Old fact"), hit("m2", "New fact")]
    second = make_context([Message("user", ["hi"])])
    await instance.before_run(agent=agent, session=session, context=second, state=state)

    text = second.context_messages["cortadel"][0].text
    assert "New fact" in text
    assert "Old fact" not in text


async def test_dedup_state_is_json_native(session: AgentSession, state: dict, agent: object) -> None:
    """Agent Framework persists AgentSession.state, so a set would break session stores."""
    client = FakeCortadelClient(hits=[hit("m1", "fact")])
    await provider(client).before_run(
        agent=agent, session=session, context=make_context([Message("user", ["hi"])]), state=state
    )
    assert state["injected_memory_ids"] == ["m1"]
    assert isinstance(state["injected_memory_ids"], list)


async def test_dedup_state_is_bounded(session: AgentSession, state: dict, agent: object) -> None:
    """A long conversation must not grow provider state without limit."""
    instance = provider(FakeCortadelClient(), max_remembered_ids=2)
    instance._remember([hit(f"m{i}", "x") for i in range(5)], state)
    assert state["injected_memory_ids"] == ["m3", "m4"]


async def test_a_zero_cap_remembers_nothing(session: AgentSession, state: dict, agent: object) -> None:
    """`max_remembered_ids=0` is the tightest cap, not the absence of one.

    Regression guard: `remembered[-0:]` is the whole list, so a naive truncation makes 0 mean
    *unbounded* — the exact opposite of what the caller asked for, and an unbounded state leak.
    """
    instance = provider(FakeCortadelClient(), max_remembered_ids=0)
    instance._remember([hit(f"m{i}", "x") for i in range(5)], state)
    assert state["injected_memory_ids"] == []

    # And the visible consequence: with nothing remembered, hits stay eligible every turn.
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode")])
    instance = provider(client, max_remembered_ids=0)
    for _ in range(2):
        context = make_context([Message("user", ["hi"])])
        await instance.before_run(agent=agent, session=session, context=context, state=state)
        assert context.context_messages["cortadel"]


async def test_dedup_can_be_disabled(session: AgentSession, state: dict, agent: object) -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode")])
    instance = provider(client, deduplicate_across_turns=False)

    for _ in range(2):
        context = make_context([Message("user", ["hi"])])
        await instance.before_run(agent=agent, session=session, context=context, state=state)
        assert context.context_messages["cortadel"]
    assert state == {}


async def test_corrupt_dedup_state_is_tolerated(
    session: AgentSession, state: dict, agent: object
) -> None:
    """A session store could hand back anything; that must not crash the turn."""
    state["injected_memory_ids"] = "not-a-list"
    client = FakeCortadelClient(hits=[hit("m1", "fact")])

    await provider(client).before_run(
        agent=agent, session=session, context=make_context([Message("user", ["hi"])]), state=state
    )

    assert state["injected_memory_ids"] == ["m1"]


# -- after_run: persist the turn ------------------------------------------------------------


async def test_after_run_stores_the_turn(session: AgentSession, state: dict, agent: object) -> None:
    """The persist path: input plus response reach add_conversation in order."""
    client = FakeCortadelClient()
    context = make_context(
        [Message("user", ["I ship on Fridays"])],
        response_messages=[Message("assistant", ["Noted."])],
    )

    await provider(client).after_run(agent=agent, session=session, context=context, state=state)

    messages, options = client.add_conversation_calls[0]
    assert [(m.role, m.content) for m in messages] == [
        ("user", "I ship on Fridays"),
        ("assistant", "Noted."),
    ]
    assert options is not None
    assert options.session_id == "e2e-session-1"


async def test_after_run_passes_conversation_options(
    session: AgentSession, state: dict, agent: object
) -> None:
    client = FakeCortadelClient()
    context = make_context([Message("user", ["hi"])])

    await provider(
        client, tags=["support"], project="acme", is_agent_memory=True
    ).after_run(agent=agent, session=session, context=context, state=state)

    options = client.add_conversation_calls[0][1]
    assert options is not None
    assert options.tags == ["support"]
    assert options.project == "acme"
    assert options.is_agent_memory is True


async def test_after_run_drops_tool_and_empty_messages(
    session: AgentSession, state: dict, agent: object
) -> None:
    """Tool plumbing is not a memory, and empty text is not a fact."""
    client = FakeCortadelClient()
    context = make_context(
        [Message("user", ["real"]), Message("tool", ["call output"]), Message("user", ["  "])]
    )

    await provider(client).after_run(agent=agent, session=session, context=context, state=state)

    messages = client.add_conversation_calls[0][0]
    assert [m.content for m in messages] == ["real"]


async def test_after_run_does_not_reingest_own_injection(
    session: AgentSession, state: dict, agent: object
) -> None:
    """Retrieved memories must not be stored back as if the user had said them."""
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode")])
    instance = provider(client)
    context = make_context([Message("user", ["hi"])])

    await instance.before_run(agent=agent, session=session, context=context, state=state)
    # Reproduce what the framework does: provider context precedes the input in the sent turn.
    full_turn = context.get_messages(include_input=True)
    stored = make_context(full_turn, response_messages=[Message("assistant", ["ok"])])
    await instance.after_run(agent=agent, session=session, context=stored, state=state)

    contents = [m.content for m in client.add_conversation_calls[0][0]]
    assert contents == ["hi", "ok"]
    assert not any("## Memories" in c for c in contents)


async def test_after_run_skips_when_nothing_to_store(
    session: AgentSession, state: dict, agent: object
) -> None:
    client = FakeCortadelClient()
    context = make_context([Message("tool", ["only plumbing"])])

    await provider(client).after_run(agent=agent, session=session, context=context, state=state)

    assert client.add_conversation_calls == []


async def test_the_write_blocks_the_turn_by_default(
    session: AgentSession, state: dict, agent: object
) -> None:
    """`await_persist` defaults to True: Agent Framework gives a provider no shutdown hook, so a
    turn that returns before the write lands can lose it when the process exits."""
    client = FakeCortadelClient()
    instance = provider(client)

    await instance.after_run(
        agent=agent,
        session=session,
        context=make_context([Message("user", ["hi"])]),
        state=state,
    )

    # Landed by the time after_run returned - no drain needed.
    assert instance.await_persist is True
    assert client.add_conversation_calls


async def test_fire_and_forget_writes_are_flushed_on_close(
    session: AgentSession, state: dict, agent: object
) -> None:
    """`await_persist=False` takes the write off the turn, so closing must wait for it."""
    client = FakeCortadelClient()
    instance = provider(client, await_persist=False)

    await instance.after_run(
        agent=agent,
        session=session,
        context=make_context([Message("user", ["hi"])]),
        state=state,
    )
    assert instance._pending, "the write should still be in flight"

    await instance.aclose()

    assert not instance._pending
    assert [m.content for m in client.add_conversation_calls[0][0]] == ["hi"]


async def test_a_background_write_failure_is_reported_not_lost(
    session: AgentSession, state: dict, agent: object, caplog: pytest.LogCaptureFixture
) -> None:
    """`raise_on_error` has no caller to reach from a background task, so it reports instead.

    Without this the exception would become an unretrieved task exception: invisible to the
    caller and surfaced only by asyncio's own "never retrieved" noise at loop teardown.
    """
    seen: list[Exception] = []
    boom = CortadelError(503, "http_error", "down")
    instance = provider(
        FakeCortadelClient(add_conversation_error=boom),
        await_persist=False,
        raise_on_error=True,
        on_error=seen.append,
    )

    with caplog.at_level(logging.WARNING):
        await instance.after_run(
            agent=agent,
            session=session,
            context=make_context([Message("user", ["hi"])]),
            state=state,
        )
        await instance.aclose()

    assert seen == [boom]


async def test_store_turns_can_be_disabled(session: AgentSession, state: dict, agent: object) -> None:
    """A read-only agent should never write."""
    client = FakeCortadelClient()
    context = make_context([Message("user", ["hi"])])

    await provider(client, store_turns=False).after_run(
        agent=agent, session=session, context=context, state=state
    )

    assert client.add_conversation_calls == []


# -- User-id scoping ------------------------------------------------------------------------


def test_user_id_is_bound_at_construction() -> None:
    """A Cortadel client is per-user; the provider inherits that and exposes it."""
    from cortadel import CortadelClient

    instance = CortadelContextProvider(base_url="http://localhost:3001", user_id=TEST_USER_ID)
    assert isinstance(instance.client, CortadelClient)
    # No hook signature accepts a user id — scoping is structural, not per-call.
    assert "user_id" not in CortadelContextProvider.before_run.__annotations__
    assert "user_id" not in CortadelContextProvider.after_run.__annotations__


def test_invalid_base_url_is_rejected_by_the_sdk() -> None:
    with pytest.raises(ValueError):
        CortadelContextProvider(base_url="not-a-url", user_id=TEST_USER_ID)


# -- Graceful degradation -------------------------------------------------------------------


async def test_search_failure_does_not_break_the_turn(
    session: AgentSession, state: dict, agent: object, caplog: pytest.LogCaptureFixture
) -> None:
    """A memory outage must degrade the agent, not stop it."""
    client = FakeCortadelClient(search_error=CortadelError(0, "transport_error", "boom"))
    context = make_context([Message("user", ["hi"])])

    with caplog.at_level(logging.WARNING):
        await provider(client).before_run(
            agent=agent, session=session, context=context, state=state
        )

    assert not context.context_messages
    assert "Cortadel search failed" in caplog.text


async def test_store_failure_does_not_break_the_turn(
    session: AgentSession, state: dict, agent: object, caplog: pytest.LogCaptureFixture
) -> None:
    client = FakeCortadelClient(add_conversation_error=CortadelError(503, "http_error", "down"))
    context = make_context([Message("user", ["hi"])])

    with caplog.at_level(logging.WARNING):
        await provider(client).after_run(agent=agent, session=session, context=context, state=state)

    assert "add_conversation failed" in caplog.text


class BadMessage:
    """A message-like object whose `.text` blows up.

    Stock framework `Message`s always expose `.text`, but a custom message type or a chat client's
    own subclass need not. Composing the turn is therefore inside the same guard as the network
    call: reading the messages must cost you the memory, not the run.
    """

    role = "user"
    additional_properties: dict = {}

    @property
    def text(self) -> str:
        raise RuntimeError("this message type has no text")


async def test_unreadable_messages_do_not_break_recall(
    session: AgentSession, state: dict, agent: object, caplog: pytest.LogCaptureFixture
) -> None:
    """Building the query is covered by the never-take-the-agent-down guarantee."""
    client = FakeCortadelClient(hits=[hit("m1", "unused")])
    context = make_context([BadMessage()])  # type: ignore[list-item]

    with caplog.at_level(logging.WARNING):
        await provider(client).before_run(
            agent=agent, session=session, context=context, state=state
        )

    assert client.search_calls == []
    assert not context.context_messages
    assert "Cortadel search failed" in caplog.text


async def test_unreadable_messages_do_not_break_storage(
    session: AgentSession, state: dict, agent: object, caplog: pytest.LogCaptureFixture
) -> None:
    """...and so is composing the turn to store."""
    client = FakeCortadelClient()
    context = make_context([BadMessage()])  # type: ignore[list-item]

    with caplog.at_level(logging.WARNING):
        await provider(client).after_run(agent=agent, session=session, context=context, state=state)

    assert client.add_conversation_calls == []
    assert "add_conversation failed" in caplog.text


async def test_failures_can_be_propagated_instead(
    session: AgentSession, state: dict, agent: object
) -> None:
    """`raise_on_error=True` is the opt-in fail-closed mode; fail-open remains the default."""
    boom = CortadelError(0, "transport_error", "boom")
    context = make_context([Message("user", ["hi"])])

    with pytest.raises(CortadelError):
        await provider(
            FakeCortadelClient(search_error=boom), raise_on_error=True
        ).before_run(agent=agent, session=session, context=context, state=state)

    with pytest.raises(CortadelError):
        await provider(
            FakeCortadelClient(add_conversation_error=boom), raise_on_error=True
        ).after_run(agent=agent, session=session, context=context, state=state)


async def test_on_error_observes_failures_and_replaces_the_log(
    session: AgentSession, state: dict, agent: object, caplog: pytest.LogCaptureFixture
) -> None:
    """`on_error` is a callback. Setting one replaces the warning rather than adding to it."""
    seen: list[Exception] = []
    boom = CortadelError(503, "http_error", "down")
    client = FakeCortadelClient(search_error=boom, add_conversation_error=boom)
    instance = provider(client, on_error=seen.append)
    context = make_context([Message("user", ["hi"])])

    with caplog.at_level(logging.WARNING):
        await instance.before_run(agent=agent, session=session, context=context, state=state)
        await instance.after_run(agent=agent, session=session, context=context, state=state)

    assert seen == [boom, boom]
    assert "Cortadel search failed" not in caplog.text
    assert "add_conversation failed" not in caplog.text


async def test_a_raising_on_error_callback_cannot_break_the_turn(
    session: AgentSession, state: dict, agent: object, caplog: pytest.LogCaptureFixture
) -> None:
    """An observer must not become the thing that takes the agent down."""

    def explode(exc: Exception) -> None:
        raise RuntimeError("the telemetry sink is down too")

    client = FakeCortadelClient(search_error=CortadelError(0, "transport_error", "boom"))
    context = make_context([Message("user", ["hi"])])

    with caplog.at_level(logging.WARNING):
        await provider(client, on_error=explode).before_run(
            agent=agent, session=session, context=context, state=state
        )

    assert not context.context_messages
    assert "on_error callback raised" in caplog.text


async def test_cancellation_is_never_swallowed(
    session: AgentSession, state: dict, agent: object
) -> None:
    """Cancellation is the caller's intent, not a Cortadel failure."""
    context = make_context([Message("user", ["hi"])])

    with pytest.raises(asyncio.CancelledError):
        await provider(FakeCortadelClient(search_error=asyncio.CancelledError())).before_run(
            agent=agent, session=session, context=context, state=state
        )

    with pytest.raises(asyncio.CancelledError):
        await provider(
            FakeCortadelClient(add_conversation_error=asyncio.CancelledError())
        ).after_run(agent=agent, session=session, context=context, state=state)


# -- Lifecycle ------------------------------------------------------------------------------


async def test_owned_client_is_closed_but_borrowed_one_is_not() -> None:
    """Mirrors the Cortadel SDK's own aclose() contract: you close what you created."""
    borrowed = FakeCortadelClient()
    async with provider(borrowed):
        pass
    assert borrowed.closed is False

    owned = CortadelContextProvider(base_url="http://localhost:3001", user_id=TEST_USER_ID)
    async with owned:
        pass
    # Closing a never-used client is a no-op that must not raise.
