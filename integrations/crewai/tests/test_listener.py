"""The event-bus listener that persists completed tasks via add_conversation."""

from __future__ import annotations

import pytest
from cortadel import ConversationResult
from crewai.events.types.task_events import TaskCompletedEvent
from crewai.tasks.task_output import TaskOutput

from cortadel_crewai import CortadelConversationListener
from tests.conftest import BrokenCortadelClient, FakeCortadelClient


def make_event(
    description: str = "Summarise the Q3 report.",
    raw: str = "Revenue grew 12% quarter over quarter.",
) -> TaskCompletedEvent:
    return TaskCompletedEvent(
        output=TaskOutput(description=description, raw=raw, agent="analyst")
    )


def test_records_task_as_a_two_turn_conversation(
    fake_client: FakeCortadelClient,
) -> None:
    listener = CortadelConversationListener(client=fake_client, session_id="run-7")

    assert listener.record_task(make_event()) is True

    messages, options = fake_client.conversations[0]
    assert [(m.role, m.content) for m in messages] == [
        ("user", "Summarise the Q3 report."),
        ("assistant", "Revenue grew 12% quarter over quarter."),
    ]
    assert options.session_id == "run-7"
    assert options.is_agent_memory is False


def test_agent_memory_mode_is_forwarded(fake_client: FakeCortadelClient) -> None:
    listener = CortadelConversationListener(
        client=fake_client, is_agent_memory=True, project="acme", tags=["crew"]
    )
    listener.record_task(make_event())

    _, options = fake_client.conversations[0]
    assert options.is_agent_memory is True
    assert options.project == "acme"
    assert options.tags == ["crew"]


def test_skips_trivially_short_output(fake_client: FakeCortadelClient) -> None:
    listener = CortadelConversationListener(client=fake_client, min_output_chars=50)
    assert listener.record_task(make_event(raw="ok")) is False
    assert fake_client.conversations == []


def test_skips_empty_output(fake_client: FakeCortadelClient) -> None:
    listener = CortadelConversationListener(client=fake_client)
    assert listener.record_task(make_event(raw="   ")) is False
    assert fake_client.conversations == []


def test_reports_when_no_facts_were_extracted(fake_client: FakeCortadelClient) -> None:
    fake_client.conversation = ConversationResult(no_facts_extracted=True)
    listener = CortadelConversationListener(client=fake_client)
    assert listener.record_task(make_event()) is False


def test_degrades_when_server_unreachable(
    broken_client: BrokenCortadelClient,
) -> None:
    """A failed memory write must never fail the task that produced it."""
    listener = CortadelConversationListener(client=broken_client)
    assert listener.raise_on_error is False  # fail open by default
    assert listener.record_task(make_event()) is False


def test_raise_on_error_propagates(broken_client: BrokenCortadelClient) -> None:
    from cortadel import CortadelError

    listener = CortadelConversationListener(client=broken_client, raise_on_error=True)
    with pytest.raises(CortadelError):
        listener.record_task(make_event())


def test_on_error_callback_observes_swallowed_failures(
    broken_client: BrokenCortadelClient,
) -> None:
    seen: list[BaseException] = []
    listener = CortadelConversationListener(client=broken_client, on_error=seen.append)

    assert listener.record_task(make_event()) is False
    assert [type(e).__name__ for e in seen] == ["CortadelError"]


def test_subscribes_to_the_real_event_bus(fake_client: FakeCortadelClient) -> None:
    """Registering the listener must actually wire the TaskCompletedEvent handler."""
    from crewai.events import crewai_event_bus

    listener = CortadelConversationListener(client=fake_client)
    assert listener is not None

    # The bus dispatches handlers on a thread pool and hands back a Future, so
    # the Cortadel write happens off the task thread. Wait for it.
    future = crewai_event_bus.emit(object(), make_event())
    if future is not None:
        future.result(timeout=10)

    assert len(fake_client.conversations) == 1


def test_requires_a_user_id() -> None:
    with pytest.raises(ValueError, match="user_id"):
        CortadelConversationListener()
