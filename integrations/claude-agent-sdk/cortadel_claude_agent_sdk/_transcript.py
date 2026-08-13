"""Pulls the last user/assistant exchange out of a Claude Agent SDK session transcript.

The ``Stop`` hook input carries ``session_id``, ``cwd`` and ``transcript_path`` but **no message
content** (``StopHookInput`` in ``claude_agent_sdk/types.py`` is exactly
``session_id``/``transcript_path``/``cwd``/``stop_hook_active``), so the turn we want to persist
has to be read back off the transcript.

Two readers, in order:

1. :func:`claude_agent_sdk.get_session_messages` — the SDK's own public reader
   (``_internal/sessions.py``). It resolves the session file, rebuilds the conversation chain via
   ``parentUuid`` and drops ``isMeta``/``isSidechain``/``teamName`` entries
   (``_is_visible_message``), which is exactly the filtering we would otherwise have to
   reimplement. It is a **recent** addition, so it is imported defensively.
2. The raw JSONL at ``transcript_path`` — the file the hook itself named, so there is no session
   lookup to get wrong. Used when the SDK reader is unavailable (older ``claude-agent-sdk``) or
   comes back empty (non-UUID session id, a transcript outside ``~/.claude/projects/``, …).

Everything here is deliberately total: any unreadable, truncated or malformed transcript yields
``None`` rather than an exception, because the only caller is a hook that must never break a
session.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

try:  # pragma: no cover - exercised by whichever claude-agent-sdk is installed
    from claude_agent_sdk import get_session_messages as _get_session_messages
except ImportError:  # pragma: no cover - older claude-agent-sdk without the sessions API
    _get_session_messages = None  # type: ignore[assignment]

__all__ = ["Exchange", "Turn", "last_exchange"]


@dataclass(frozen=True)
class Turn:
    """One side of an exchange: the text plus the transcript uuid that produced it.

    ``uuid`` feeds :attr:`cortadel.ChatMessage.uuid`, which Cortadel keeps as a pointer anchor on
    every fact it extracts — that is what lets a stored memory be traced back to the exact turn.
    """

    role: str
    text: str
    uuid: str | None = None


@dataclass(frozen=True)
class Exchange:
    """The last complete user→assistant pair of a session."""

    user: Turn
    assistant: Turn


@dataclass(frozen=True)
class _Entry:
    """A transcript entry normalised across both readers."""

    type: str
    message: Any
    uuid: str | None
    is_human: bool


def _text_of(message: Any) -> str:
    """Plain text of a transcript message.

    ``message`` is the raw Anthropic API message dict; its ``content`` is either a plain string
    (user turns) or a list of blocks. Only ``text`` blocks count — ``tool_use``/``tool_result``
    /``thinking`` blocks are noise for a memory extractor.
    """
    if isinstance(message, str):
        return message.strip()
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = [
        block["text"]
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ]
    return "\n".join(parts).strip()


def _uuid_of(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _read_via_sdk(session_id: str, cwd: str | None) -> list[_Entry]:
    """Entries from the SDK's own session reader. Its filtering already guarantees every entry is
    a visible, non-sidechain user/assistant message, so all of them count as human-authored."""
    if _get_session_messages is None or not session_id:
        return []
    messages = _get_session_messages(session_id, directory=cwd)
    return [
        _Entry(type=m.type, message=m.message, uuid=_uuid_of(m.uuid), is_human=True)
        for m in messages
    ]


def _read_jsonl(transcript_path: str | None) -> list[_Entry]:
    """Entries parsed straight out of the transcript JSONL, tolerating malformed lines.

    Applies the same visibility filter the SDK reader applies (``isMeta``/``isSidechain``) and
    additionally records whether the entry is human-authored: a user entry carrying an
    ``origin.kind`` other than ``"human"`` (a task notification, say) is a machine turn. Entries
    with no ``origin`` at all count as human — older transcripts do not carry the field.
    """
    if not transcript_path:
        return []
    raw = Path(transcript_path).read_text(encoding="utf-8")

    entries: list[_Entry] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            continue  # malformed line — skip it, keep the rest of the transcript
        if not isinstance(parsed, dict):
            continue
        if parsed.get("type") not in ("user", "assistant"):
            continue
        if parsed.get("isMeta") or parsed.get("isSidechain"):
            continue
        origin = parsed.get("origin")
        origin_kind = origin.get("kind") if isinstance(origin, dict) else None
        entries.append(
            _Entry(
                type=str(parsed["type"]),
                message=parsed.get("message"),
                uuid=_uuid_of(parsed.get("uuid")),
                is_human=origin_kind is None or origin_kind == "human",
            )
        )
    return entries


def _pair(entries: list[_Entry]) -> Exchange | None:
    """The last assistant turn with text, plus the last user turn with text before it.

    Prefers a human user turn; falls back to the most recent machine-authored one only when the
    exchange has no human turn at all (which is what an agent-to-agent session looks like).
    """
    assistant_index = -1
    assistant: Turn | None = None
    for index in range(len(entries) - 1, -1, -1):
        entry = entries[index]
        if entry.type != "assistant":
            continue
        text = _text_of(entry.message)
        if text:
            assistant_index = index
            assistant = Turn(role="assistant", text=text, uuid=entry.uuid)
            break
    if assistant is None:
        return None

    user: Turn | None = None
    fallback: Turn | None = None
    for index in range(assistant_index - 1, -1, -1):
        entry = entries[index]
        if entry.type != "user":
            continue
        text = _text_of(entry.message)
        if not text:
            continue
        turn = Turn(role="user", text=text, uuid=entry.uuid)
        if entry.is_human:
            user = turn
            break
        if fallback is None:
            fallback = turn

    user = user or fallback
    if user is None:
        return None
    return Exchange(user=user, assistant=assistant)


def last_exchange(
    *,
    session_id: str,
    cwd: str | None = None,
    transcript_path: str | None = None,
    _sdk_reader: Callable[[str, str | None], list[_Entry]] | None = None,
    _jsonl_reader: Callable[[str | None], list[_Entry]] | None = None,
) -> Exchange | None:
    """The last user→assistant exchange of ``session_id``, or ``None`` if there isn't one.

    Never raises: an unreadable transcript, a missing session file or a malformed JSONL all come
    back as ``None``. The two ``_*_reader`` parameters exist only so the tests can drive each
    reader independently; callers should not pass them.
    """
    sdk_reader = _sdk_reader or _read_via_sdk
    jsonl_reader = _jsonl_reader or _read_jsonl

    # Thunks, not results: the fallback must not touch the filesystem when the SDK reader already
    # produced a usable exchange.
    for read in (
        lambda: sdk_reader(session_id, cwd),
        lambda: jsonl_reader(transcript_path),
    ):
        entries = _safely(read)
        if entries:
            exchange = _pair(entries)
            if exchange is not None:
                return exchange
    return None


def _safely(read: Callable[[], list[_Entry]]) -> list[_Entry]:
    try:
        return read()
    except Exception:  # noqa: BLE001 - a transcript reader must never break the session
        return []
