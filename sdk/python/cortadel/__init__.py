"""Official Python SDK for Cortadel — self-hosted long-term temporal graph memory for AI agents.

Two facades are exported:

- :class:`CortadelClient` — async, seven methods: ``add``, ``add_conversation``, ``search``,
  ``list``, ``get``, ``delete``, ``health``.
- :class:`SyncCortadelClient` — blocking, same seven methods, same types. See
  ``cortadel.sync_client``'s module docstring for its background-event-loop design.

Only this module's own re-exports are public. ``cortadel._generated`` (the Kiota-generated
transport) is underscore-private by convention — Python has no ``internal`` keyword — and never
appears on either facade's public surface; do not import from it.
"""
from __future__ import annotations

from cortadel.client import CortadelClient
from cortadel.models import (
    AddOptions,
    ChatMessage,
    ConversationIngestItem,
    ConversationOptions,
    ConversationResult,
    CortadelError,
    DEFAULT_LIST_SIZE,
    HealthResult,
    ListOptions,
    MemoryCreated,
    MemoryDetail,
    MemoryList,
    MemoryListItem,
    SearchHit,
    SearchOptions,
    SearchResults,
)
from cortadel.sync_client import SyncCortadelClient

__version__ = "1.2.0"

__all__ = [
    "CortadelClient",
    "SyncCortadelClient",
    "CortadelError",
    "AddOptions",
    "ChatMessage",
    "ConversationIngestItem",
    "ConversationOptions",
    "ConversationResult",
    "DEFAULT_LIST_SIZE",
    "HealthResult",
    "ListOptions",
    "MemoryCreated",
    "MemoryDetail",
    "MemoryList",
    "MemoryListItem",
    "SearchHit",
    "SearchOptions",
    "SearchResults",
    "__version__",
]
