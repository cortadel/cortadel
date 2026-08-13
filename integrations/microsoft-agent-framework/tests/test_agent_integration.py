# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""End-to-end tests through a real ``Agent``, with a fake chat client instead of a real model.

Everything else in this suite calls the hooks directly. That proves the hooks behave, but not
that Agent Framework will ever *call* them. These tests drive a genuine ``agent_framework.Agent``
so the framework's own pipeline decides when the provider fires and what the model receives —
the thing that actually breaks when the framework changes its extension point.

Still fully offline: the chat client is a local stub, and Cortadel is the same fake used elsewhere.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agent_framework import Agent, AgentSession, ChatResponse, Message
from conftest import CortadelError, FakeCortadelClient, hit

from cortadel_agent_framework import CortadelContextProvider


class FakeChatClient:
    """A stand-in chat client satisfying ``SupportsChatGetResponse``.

    Records every message the framework hands the model, so tests can assert on exactly what the
    model would have seen.
    """

    def __init__(self, reply: str = "Understood.") -> None:
        self.reply = reply
        self.seen: list[list[Message]] = []

    async def get_response(self, messages: Sequence[Message], **kwargs: Any) -> ChatResponse:
        self.seen.append(list(messages))
        return ChatResponse(messages=[Message("assistant", [self.reply])])

    @property
    def last_prompt(self) -> str:
        """All text from the most recent model call, concatenated."""
        return "\n".join(m.text for m in self.seen[-1] if m.text)


def build(
    cortadel: FakeCortadelClient, **kwargs: Any
) -> tuple[Agent, FakeChatClient, CortadelContextProvider]:
    """Wire a real Agent around the provider and a fake chat client."""
    chat = FakeChatClient()
    provider = CortadelContextProvider(client=cortadel, **kwargs)  # type: ignore[arg-type]
    agent = Agent(client=chat, context_providers=[provider])  # type: ignore[arg-type]
    return agent, chat, provider


async def test_agent_run_injects_memories_into_the_real_prompt() -> None:
    """The framework must call before_run and put our memories in front of the model."""
    cortadel = FakeCortadelClient(hits=[hit("m1", "Alex ships on Fridays")])
    agent, chat, _ = build(cortadel)

    await agent.run("When should we release?", session=AgentSession())

    assert cortadel.search_calls[0][0] == "When should we release?"
    assert "Alex ships on Fridays" in chat.last_prompt
    assert "## Memories" in chat.last_prompt


async def test_agent_run_stores_the_turn() -> None:
    """The framework must call after_run, with the model's reply attached."""
    cortadel = FakeCortadelClient()
    agent, _, _ = build(cortadel)

    await agent.run("I prefer dark mode", session=AgentSession())

    messages, options = cortadel.add_conversation_calls[0]
    assert [(m.role, m.content) for m in messages] == [
        ("user", "I prefer dark mode"),
        ("assistant", "Understood."),
    ]
    assert options is not None and options.session_id is not None


async def test_session_id_flows_from_the_framework_to_cortadel() -> None:
    """Agent Framework's session id is what Cortadel groups the stored facts by."""
    cortadel = FakeCortadelClient()
    agent, _, _ = build(cortadel)
    session = AgentSession(session_id="e2e-session-xyz")

    await agent.run("hello", session=session)

    assert cortadel.add_conversation_calls[0][1].session_id == "e2e-session-xyz"  # type: ignore[union-attr]


async def test_memories_are_injected_once_across_two_real_turns() -> None:
    """Deduplication has to survive the framework's own state round-trip."""
    cortadel = FakeCortadelClient(hits=[hit("m1", "Alex ships on Fridays")])
    agent, chat, _ = build(cortadel)
    session = AgentSession()

    await agent.run("turn one", session=session)
    assert "Alex ships on Fridays" in chat.last_prompt

    await agent.run("turn two", session=session)
    assert "Alex ships on Fridays" not in chat.last_prompt


async def test_dedup_state_lands_in_the_session_under_our_source_id() -> None:
    """The framework hands each provider `session.state[source_id]`; that is where state lives."""
    cortadel = FakeCortadelClient(hits=[hit("m1", "a fact")])
    agent, _, _ = build(cortadel, source_id="cortadel-main")
    session = AgentSession()

    await agent.run("hello", session=session)

    assert session.state["cortadel-main"]["injected_memory_ids"] == ["m1"]


async def test_a_real_run_stores_only_the_turn_not_the_injected_context() -> None:
    """What actually reaches Cortadel from a real run is the turn, and nothing else.

    Scope note, so this test is not read as more than it is: it pins the *framework's* behaviour —
    Agent Framework keeps `context_messages` out of `input_messages`, so `after_run` never sees
    our injected block in the first place. It therefore does **not** exercise the provider's own
    self-injection filter; removing that filter leaves this test green. The filter is covered by
    `test_provider.py::test_after_run_does_not_reingest_own_injection`, which composes the turn
    the way a future pipeline change (or a caller driving the hooks directly) would.

    Both tests are worth having: this one catches the framework changing its mind about where
    provider context lands, the other catches us dropping the guard for when it does.
    """
    cortadel = FakeCortadelClient(hits=[hit("m1", "Alex ships on Fridays")])
    agent, _, _ = build(cortadel)

    await agent.run("when do we release?", session=AgentSession())

    contents = [m.content for m in cortadel.add_conversation_calls[0][0]]
    assert contents == ["when do we release?", "Understood."]
    assert not any("## Memories" in c for c in contents)


async def test_agent_survives_a_total_cortadel_outage() -> None:
    """The headline guarantee: no memory backend, but the agent still answers."""
    cortadel = FakeCortadelClient(
        search_error=CortadelError(0, "transport_error", "connection refused"),
        add_conversation_error=CortadelError(0, "transport_error", "connection refused"),
    )
    agent, _, _ = build(cortadel)

    response = await agent.run("Is anyone there?", session=AgentSession())

    assert response.text == "Understood."


async def test_agent_works_without_an_explicit_session() -> None:
    """`agent.run()` with no session still drives the provider (the framework makes one)."""
    cortadel = FakeCortadelClient(hits=[hit("m1", "a remembered fact")])
    agent, chat, _ = build(cortadel)

    await agent.run("hello")

    assert "a remembered fact" in chat.last_prompt
    assert cortadel.add_conversation_calls
