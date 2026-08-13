"""Message adapters between LangChain messages and Cortadel's `ChatMessage`."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from cortadel import ChatMessage

_ROLE_BY_TYPE = {"human": "user", "ai": "assistant"}
"""LangChain `message.type` -> Cortadel role.

`system` is deliberately absent: a deep agent's system prompt is a multi-kilobyte harness
instruction (filesystem tools, subagent protocol, todo discipline) and none of it is a durable
fact about the user. `tool` is absent for the same reason — tool output is transcript noise, and
Cortadel's extraction pipeline works better on the human/assistant dialogue alone.
"""


def message_text(message: Any) -> str:
    """Best-effort plain text for a LangChain message.

    LangChain 1.x exposes `.text` as a property, but older/derived message objects expose it as a
    method, and content can be either a plain string or a list of content blocks. All three shapes
    are handled here so a content-block message never silently persists as `""`.

    The `isinstance(str)` check comes first on purpose: langchain-core 1.x returns a *callable str
    subclass* from `.text` to keep the deprecated `.text()` call working, so testing `callable()`
    first would take the deprecated branch and emit `LangChainDeprecationWarning` on every message.
    """
    text = getattr(message, "text", None)
    if not isinstance(text, str) and callable(text):
        try:
            text = text()
        except Exception:  # noqa: BLE001 - fall through to the content-based paths
            text = None
    if isinstance(text, str) and text.strip():
        return text.strip()

    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                value = block.get("text")
                if isinstance(value, str):
                    parts.append(value)
        return "\n".join(parts).strip()
    return ""


def latest_user_text(messages: Sequence[Any] | None) -> str | None:
    """Text of the most recent human message — the retrieval query for this turn."""
    for message in reversed(list(messages or ())):
        if getattr(message, "type", None) != "human":
            continue
        text = message_text(message)
        if text:
            return text
    return None


def to_chat_messages(messages: Iterable[Any]) -> list[ChatMessage]:
    """Convert LangChain messages to Cortadel `ChatMessage`s, dropping what shouldn't be stored.

    Skipped: system messages, tool messages, and assistant messages whose only payload is tool
    calls (an `AIMessage` with empty text). What survives is the human/assistant dialogue, which
    is what `add_conversation` distills facts from.
    """
    converted: list[ChatMessage] = []
    for message in messages:
        role = _ROLE_BY_TYPE.get(getattr(message, "type", None) or "")
        if role is None:
            continue
        text = message_text(message)
        if not text:
            continue
        message_id = getattr(message, "id", None)
        converted.append(
            ChatMessage(
                role=role,
                content=text,
                uuid=message_id if isinstance(message_id, str) and message_id else None,
            )
        )
    return converted
