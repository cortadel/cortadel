"""Cortadel long-term memory for the Claude Agent SDK.

Cortadel is self-hosted long-term temporal graph memory for AI agents — a bi-temporal graph store
with hybrid BM25 + vector search. This package plugs it into the two extension points the Claude
Agent SDK actually offers:

* an **in-process MCP server** (``create_sdk_mcp_server``) carrying ``search_memory`` and
  ``add_memories``, so the agent can recall and remember on purpose, and
* **``UserPromptSubmit`` / ``Stop`` hooks**, so it also recalls and remembers without being asked.

Both come off one object::

    from claude_agent_sdk import ClaudeAgentOptions, query
    from cortadel_claude_agent_sdk import CortadelMemory

    memory = CortadelMemory("http://localhost:3001", "e2e-alice")
    options = memory.apply(ClaudeAgentOptions(model="claude-sonnet-4-5"))

    async for message in query(prompt="What did we decide about the schema?", options=options):
        ...

Everything under ``cortadel_claude_agent_sdk._*`` is private; build only on the names below.
"""
from __future__ import annotations

from cortadel_claude_agent_sdk._memory import (
    DEFAULT_APP_NAME,
    DEFAULT_SERVER_NAME,
    CortadelLike,
    CortadelMemory,
)

__all__ = [
    "CortadelLike",
    "CortadelMemory",
    "DEFAULT_APP_NAME",
    "DEFAULT_SERVER_NAME",
    "__version__",
]

__version__ = "0.1.0"
