"""Reading the ambient LangGraph runtime without letting it throw.

``langgraph.config.get_store()`` is the documented way for a node or tool to reach the store the
graph was compiled with, but it is unforgiving about *where* it is called from — its body is
``get_config()[CONF][CONFIG_KEY_RUNTIME].store`` (``langgraph/config.py``), so it raises:

* ``RuntimeError`` when there is no runnable context at all,
* ``KeyError('__pregel_runtime')`` when there is a runnable context but no LangGraph runtime —
  which is exactly what happens when a tool is invoked standalone, e.g. ``tool.invoke({...})`` in a
  unit test,
* and it returns ``None`` when the graph was compiled without a store.

Memory is an enhancement, never a reason for an agent to crash, so this narrows all three to a
single ``None``.
"""
from __future__ import annotations

from typing import Optional

from langgraph.config import get_store
from langgraph.store.base import BaseStore

__all__ = ["ambient_store"]


def ambient_store() -> Optional[BaseStore]:
    """The store the current graph was compiled with, or ``None`` if there isn't one."""
    try:
        return get_store()
    except (RuntimeError, KeyError, AttributeError):
        return None
