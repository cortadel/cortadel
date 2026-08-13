"""History fidelity: the four ``Session`` methods must behave like a transcript store.

The runner rewinds, retries and pops through these methods and matches items by fingerprint
(``agents/run_internal/session_persistence.py``), so anything lossy here corrupts a run. That is
precisely why history is delegated to a real transcript session and Cortadel is never asked to
replay conversation items.
"""

from __future__ import annotations

import pytest
from conftest import SESSION_ID, USER_ID, hit
from cortadel_openai_agents import CortadelSession


@pytest.fixture
def session(fake_client) -> CortadelSession:
    return CortadelSession(session_id=SESSION_ID, user_id=USER_ID, client=fake_client)


async def test_items_round_trip_verbatim(session: CortadelSession) -> None:
    items = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there"},
    ]
    await session.add_items(items)

    assert await session.get_items() == items


async def test_duplicate_turns_are_both_preserved(session: CortadelSession) -> None:
    """Cortadel deduplicates facts by design; a transcript must not."""
    await session.add_items([{"role": "user", "content": "ping"}])
    await session.add_items([{"role": "user", "content": "ping"}])

    assert len(await session.get_items()) == 2


async def test_get_items_honours_limit(session: CortadelSession) -> None:
    await session.add_items(
        [
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "three"},
        ]
    )

    assert await session.get_items(limit=1) == [{"role": "user", "content": "three"}]


async def test_get_items_injects_nothing(session: CortadelSession, fake_client) -> None:
    """Recall belongs to the input filter. ``get_items`` must stay a pure passthrough."""
    fake_client.hits = [hit("Alice prefers dark mode.")]
    await session.add_items([{"role": "user", "content": "hello"}])

    assert await session.get_items() == [{"role": "user", "content": "hello"}]
    assert fake_client.searches == []


async def test_pop_item_returns_the_latest_then_empties(session: CortadelSession) -> None:
    await session.add_items(
        [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    )

    assert await session.pop_item() == {"role": "assistant", "content": "b"}
    assert await session.pop_item() == {"role": "user", "content": "a"}
    assert await session.pop_item() is None


async def test_clear_session_empties_history_but_keeps_cortadel_memories(
    session: CortadelSession, fake_client
) -> None:
    await session.add_items(
        [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    )
    assert fake_client.conversations, "the finished turn should have been stored"

    await session.clear_session()

    assert await session.get_items() == []
    # Clearing a chat window is not a request to forget the user: no delete is issued.
    assert fake_client.deletes == []


async def test_a_supplied_transcript_is_used_instead_of_the_default(fake_client) -> None:
    from agents import SQLiteSession

    transcript = SQLiteSession("supplied")
    try:
        session = CortadelSession(
            session_id=SESSION_ID, user_id=USER_ID, client=fake_client, transcript=transcript
        )
        await session.add_items([{"role": "user", "content": "hello"}])

        assert await transcript.get_items() == [{"role": "user", "content": "hello"}]
    finally:
        transcript.close()


async def test_constructor_rejects_missing_identity(fake_client) -> None:
    with pytest.raises(ValueError, match="session_id is required"):
        CortadelSession(session_id="", user_id=USER_ID, client=fake_client)
    with pytest.raises(ValueError, match="user_id is required"):
        CortadelSession(session_id=SESSION_ID, user_id="", client=fake_client)
    with pytest.raises(ValueError, match="inject_as"):
        CortadelSession(
            session_id=SESSION_ID,
            user_id=USER_ID,
            client=fake_client,
            inject_as="somewhere-else",  # type: ignore[arg-type]
        )
