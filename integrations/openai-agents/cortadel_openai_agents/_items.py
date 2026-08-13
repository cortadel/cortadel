"""Helpers for reading the OpenAI Agents SDK's conversation items.

``TResponseInputItem`` is an alias for ``openai.types.responses.ResponseInputItemParam``
(``agents/items.py``: ``TResponseInputItem = ResponseInputItemParam``) — a union of ``TypedDict``\\ s,
so at runtime every item is a plain ``dict``. The runner normalizes items to dicts before they
reach a session (``agents/run_internal/items.py``: ``ensure_input_item_format`` →
``_coerce_to_dict``), but this module still accepts pydantic models and arbitrary objects so a
caller who hands us un-normalized items does not crash the agent.

Only *message* items carry text we can send to Cortadel. Function calls, function-call outputs,
reasoning items and the rest are agent plumbing: they are deliberately dropped rather than stored
as memories.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

__all__ = [
    "ROLES_TO_STORE",
    "item_as_mapping",
    "item_role",
    "item_text",
    "last_user_index",
    "last_user_text",
    "message_pairs",
]

#: Roles whose text is worth persisting as long-term memory. System/developer items are
#: instructions we (or the framework) authored, not things the user or agent said.
ROLES_TO_STORE = ("user", "assistant")

#: Content-part ``type`` values that carry plain text. ``input_text`` is what the user sends,
#: ``output_text`` is what the model produces, ``summary_text`` shows up inside reasoning items,
#: and bare ``text`` appears in some provider shims.
_TEXT_PART_TYPES = ("input_text", "output_text", "text", "summary_text")


def item_as_mapping(item: Any) -> Mapping[str, Any] | None:
    """Return ``item`` as a read-only mapping, or ``None`` if it is not dict-shaped.

    Handles the three shapes an item can realistically arrive in: a ``dict`` (the normal case),
    a pydantic model (``model_dump``), and an object exposing ``__dict__``.
    """
    if isinstance(item, Mapping):
        return item

    dump = getattr(item, "model_dump", None)
    if callable(dump):
        try:
            dumped = dump()
        except Exception:  # pragma: no cover - defensive; a broken model must not kill the run
            return None
        return dumped if isinstance(dumped, Mapping) else None

    raw = getattr(item, "__dict__", None)
    return raw if isinstance(raw, Mapping) else None


def item_role(item: Any) -> str | None:
    """Return the role of a *message* item, or ``None`` for anything else.

    An item counts as a message when it has a ``role`` and either omits ``type`` entirely (the
    shorthand ``{"role": "user", "content": "hi"}``) or sets it to ``"message"`` (the fully
    expanded shape the Responses API returns).
    """
    mapping = item_as_mapping(item)
    if mapping is None:
        return None

    item_type = mapping.get("type")
    if item_type is not None and item_type != "message":
        return None

    role = mapping.get("role")
    return role if isinstance(role, str) else None


def item_text(item: Any) -> str:
    """Extract the plain text of an item, flattening multi-part content.

    Returns an empty string when the item carries no text (an image-only turn, a refusal, a
    tool call). Callers treat empty as "nothing to remember".
    """
    mapping = item_as_mapping(item)
    if mapping is None:
        return ""

    content = mapping.get("content")
    if isinstance(content, str):
        return content.strip()

    if not isinstance(content, (list, tuple)):
        return ""

    chunks: list[str] = []
    for part in content:
        part_mapping = item_as_mapping(part)
        if part_mapping is None:
            if isinstance(part, str):
                chunks.append(part)
            continue
        part_type = part_mapping.get("type")
        if part_type is not None and part_type not in _TEXT_PART_TYPES:
            continue
        text = part_mapping.get("text")
        if isinstance(text, str) and text:
            chunks.append(text)

    return "\n".join(chunks).strip()


def message_pairs(items: Any) -> list[tuple[str, str]]:
    """Return ``(role, text)`` for every storable message item, in order.

    Items that are not messages, carry an unstorable role, or have no text are dropped.
    """
    pairs: list[tuple[str, str]] = []
    for item in items or ():
        role = item_role(item)
        if role not in ROLES_TO_STORE:
            continue
        text = item_text(item)
        if text:
            pairs.append((role, text))
    return pairs


def last_user_index(items: Any) -> int | None:
    """Return the index of the most recent user message that carries text."""
    sequence = list(items or ())
    for index in range(len(sequence) - 1, -1, -1):
        if item_role(sequence[index]) == "user" and item_text(sequence[index]):
            return index
    return None


def last_user_text(items: Any) -> str | None:
    """Return the text of the most recent user message, or ``None`` if there is none.

    This is the retrieval query for the automatic-memory filter: it is the question the model is
    about to answer, which is exactly what we want to search Cortadel for.
    """
    sequence = list(items or ())
    index = last_user_index(sequence)
    return None if index is None else item_text(sequence[index])
