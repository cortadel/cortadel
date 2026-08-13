"""The automatic-memory hooks: retrieve-and-inject on UserPromptSubmit, persist on Stop."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Iterable, Optional

import pytest
from conftest import (
    SESSION_ID,
    FakeCortadel,
    assistant_entry,
    hit,
    prompt_input,
    stop_input,
    user_entry,
    write_transcript,
)
from cortadel import ChatMessage, ConversationOptions, ConversationResult, CortadelError

from cortadel_claude_agent_sdk import CortadelMemory

CONTEXT = {"signal": None}

LONG_USER = "Should we index the memory table on user_id or on created_at for this workload?"
LONG_ASSISTANT = "Index on user_id first — every read is namespace-anchored, so it is the selective column."


@pytest.fixture
def fake() -> FakeCortadel:
    return FakeCortadel(search_results=[hit("mem-a", "Alice ships on Fridays.")])


@pytest.fixture
def memory(fake: FakeCortadel) -> CortadelMemory:
    return CortadelMemory.from_client(fake)


class GatedCortadel(FakeCortadel):
    """A fake whose ``add_conversation`` blocks until released, so a fire-and-forget write is
    observably still in flight when the hook returns."""

    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()

    async def add_conversation(
        self, messages: Iterable[ChatMessage], options: Optional[ConversationOptions] = None
    ) -> ConversationResult:
        await self.release.wait()
        return await super().add_conversation(messages, options)


def transcript_of(tmp_path: Path) -> Path:
    return write_transcript(
        tmp_path / "session.jsonl", [user_entry(LONG_USER), assistant_entry(LONG_ASSISTANT)]
    )


# ── UserPromptSubmit: retrieve and inject ───────────────────────────────────────────────────


async def test_injects_memories_as_additional_context(memory: CortadelMemory) -> None:
    """`additionalContext` must be nested under `hookSpecificOutput` — a top-level key is
    silently ignored by the CLI."""
    output = await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)

    assert output["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    context = output["hookSpecificOutput"]["additionalContext"]
    assert context.startswith("## Relevant Cortadel memories\n")
    assert "[id mem-a] Alice ships on Fridays." in context
    assert output["suppressOutput"] is True


async def test_searches_with_the_submitted_prompt(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)

    assert fake.searches[0][0] == "when does alice ship?"


async def test_recall_does_not_restrict_to_the_current_session(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    """The whole point of long-term memory is recalling across sessions, so session_id is not a
    search filter here even though the hook knows it."""
    await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)

    assert fake.searches[0][1].session_id is None


async def test_scope_recall_to_session_filters_recall_by_the_hook_session_id(
    fake: FakeCortadel,
) -> None:
    memory = CortadelMemory.from_client(fake, scope_recall_to_session=True)

    await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)

    assert fake.searches[0][1].session_id == SESSION_ID


async def test_skips_prompts_below_the_minimum_length(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    assert await memory.on_user_prompt_submit(prompt_input("hi"), None, CONTEXT) == {}
    assert fake.searches == []


@pytest.mark.parametrize("prompt", ["/compact the session", "!git status --porcelain"])
async def test_skips_slash_commands_and_shell_passthrough(
    fake: FakeCortadel, memory: CortadelMemory, prompt: str
) -> None:
    assert await memory.on_user_prompt_submit(prompt_input(prompt), None, CONTEXT) == {}
    assert fake.searches == []


async def test_injects_nothing_when_there_are_no_hits(fake: FakeCortadel) -> None:
    memory = CortadelMemory.from_client(FakeCortadel())

    assert await memory.on_user_prompt_submit(prompt_input("anything at all"), None, CONTEXT) == {}


# ── UserPromptSubmit: not re-injecting the same memories every turn ──────────────────────────


async def test_does_not_reinject_a_memory_within_a_session(memory: CortadelMemory) -> None:
    first = await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)
    second = await memory.on_user_prompt_submit(prompt_input("and what about deploys?"), None, CONTEXT)

    assert "mem-a" in first["hookSpecificOutput"]["additionalContext"]
    assert second == {}


async def test_injects_only_the_memories_not_yet_seen(fake: FakeCortadel, memory: CortadelMemory) -> None:
    await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)
    fake.search_results = [hit("mem-a", "Alice ships on Fridays."), hit("mem-b", "Alice prefers dark mode.")]

    second = await memory.on_user_prompt_submit(prompt_input("and what about deploys?"), None, CONTEXT)

    context = second["hookSpecificOutput"]["additionalContext"]
    assert "mem-b" in context and "mem-a" not in context


async def test_dedup_is_scoped_to_one_session(memory: CortadelMemory) -> None:
    await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)

    other = await memory.on_user_prompt_submit(
        prompt_input("when does alice ship?", session_id="e2e-other-session"), None, CONTEXT
    )

    assert "mem-a" in other["hookSpecificOutput"]["additionalContext"]


async def test_dedup_can_be_turned_off(fake: FakeCortadel) -> None:
    memory = CortadelMemory.from_client(fake, dedupe_injections=False)

    await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)
    second = await memory.on_user_prompt_submit(prompt_input("and what about deploys?"), None, CONTEXT)

    assert "mem-a" in second["hookSpecificOutput"]["additionalContext"]


async def test_injected_block_respects_the_character_budget(fake: FakeCortadel) -> None:
    fake.search_results = [hit(f"mem-{index}", "x" * 250) for index in range(20)]
    memory = CortadelMemory.from_client(fake, top_k=20, max_context_chars=600)

    output = await memory.on_user_prompt_submit(prompt_input("anything at all"), None, CONTEXT)

    assert len(output["hookSpecificOutput"]["additionalContext"]) < 800


# ── UserPromptSubmit: graceful degradation ──────────────────────────────────────────────────


async def test_a_dead_server_does_not_block_the_prompt(fake: FakeCortadel, memory: CortadelMemory) -> None:
    fake.search_error = CortadelError(0, "transport_error", "connection refused")

    assert await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT) == {}


async def test_a_recall_timeout_does_not_block_the_prompt(fake: FakeCortadel) -> None:
    fake.search_error = TimeoutError("too slow")
    memory = CortadelMemory.from_client(fake, recall_timeout=0.01)

    assert await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT) == {}


# ── Stop: persist the turn ──────────────────────────────────────────────────────────────────


async def test_persists_the_last_exchange(fake: FakeCortadel, memory: CortadelMemory, tmp_path: Path) -> None:
    transcript = write_transcript(
        tmp_path / "session.jsonl",
        [user_entry(LONG_USER, uuid="u-7"), assistant_entry(LONG_ASSISTANT, uuid="a-7")],
    )

    assert await memory.on_stop(stop_input(transcript), None, CONTEXT) == {}

    (messages, options) = fake.conversations[0]
    assert [m.role for m in messages] == ["user", "assistant"]
    assert messages[0].content == LONG_USER and messages[0].uuid == "u-7"
    assert messages[1].content == LONG_ASSISTANT and messages[1].uuid == "a-7"
    assert options is not None


async def test_scopes_the_capture_by_session_project_and_transcript(
    fake: FakeCortadel, memory: CortadelMemory, tmp_path: Path
) -> None:
    transcript = write_transcript(
        tmp_path / "session.jsonl", [user_entry(LONG_USER), assistant_entry(LONG_ASSISTANT)]
    )

    await memory.on_stop(stop_input(transcript), None, CONTEXT)

    options = fake.conversations[0][1]
    assert options.session_id == SESSION_ID
    assert options.project == "demo-project"  # basename of cwd
    assert options.transcript_path == str(transcript)
    assert options.tags == ["claude-agent-sdk"]
    assert options.is_agent_memory is False


async def test_an_explicit_project_overrides_the_cwd_basename(
    fake: FakeCortadel, tmp_path: Path
) -> None:
    memory = CortadelMemory.from_client(fake, project="cortadel")
    transcript = write_transcript(
        tmp_path / "session.jsonl", [user_entry(LONG_USER), assistant_entry(LONG_ASSISTANT)]
    )

    await memory.on_stop(stop_input(transcript), None, CONTEXT)

    assert fake.conversations[0][1].project == "cortadel"


async def test_agent_memory_mode_is_passed_through(fake: FakeCortadel, tmp_path: Path) -> None:
    memory = CortadelMemory.from_client(fake, is_agent_memory=True)
    transcript = write_transcript(
        tmp_path / "session.jsonl", [user_entry(LONG_USER), assistant_entry(LONG_ASSISTANT)]
    )

    await memory.on_stop(stop_input(transcript), None, CONTEXT)

    assert fake.conversations[0][1].is_agent_memory is True


async def test_stop_hook_active_prevents_recursion(
    fake: FakeCortadel, memory: CortadelMemory, tmp_path: Path
) -> None:
    transcript = write_transcript(
        tmp_path / "session.jsonl", [user_entry(LONG_USER), assistant_entry(LONG_ASSISTANT)]
    )

    await memory.on_stop(stop_input(transcript, stop_hook_active=True), None, CONTEXT)

    assert fake.conversations == []


async def test_skips_a_trivial_exchange(fake: FakeCortadel, memory: CortadelMemory, tmp_path: Path) -> None:
    transcript = write_transcript(
        tmp_path / "session.jsonl", [user_entry("ok"), assistant_entry("done")]
    )

    await memory.on_stop(stop_input(transcript), None, CONTEXT)

    assert fake.conversations == []


async def test_skips_a_session_with_no_readable_transcript(
    fake: FakeCortadel, memory: CortadelMemory, tmp_path: Path
) -> None:
    await memory.on_stop(stop_input(tmp_path / "missing.jsonl"), None, CONTEXT)

    assert fake.conversations == []


async def test_truncates_an_oversized_exchange(fake: FakeCortadel, tmp_path: Path) -> None:
    memory = CortadelMemory.from_client(fake, capture_max_chars=8000)
    transcript = write_transcript(
        tmp_path / "session.jsonl",
        [user_entry("u" * 20_000), assistant_entry("a" * 20_000)],
    )

    await memory.on_stop(stop_input(transcript), None, CONTEXT)

    (messages, _) = fake.conversations[0]
    assert len(messages[0].content) == 4000
    assert len(messages[1].content) == 4000


async def test_a_dead_server_does_not_break_session_end(
    fake: FakeCortadel, memory: CortadelMemory, tmp_path: Path
) -> None:
    fake.conversation_error = CortadelError(0, "transport_error", "connection refused")
    transcript = write_transcript(
        tmp_path / "session.jsonl", [user_entry(LONG_USER), assistant_entry(LONG_ASSISTANT)]
    )

    assert await memory.on_stop(stop_input(transcript), None, CONTEXT) == {}


# ── await_persist: whether the write blocks session end ─────────────────────────────────────


async def test_the_capture_is_awaited_by_default(
    fake: FakeCortadel, memory: CortadelMemory, tmp_path: Path
) -> None:
    """`await_persist` defaults to True: the write has landed by the time the hook returns."""
    await memory.on_stop(stop_input(transcript_of(tmp_path)), None, CONTEXT)

    assert len(fake.conversations) == 1


async def test_fire_and_forget_returns_before_the_write_lands(tmp_path: Path) -> None:
    fake = GatedCortadel()
    memory = CortadelMemory.from_client(fake, await_persist=False)

    assert await memory.on_stop(stop_input(transcript_of(tmp_path)), None, CONTEXT) == {}
    assert fake.conversations == []  # still in flight

    fake.release.set()
    await memory.aclose()  # aclose() drains what is still pending

    assert len(fake.conversations) == 1


async def test_a_background_capture_failure_reaches_on_error(tmp_path: Path) -> None:
    fake = GatedCortadel()
    fake.conversation_error = CortadelError(0, "transport_error", "connection refused")
    seen: list[BaseException] = []
    memory = CortadelMemory.from_client(fake, await_persist=False, on_error=seen.append)

    await memory.on_stop(stop_input(transcript_of(tmp_path)), None, CONTEXT)
    fake.release.set()
    await memory.aclose()

    assert [type(exc).__name__ for exc in seen] == ["CortadelError"]


async def test_raise_on_error_cannot_apply_to_a_background_write(tmp_path: Path) -> None:
    """The hook that started it returned long ago, so there is nowhere left to raise into."""
    fake = GatedCortadel()
    fake.conversation_error = CortadelError(0, "transport_error", "connection refused")
    memory = CortadelMemory.from_client(fake, await_persist=False, raise_on_error=True)

    assert await memory.on_stop(stop_input(transcript_of(tmp_path)), None, CONTEXT) == {}
    fake.release.set()
    await memory.aclose()


# ── raise_on_error / on_error ───────────────────────────────────────────────────────────────


async def test_on_error_observes_a_swallowed_recall_failure(fake: FakeCortadel) -> None:
    fake.search_error = CortadelError(0, "transport_error", "connection refused")
    seen: list[BaseException] = []
    memory = CortadelMemory.from_client(fake, on_error=seen.append)

    assert await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT) == {}
    assert [type(exc).__name__ for exc in seen] == ["CortadelError"]


async def test_on_error_observes_a_swallowed_capture_failure(
    fake: FakeCortadel, tmp_path: Path
) -> None:
    fake.conversation_error = CortadelError(0, "transport_error", "connection refused")
    seen: list[BaseException] = []
    memory = CortadelMemory.from_client(fake, on_error=seen.append)

    assert await memory.on_stop(stop_input(transcript_of(tmp_path)), None, CONTEXT) == {}
    assert [type(exc).__name__ for exc in seen] == ["CortadelError"]


async def test_a_swallowed_failure_warns_when_there_is_no_callback(
    fake: FakeCortadel, memory: CortadelMemory, caplog: pytest.LogCaptureFixture
) -> None:
    fake.search_error = CortadelError(0, "transport_error", "connection refused")

    with caplog.at_level(logging.WARNING, logger="cortadel_claude_agent_sdk"):
        await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)

    assert "recall failed" in caplog.text and "connection refused" in caplog.text


async def test_raise_on_error_propagates_a_recall_failure(fake: FakeCortadel) -> None:
    fake.search_error = CortadelError(0, "transport_error", "connection refused")
    memory = CortadelMemory.from_client(fake, raise_on_error=True)

    with pytest.raises(CortadelError):
        await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)


async def test_raise_on_error_propagates_a_capture_failure(
    fake: FakeCortadel, tmp_path: Path
) -> None:
    fake.conversation_error = CortadelError(0, "transport_error", "connection refused")
    memory = CortadelMemory.from_client(fake, raise_on_error=True)

    with pytest.raises(CortadelError):
        await memory.on_stop(stop_input(transcript_of(tmp_path)), None, CONTEXT)


async def test_on_error_still_fires_when_the_failure_is_re_raised(fake: FakeCortadel) -> None:
    fake.search_error = CortadelError(0, "transport_error", "connection refused")
    seen: list[BaseException] = []
    memory = CortadelMemory.from_client(fake, raise_on_error=True, on_error=seen.append)

    with pytest.raises(CortadelError):
        await memory.on_user_prompt_submit(prompt_input("when does alice ship?"), None, CONTEXT)
    assert len(seen) == 1


async def test_a_raising_on_error_callback_cannot_break_the_turn(
    fake: FakeCortadel, caplog: pytest.LogCaptureFixture
) -> None:
    def explode(exc: BaseException) -> None:
        raise RuntimeError("observer exploded")

    fake.search_error = CortadelError(0, "transport_error", "connection refused")
    memory = CortadelMemory.from_client(fake, on_error=explode)

    with caplog.at_level(logging.WARNING, logger="cortadel_claude_agent_sdk"):
        output = await memory.on_user_prompt_submit(
            prompt_input("when does alice ship?"), None, CONTEXT
        )

    assert output == {}
    assert "on_error callback raised" in caplog.text


# ── User scoping and lifecycle ──────────────────────────────────────────────────────────────


async def test_the_user_id_is_bound_at_construction_not_per_call(fake: FakeCortadel) -> None:
    """No Cortadel call takes a user id, so per-user scoping means one memory object per user."""
    from cortadel import SearchOptions

    assert not hasattr(SearchOptions, "user_id")

    memory = CortadelMemory("http://localhost:3001", "e2e-alice")
    assert memory.client._user_id == "e2e-alice"
    await memory.aclose()


async def test_a_bad_configuration_fails_loudly_at_construction() -> None:
    """Everything else fails open, so misconfiguration must not: it would be invisible."""
    with pytest.raises(ValueError, match="(?i)user_id"):
        CortadelMemory("http://localhost:3001", "   ")
    with pytest.raises(ValueError, match="(?i)base_url"):
        CortadelMemory("not a url", "e2e-alice")


async def test_aclose_leaves_a_caller_supplied_client_open(fake: FakeCortadel) -> None:
    memory = CortadelMemory.from_client(fake)

    async with memory:
        pass

    assert fake.closed is False
