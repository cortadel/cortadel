"""Translation between pydantic-ai messages and the Cortadel SDK's DTOs.

Kept separate from the capability so both directions are unit-testable without an Agent:

- `chat_messages_from` turns a run's messages into `cortadel.ChatMessage` values for
  `add_conversation`.
- `format_memories` turns `SearchHit`s into the text block injected as instructions.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from cortadel import ChatMessage
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    UserPromptPart,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from cortadel import SearchHit
    from pydantic_ai.messages import ModelMessage
    from pydantic_ai.tools import RunContext

__all__ = [
    "DEFAULT_INSTRUCTIONS_HEADER",
    "chat_messages_from",
    "content_text",
    "format_memories",
    "query_from_context",
]

DEFAULT_INSTRUCTIONS_HEADER = (
    "Relevant long-term memories about this user, recalled from Cortadel. "
    "Treat them as background context you already know: use what is relevant, "
    "and do not mention this list or that you retrieved it."
)


def content_text(content: Any) -> str:
    """Flatten a user-prompt content value to plain text.

    `UserPromptPart.content` is `str | Sequence[UserContent]`, where the sequence can mix text
    with images, audio, documents and cache markers. Only the text carries facts worth storing
    or searching on, so binary parts are dropped rather than stringified.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, (bytes, bytearray)):  # pragma: no cover - not a documented content type
        return ""
    try:
        items = list(content)
    except TypeError:  # pragma: no cover - defensive
        return ""
    chunks = [item.strip() for item in items if isinstance(item, str) and item.strip()]
    return "\n".join(chunks)


def query_from_context(ctx: RunContext[Any]) -> str:
    """The text to search Cortadel with for this run.

    Prefers `ctx.prompt` (the prompt this run was started with). Falls back to the most recent
    user message already in history, which covers runs driven purely by `message_history=`.
    """
    query = content_text(getattr(ctx, "prompt", None))
    if query:
        return query
    for message in reversed(list(getattr(ctx, "messages", []) or [])):
        if not isinstance(message, ModelRequest):
            continue
        for part in reversed(list(message.parts)):
            if isinstance(part, UserPromptPart):
                text = content_text(part.content)
                if text:
                    return text
    return ""


def format_memories(hits: Sequence[SearchHit], header: str = DEFAULT_INSTRUCTIONS_HEADER) -> Optional[str]:
    """Render search hits as an instructions block, or `None` when there is nothing to say.

    Returning `None` matters: pydantic-ai drops instruction functions that return `None`
    entirely, so an empty recall adds no tokens and no empty-section noise to the prompt.
    """
    lines = []
    seen: set[str] = set()
    for hit in hits:
        text = (hit.content or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        lines.append(f"- {text}")
    if not lines:
        return None
    return "\n".join([header, "", *lines])


def chat_messages_from(messages: Sequence[ModelMessage]) -> list[ChatMessage]:
    """Convert run messages into Cortadel `ChatMessage`s.

    Only the conversational surface is kept — user prompts and the assistant's text. Tool calls,
    tool returns and thinking parts are mechanics, not facts about the user, and system prompts
    are agent configuration rather than something to remember.

    Callers should pass `AgentRunResult.new_messages()` (this run's messages) rather than
    `all_messages()`; otherwise every turn re-sends the whole conversation.
    """
    out: list[ChatMessage] = []
    for message in messages:
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if isinstance(part, UserPromptPart):
                    text = content_text(part.content)
                    if text:
                        out.append(ChatMessage(role="user", content=text))
                elif isinstance(part, SystemPromptPart):
                    continue
        elif isinstance(message, ModelResponse):
            chunks = [
                part.content.strip()
                for part in message.parts
                if isinstance(part, TextPart) and part.content and part.content.strip()
            ]
            if chunks:
                out.append(ChatMessage(role="assistant", content="\n\n".join(chunks)))
    return out
