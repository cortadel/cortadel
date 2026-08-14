# Copyright 2026 Cortadel
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Translation between ADK's event/memory types and Cortadel's DTOs.

Kept in its own module so the mapping is unit-testable without a client, a
runner, or a server.
"""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Sequence
import hashlib
from typing import Any
from typing import TYPE_CHECKING

from cortadel import ChatMessage
from cortadel import SearchHit
from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types

if TYPE_CHECKING:  # pragma: no cover - import cycle avoidance only
    from google.adk.events.event import Event

MEMORY_AUTHOR = "cortadel"
"""Author stamped on every recalled memory.

ADK's built-in ``preload_memory`` tool renders each entry as
``f"{memory.author}: {text}"``, so this string is what the model sees as the
provenance label of a recalled fact. A Cortadel memory is a *distilled fact*,
not a verbatim utterance, so labelling it ``user`` or with an agent name would
be a lie; ``cortadel`` says exactly where it came from.
"""

_ROLE_USER = "user"
_ROLE_ASSISTANT = "assistant"


def event_text(event: "Event") -> str:
    """Joins the text parts of an event, or returns ``""`` if it has none.

    Function calls, function responses and non-text parts have no ``text``, so
    tool traffic drops out here rather than being shipped to the LLM extractor.
    """
    content = getattr(event, "content", None)
    if content is None or not content.parts:
        return ""
    return " ".join(part.text for part in content.parts if part.text).strip()


def event_role(event: "Event") -> str:
    """Maps an ADK event author onto a Cortadel chat role.

    ADK's ``author`` is either the literal ``"user"`` or an *agent name*, so
    everything that is not the user is the assistant side of the conversation.
    """
    return _ROLE_USER if getattr(event, "author", "") == _ROLE_USER else _ROLE_ASSISTANT


def event_fingerprint(event: "Event") -> str:
    """A stable id for de-duplicating repeat ingestion of the same event.

    ADK assigns ``Event.id`` in the session service, and
    ``BaseMemoryService.add_session_to_memory`` is explicitly allowed to be
    called many times for one session — so without a key like this every turn
    would re-ship the whole transcript. Events that have no id yet (hand-built,
    or a session service that does not assign one) fall back to a digest of
    their observable content.
    """
    event_id = getattr(event, "id", "") or ""
    if event_id:
        return event_id
    raw = "|".join(
        [
            getattr(event, "author", "") or "",
            repr(getattr(event, "timestamp", "") or ""),
            event_text(event),
        ]
    )
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def events_to_messages(events: Iterable["Event"]) -> list[ChatMessage]:
    """Converts ADK events into the Cortadel conversation shape.

    Skips partial streaming chunks (the final aggregated event carries the same
    text) and anything with no text at all.
    """
    messages: list[ChatMessage] = []
    for event in events:
        if getattr(event, "partial", None):
            continue
        text = event_text(event)
        if not text:
            continue
        messages.append(
            ChatMessage(
                role=event_role(event),
                content=text,
                # Cortadel keeps `uuid` as a pointer anchor on every fact
                # extracted from this turn, so a stored memory can be traced
                # back to the exact ADK event that produced it.
                uuid=getattr(event, "id", "") or None,
            )
        )
    return messages


def memory_entry_text(entry: MemoryEntry, splitter: str = " ") -> str:
    """Extracts the text of a ``MemoryEntry``.

    Mirrors ``google.adk.tools._memory_entry_utils.extract_text``, which is
    private, rather than importing it.
    """
    if entry.content is None or not entry.content.parts:
        return ""
    return splitter.join(part.text for part in entry.content.parts if part.text).strip()


def hit_to_memory_entry(hit: SearchHit) -> MemoryEntry:
    """Converts one Cortadel search hit into an ADK ``MemoryEntry``.

    Everything Cortadel knows about the hit that ADK's own model has no field
    for (fusion score, categories, tags, cognitive type, the one-line gist)
    rides along in ``custom_metadata``, so a caller that wants to rank or filter
    still can, while ``preload_memory`` sees only the text.
    """
    metadata: dict[str, Any] = {"source": "cortadel"}
    for key, value in (
        ("memory_id", hit.id),
        ("rrf_score", hit.rrf_score),
        ("categories", hit.categories),
        ("memory_type", hit.memory_type),
        ("tags", hit.tags),
        ("hit_source", hit.source),
        ("gist", hit.gist),
        ("project_id", hit.project_id),
        ("app_name", hit.app_name),
    ):
        if value is not None:
            metadata[key] = value
    if hit.is_global:
        metadata["is_global"] = True

    return MemoryEntry(
        content=types.Content(
            role=_ROLE_USER,
            parts=[types.Part(text=hit.content)],
        ),
        id=hit.id,
        author=MEMORY_AUTHOR,
        # SearchHit.created_at is already an ISO 8601 string on this schema
        # (unlike MemoryListItem/MemoryDetail, which are Unix seconds), and
        # MemoryEntry.timestamp wants ISO 8601 — so it passes straight through.
        timestamp=hit.created_at,
        custom_metadata=metadata,
    )


def hits_to_memory_entries(hits: Sequence[SearchHit]) -> list[MemoryEntry]:
    """Converts a whole result page, dropping hits with empty text."""
    return [hit_to_memory_entry(hit) for hit in hits if hit.content]
