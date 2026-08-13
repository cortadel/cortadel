"""Cortadel long-term memory for LangGraph.

Cortadel is self-hosted long-term temporal graph memory for AI agents — a bi-temporal graph store
with hybrid BM25 + vector search. This package plugs it into LangGraph three ways:

* :class:`CortadelStore` implements LangGraph's ``BaseStore``, the framework's own long-term
  memory interface, so ``compile(store=...)`` / ``create_react_agent(store=...)`` /
  ``get_store()`` / ``InjectedStore`` all just work.
* :func:`create_memory_tools` exposes ``search_memory`` and ``add_memories`` as
  ``StructuredTool``s the agent can call itself.
* :class:`CortadelMemory` gives automatic memory — recall before the model call, persist after the
  turn — with no tool call required.

>>> from cortadel_langgraph import CortadelStore, namespace_user_id
>>> store = CortadelStore("http://localhost:3001", namespace_user_id(-1))

See the README for the full quickstart.
"""
from __future__ import annotations

from ._namespace import (
    DEFAULT_NAMESPACE,
    NamespaceLike,
    UserIdResolver,
    as_namespace,
    namespace_user_id,
    resolve_namespace,
)
from .memory import DEFAULT_RECALL_HEADER, CortadelMemory
from .store import DEFAULT_APP_NAME, DEFAULT_TEXT_KEYS, CortadelStore, ErrorCallback
from .tools import (
    AddMemoriesInput,
    SearchMemoryInput,
    create_add_memories_tool,
    create_memory_tools,
    create_search_memory_tool,
)

__version__ = "0.1.0"

__all__ = [
    "AddMemoriesInput",
    "CortadelMemory",
    "CortadelStore",
    "DEFAULT_APP_NAME",
    "DEFAULT_NAMESPACE",
    "DEFAULT_RECALL_HEADER",
    "DEFAULT_TEXT_KEYS",
    "ErrorCallback",
    "NamespaceLike",
    "SearchMemoryInput",
    "UserIdResolver",
    "__version__",
    "as_namespace",
    "create_add_memories_tool",
    "create_memory_tools",
    "create_search_memory_tool",
    "namespace_user_id",
    "resolve_namespace",
]
