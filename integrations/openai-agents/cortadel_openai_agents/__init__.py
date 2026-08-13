"""Cortadel long-term memory for the OpenAI Agents SDK.

Cortadel is self-hosted long-term temporal graph memory for AI agents: a bi-temporal graph store
with hybrid BM25 + vector search. This package makes it native to ``openai-agents``.

Two ways in, and they compose:

* :class:`CortadelSession` — a ``Session`` that keeps verbatim history locally, distils each
  finished turn into Cortadel, and (via its ``input_filter``) recalls relevant memories into
  every model call automatically.
* :func:`cortadel_memory_tools` — ``search_memory`` and ``add_memories`` as ``FunctionTool``\\ s,
  for agents that decide when to remember.

::

    from agents import Agent, Runner
    from cortadel_openai_agents import CortadelSession

    agent = Agent(name="Assistant", instructions="You are helpful.")
    session = CortadelSession(session_id="chat-1", user_id="e2e-alice")

    result = await Runner.run(
        agent, "What editor do I use?", session=session, run_config=session.run_config()
    )
"""

from __future__ import annotations

from ._memory import DEFAULT_APP_NAME, DEFAULT_BASE_URL, DEFAULT_MEMORY_HEADER
from .session import CortadelSession, InjectionSite
from .tools import cortadel_memory_tools

__version__ = "0.1.0"

__all__ = [
    "CortadelSession",
    "DEFAULT_APP_NAME",
    "DEFAULT_BASE_URL",
    "DEFAULT_MEMORY_HEADER",
    "InjectionSite",
    "cortadel_memory_tools",
    "__version__",
]
