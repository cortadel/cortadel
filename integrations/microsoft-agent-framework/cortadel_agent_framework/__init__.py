# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Cortadel long-term memory for the Microsoft Agent Framework (Python).

Two ways to give an agent memory, both built on the framework's own extension points:

* :class:`CortadelContextProvider` — a ``ContextProvider`` that searches Cortadel before every
  model call and stores the turn after it, so memory is automatic.
* :func:`cortadel_memory_tools` — ``search_memory`` and ``add_memories`` as ``FunctionTool``s the
  agent can call on its own initiative.

They compose: attach the provider for ambient recall and add the tools for deliberate recall.

Cortadel is self-hosted long-term temporal graph memory for AI agents — a bi-temporal graph store
with hybrid BM25 + vector search. See https://cortadel.ai.

Example:
    .. code-block:: python

        from agent_framework import Agent
        from cortadel_agent_framework import CortadelContextProvider

        async with CortadelContextProvider(
            base_url="http://localhost:3001", user_id="e2e-alice"
        ) as memory:
            agent = Agent(client=chat_client, context_providers=[memory])
            reply = await agent.run("What did I say I was working on?")
"""

from ._provider import APP_NAME, CortadelContextProvider
from ._tools import add_memories_tool, cortadel_memory_tools, search_memory_tool

__version__ = "0.1.0"

__all__ = [
    "APP_NAME",
    "CortadelContextProvider",
    "__version__",
    "add_memories_tool",
    "cortadel_memory_tools",
    "search_memory_tool",
]
