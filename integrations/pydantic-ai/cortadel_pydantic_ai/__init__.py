"""Cortadel long-term memory for Pydantic AI.

Cortadel is self-hosted long-term temporal graph memory for AI agents: a bi-temporal graph store
with hybrid BM25 + vector search. This package wires it into pydantic-ai as a single capability.

    from pydantic_ai import Agent
    from cortadel_pydantic_ai import CortadelMemory

    agent = Agent(
        "openai:gpt-5",
        capabilities=[CortadelMemory(base_url="http://localhost:3001", user_id="e2e-alice")],
    )

That one object gives the agent `search_memory` and `add_memories` tools, recalls relevant
memories into the prompt before each run, and stores the turn afterwards.

Use `cortadel_toolset()` instead if you only want the tools.
"""

from ._backend import (
    DEFAULT_APP_NAME,
    DEFAULT_BASE_URL,
    ENV_API_KEY,
    ENV_BASE_URL,
    ENV_USER_ID,
    MemoryClient,
)
from ._format import DEFAULT_INSTRUCTIONS_HEADER
from .memory import CortadelMemory
from .toolset import TOOLSET_ID, cortadel_toolset

__all__ = [
    "DEFAULT_APP_NAME",
    "DEFAULT_BASE_URL",
    "DEFAULT_INSTRUCTIONS_HEADER",
    "ENV_API_KEY",
    "ENV_BASE_URL",
    "ENV_USER_ID",
    "TOOLSET_ID",
    "CortadelMemory",
    "MemoryClient",
    "__version__",
    "cortadel_toolset",
]

__version__ = "0.1.0"
