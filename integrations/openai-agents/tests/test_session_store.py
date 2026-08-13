"""The persist-after-turn path: what reaches ``add_conversation``, and when."""

from __future__ import annotations

import pytest
from conftest import SESSION_ID, USER_ID, FakeCortadelClient
from cortadel import CortadelError
from cortadel_openai_agents import CortadelSession


@pytest.fixture
def session(fake_client) -> CortadelSession:
    return CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)


async def test_a_finished_turn_is_stored_as_a_user_assistant_exchange(
    session: CortadelSession, fake_client
) -> None:
    await session.add_items(
        [
            {"role": "user", "content": "I use Neovim."},
            {"role": "assistant", "content": "Noted."},
        ]
    )

    assert len(fake_client.conversations) == 1
    messages, options = fake_client.conversations[0]
    assert [(m.role, m.content) for m in messages] == [
        ("user", "I use Neovim."),
        ("assistant", "Noted."),
    ]
    assert options is not None
    assert options.session_id == SESSION_ID


async def test_nothing_is_stored_until_the_assistant_replies(
    session: CortadelSession, fake_client
) -> None:
    """Buffering keeps a turn coherent instead of shipping two half-exchanges."""
    await session.add_items([{"role": "user", "content": "I use Neovim."}])
    assert fake_client.conversations == []

    await session.add_items([{"role": "assistant", "content": "Noted."}])
    messages, _ = fake_client.conversations[0]
    assert [m.role for m in messages] == ["user", "assistant"]


async def test_tool_plumbing_is_not_stored_as_memory(
    session: CortadelSession, fake_client
) -> None:
    await session.add_items(
        [
            {"role": "user", "content": "What is the weather?"},
            {"type": "function_call", "call_id": "c1", "name": "weather", "arguments": "{}"},
        ]
    )
    assert fake_client.conversations == []

    await session.add_items(
        [
            {"type": "function_call_output", "call_id": "c1", "output": "sunny"},
            {"role": "assistant", "content": "It is sunny."},
        ]
    )

    messages, _ = fake_client.conversations[0]
    assert [(m.role, m.content) for m in messages] == [
        ("user", "What is the weather?"),
        ("assistant", "It is sunny."),
    ]


async def test_multi_part_assistant_content_is_flattened(
    session: CortadelSession, fake_client
) -> None:
    await session.add_items(
        [
            {"role": "user", "content": [{"type": "input_text", "text": "Hi"}]},
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "Hello", "annotations": []}],
            },
        ]
    )

    messages, _ = fake_client.conversations[0]
    assert [(m.role, m.content) for m in messages] == [("user", "Hi"), ("assistant", "Hello")]


async def test_empty_and_system_items_are_skipped(
    session: CortadelSession, fake_client
) -> None:
    await session.add_items(
        [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "   "},
            {"role": "assistant", "content": "Hi"},
        ]
    )

    messages, _ = fake_client.conversations[0]
    assert [(m.role, m.content) for m in messages] == [("assistant", "Hi")]


async def test_tags_and_project_are_forwarded(fake_client) -> None:
    session = CortadelSession(
        session_id=SESSION_ID,
        user_id=USER_ID,
        client=fake_client,
        tags=["support"],
        project="acme",
    )
    await session.add_items(
        [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    )

    _, options = fake_client.conversations[0]
    assert options is not None
    assert options.tags == ["support"]
    assert options.project == "acme"


async def test_store_false_disables_writes_but_keeps_history(fake_client) -> None:
    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=fake_client, store=False
    )
    await session.add_items(
        [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    )

    assert fake_client.conversations == []
    assert len(await session.get_items()) == 2


async def test_pop_item_drops_an_unflushed_message(
    session: CortadelSession, fake_client
) -> None:
    await session.add_items([{"role": "user", "content": "oops, ignore me"}])
    await session.pop_item()

    await session.add_items(
        [{"role": "user", "content": "real question"}, {"role": "assistant", "content": "answer"}]
    )

    messages, _ = fake_client.conversations[0]
    assert [m.content for m in messages] == ["real question", "answer"]


async def test_flush_sends_a_turn_that_never_got_an_assistant_reply(
    session: CortadelSession, fake_client
) -> None:
    await session.add_items([{"role": "user", "content": "stranded"}])
    assert fake_client.conversations == []

    await session.flush()

    messages, _ = fake_client.conversations[0]
    assert [m.content for m in messages] == ["stranded"]

    # Flushing twice must not re-send the same batch.
    await session.flush()
    assert len(fake_client.conversations) == 1


async def test_an_unreachable_server_does_not_break_the_turn(unreachable_client) -> None:
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=unreachable_client)

    await session.add_items(
        [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    )

    assert unreachable_client.conversations, "the write was attempted"
    assert len(await session.get_items()) == 2, "history survived the failure"


async def test_raise_on_error_surfaces_the_failure(unreachable_client) -> None:
    session = CortadelSession(
        session_id=SESSION_ID,
        user_id=USER_ID,
        client=unreachable_client,
        raise_on_error=True,
    )

    with pytest.raises(CortadelError) as excinfo:
        await session.add_items(
            [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        )
    assert excinfo.value.code == "transport_error"


async def test_await_persist_defers_the_write_until_the_session_is_drained(
    fake_client,
) -> None:
    """``await_persist=False`` takes Cortadel's extraction latency off the turn."""
    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=fake_client, await_persist=False
    )

    await session.add_items(
        [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    )
    assert fake_client.conversations == [], "the turn returned without waiting for the write"

    await session.flush()

    assert len(fake_client.conversations) == 1, "flush drained the background write"
    messages, _ = fake_client.conversations[0]
    assert [m.content for m in messages] == ["a", "b"]

    # Draining twice must not re-send it.
    await session.aclose()
    assert len(fake_client.conversations) == 1


async def test_a_background_write_failure_is_reported_not_raised(unreachable_client) -> None:
    """Nothing awaits a background write, so ``raise_on_error`` cannot apply to one."""
    seen: list[Exception] = []
    session = CortadelSession(
        session_id=SESSION_ID,
        user_id=USER_ID,
        client=unreachable_client,
        await_persist=False,
        raise_on_error=True,
        on_error=seen.append,
    )

    await session.add_items(
        [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    )
    await session.aclose()

    assert [type(exc) for exc in seen] == [CortadelError]


async def test_on_error_sees_write_failures(unreachable_client, caplog) -> None:
    seen: list[Exception] = []
    session = CortadelSession(
        session_id=SESSION_ID, user_id=USER_ID, client=unreachable_client, on_error=seen.append
    )

    with caplog.at_level("WARNING", logger="cortadel_openai_agents"):
        await session.add_items(
            [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        )

    assert [exc.code for exc in seen] == ["transport_error"]  # type: ignore[attr-defined]
    assert caplog.text == ""


async def test_aclose_flushes_and_closes_only_what_it_owns(fake_client) -> None:
    session = CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)
    await session.add_items([{"role": "user", "content": "unflushed"}])

    await session.aclose()

    assert fake_client.conversations, "aclose flushed the buffer"
    assert fake_client.closed is False, "a caller-supplied client is the caller's to close"


async def test_async_context_manager_closes_the_client_it_created(monkeypatch) -> None:
    created = FakeCortadelClient()
    monkeypatch.setattr(
        "cortadel_openai_agents.session.build_client", lambda *a, **k: created
    )

    async with CortadelSession(session_id=SESSION_ID, user_id=USER_ID) as session:
        assert session.client is created

    assert created.closed is True
