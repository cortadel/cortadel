"""Cortadel long-term memory for LangChain DeepAgents.

Cortadel is self-hosted long-term temporal graph memory for AI agents — a bi-temporal graph store
with hybrid BM25 + vector search. This package plugs it into
[`deepagents`](https://github.com/langchain-ai/deepagents) two ways:

- [`CortadelMemoryMiddleware`][cortadel_deepagents.CortadelMemoryMiddleware] — the automatic half.
  An `AgentMiddleware` for `create_deep_agent(middleware=[...])` that recalls relevant memories
  before the turn and persists the turn afterwards.
- [`create_cortadel_tools`][cortadel_deepagents.create_cortadel_tools] — the explicit half.
  `search_memory` and `add_memories` as DeepAgents-native tools the agent can call itself.

```python
from deepagents import create_deep_agent
from cortadel_deepagents import CortadelMemoryMiddleware

memory = CortadelMemoryMiddleware(base_url="http://localhost:3001", user_id="e2e-demo-user")
agent = create_deep_agent(model="anthropic:claude-sonnet-4-6", middleware=[memory])
```
"""

from cortadel_deepagents._client import (
    DEFAULT_APP_NAME,
    DEFAULT_BASE_URL,
    ClientProvider,
    resolve_user_id,
)
from cortadel_deepagents._format import CORTADEL_SYSTEM_PROMPT, RecalledMemory
from cortadel_deepagents.middleware import CortadelMemoryMiddleware, CortadelMemoryState
from cortadel_deepagents.tools import create_cortadel_tools

__version__ = "0.1.0"

__all__ = [
    "CORTADEL_SYSTEM_PROMPT",
    "DEFAULT_APP_NAME",
    "DEFAULT_BASE_URL",
    "ClientProvider",
    "CortadelMemoryMiddleware",
    "CortadelMemoryState",
    "RecalledMemory",
    "__version__",
    "create_cortadel_tools",
    "resolve_user_id",
]
