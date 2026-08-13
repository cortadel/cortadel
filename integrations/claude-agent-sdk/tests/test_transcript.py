"""Reading the last exchange back out of a session transcript.

The Stop hook input has no message content, so this is where the turn actually comes from. The SDK
reader (`get_session_messages`) is preferred; these tests drive both it and the JSONL fallback.
"""
from __future__ import annotations

from pathlib import Path

from conftest import assistant_entry, user_entry, write_transcript

from cortadel_claude_agent_sdk._transcript import _Entry, last_exchange


def read(path: Path, *, session_id: str = "e2e-not-a-uuid") -> object:
    """Force the JSONL fallback by using a session id the SDK reader will reject."""
    return last_exchange(session_id=session_id, cwd=None, transcript_path=str(path))


def test_reads_the_last_user_assistant_pair(tmp_path: Path) -> None:
    transcript = write_transcript(
        tmp_path / "t.jsonl",
        [
            user_entry("first question", uuid="u-1"),
            assistant_entry("first answer", uuid="a-1"),
            user_entry("second question", uuid="u-2"),
            assistant_entry("second answer", uuid="a-2"),
        ],
    )

    exchange = read(transcript)

    assert exchange.user.text == "second question" and exchange.user.uuid == "u-2"
    assert exchange.assistant.text == "second answer" and exchange.assistant.uuid == "a-2"


def test_keeps_only_text_blocks(tmp_path: Path) -> None:
    """tool_use / thinking blocks are noise for a memory extractor."""
    transcript = write_transcript(
        tmp_path / "t.jsonl",
        [
            user_entry("question"),
            {
                "type": "assistant",
                "uuid": "a-1",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "hmm"},
                        {"type": "text", "text": "the answer"},
                        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
                    ],
                },
            },
        ],
    )

    assert read(transcript).assistant.text == "the answer"


def test_skips_the_trailing_tool_only_assistant_turn(tmp_path: Path) -> None:
    transcript = write_transcript(
        tmp_path / "t.jsonl",
        [
            user_entry("question"),
            assistant_entry("the answer", uuid="a-1"),
            {
                "type": "assistant",
                "uuid": "a-2",
                "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]},
            },
        ],
    )

    assert read(transcript).assistant.uuid == "a-1"


def test_skips_meta_and_sidechain_entries(tmp_path: Path) -> None:
    """Same visibility filter the SDK's own reader applies (`_is_visible_message`)."""
    transcript = write_transcript(
        tmp_path / "t.jsonl",
        [
            user_entry("the real question", uuid="u-1"),
            user_entry("injected system context", uuid="u-2", isMeta=True),
            user_entry("subagent chatter", uuid="u-3", isSidechain=True),
            assistant_entry("the answer"),
        ],
    )

    assert read(transcript).user.uuid == "u-1"


def test_prefers_a_human_turn_over_a_machine_origin_turn(tmp_path: Path) -> None:
    transcript = write_transcript(
        tmp_path / "t.jsonl",
        [
            user_entry("the real question", uuid="u-1"),
            user_entry("task finished", uuid="u-2", origin={"kind": "task-notification"}),
            assistant_entry("the answer"),
        ],
    )

    assert read(transcript).user.uuid == "u-1"


def test_falls_back_to_a_machine_turn_when_there_is_no_human_one(tmp_path: Path) -> None:
    transcript = write_transcript(
        tmp_path / "t.jsonl",
        [
            user_entry("task finished", uuid="u-2", origin={"kind": "task-notification"}),
            assistant_entry("the answer"),
        ],
    )

    assert read(transcript).user.uuid == "u-2"


def test_tolerates_malformed_lines(tmp_path: Path) -> None:
    path = tmp_path / "t.jsonl"
    path.write_text(
        '{"type":"user","uuid":"u-1","message":{"role":"user","content":"question"}}\n'
        "{ this is not json\n"
        "\n"
        '{"type":"assistant","uuid":"a-1","message":{"role":"assistant","content":"answer"}}\n',
        encoding="utf-8",
    )

    exchange = read(path)

    assert exchange.user.text == "question" and exchange.assistant.text == "answer"


def test_returns_none_for_a_missing_transcript(tmp_path: Path) -> None:
    assert read(tmp_path / "nope.jsonl") is None


def test_returns_none_when_there_is_no_assistant_turn(tmp_path: Path) -> None:
    transcript = write_transcript(tmp_path / "t.jsonl", [user_entry("question")])

    assert read(transcript) is None


def test_returns_none_when_there_is_no_user_turn(tmp_path: Path) -> None:
    transcript = write_transcript(tmp_path / "t.jsonl", [assistant_entry("answer")])

    assert read(transcript) is None


def test_the_sdk_reader_wins_when_it_returns_entries(tmp_path: Path) -> None:
    """The JSONL fallback must not run when `get_session_messages` already found the session."""
    transcript = write_transcript(
        tmp_path / "t.jsonl", [user_entry("from jsonl"), assistant_entry("from jsonl")]
    )
    jsonl_calls: list[object] = []

    exchange = last_exchange(
        session_id="e2e-session",
        cwd="/work/demo",
        transcript_path=str(transcript),
        _sdk_reader=lambda session_id, cwd: [
            _Entry(type="user", message={"role": "user", "content": "from sdk"}, uuid="u-9", is_human=True),
            _Entry(
                type="assistant",
                message={"role": "assistant", "content": "sdk answer"},
                uuid="a-9",
                is_human=True,
            ),
        ],
        _jsonl_reader=lambda path: jsonl_calls.append(path) or [],  # type: ignore[func-returns-value]
    )

    assert exchange.user.text == "from sdk" and exchange.assistant.uuid == "a-9"
    assert jsonl_calls == []


def test_falls_back_to_jsonl_when_the_sdk_reader_raises(tmp_path: Path) -> None:
    """An older claude-agent-sdk, a session outside ~/.claude/projects, a non-UUID id — all the
    same to the caller: the transcript the hook named is read directly."""
    transcript = write_transcript(
        tmp_path / "t.jsonl", [user_entry("from jsonl"), assistant_entry("jsonl answer")]
    )

    def boom(session_id: str, cwd: str | None) -> list[_Entry]:
        raise RuntimeError("sessions API unavailable")

    exchange = last_exchange(
        session_id="e2e-session",
        cwd=None,
        transcript_path=str(transcript),
        _sdk_reader=boom,
    )

    assert exchange.assistant.text == "jsonl answer"
