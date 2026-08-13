"""Cortadel × CrewAI — long-term temporal graph memory for CrewAI agents.

Three ways in, use any combination:

* :class:`CortadelMemory` — a drop-in ``crewai.Memory`` whose ``recall`` and
  ``remember`` hit a Cortadel server. Pass it to ``Crew(memory=...)`` (or
  ``Agent(memory=...)``, but see the README: agent-level memory is downgraded
  to a plain ``crewai.Memory`` by ``Crew.copy()``, which ``kickoff_for_each``,
  ``train`` and ``test`` all use) and every turn retrieves and stores
  automatically.
* :func:`cortadel_tools` — ``search_memory`` / ``add_memories`` as native
  CrewAI tools, for agents that should decide when to remember.
* :class:`CortadelConversationListener` — an event-bus listener that hands each
  completed task to Cortadel's extraction pipeline via ``add_conversation``.

Quickstart::

    from crewai import Agent, Crew, Task
    from cortadel_crewai import CortadelMemory

    crew = Crew(
        agents=[...],
        tasks=[...],
        memory=CortadelMemory(base_url="http://localhost:3001", user_id="e2e-crewai-demo"),
    )
"""

from __future__ import annotations

from cortadel_crewai.listener import CortadelConversationListener
from cortadel_crewai.memory import CortadelMemory
from cortadel_crewai.tools import (
    AddMemoriesSchema,
    CortadelAddMemoriesTool,
    CortadelSearchMemoryTool,
    SearchMemorySchema,
    cortadel_tools,
)

__version__ = "0.1.0"

__all__ = [
    "AddMemoriesSchema",
    "CortadelAddMemoriesTool",
    "CortadelConversationListener",
    "CortadelMemory",
    "CortadelSearchMemoryTool",
    "SearchMemorySchema",
    "__version__",
    "cortadel_tools",
]
