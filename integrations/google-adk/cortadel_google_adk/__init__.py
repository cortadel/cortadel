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

"""Cortadel long-term memory for Google ADK.

Three pieces, in the order you are likely to need them:

* :class:`CortadelMemoryService` — ADK's ``BaseMemoryService``, backed by
  Cortadel. Hand it to ``Runner(memory_service=...)`` and every agent, the
  built-in ``load_memory`` / ``preload_memory`` tools, and every
  ``Context.search_memory`` call go through Cortadel.
* :class:`CortadelMemoryPlugin` — persists each finished invocation
  automatically, which ADK's runner does not do on its own.
* :func:`cortadel_memory_tools` — model-callable ``search_memory`` and
  ``add_memories`` tools, for agents that should manage their own memory.

Cortadel is self-hosted long-term temporal graph memory for AI agents: a
bi-temporal graph store with hybrid BM25 + vector search. See
https://cortadel.ai.
"""

from __future__ import annotations

from ._convert import MEMORY_AUTHOR
from .memory_service import DEFAULT_APP_NAME
from .memory_service import DEFAULT_BASE_URL
from .memory_service import DEFAULT_TOP_K
from .memory_service import CortadelMemoryOptions
from .memory_service import CortadelMemoryService
from .plugin import CortadelMemoryPlugin
from .tools import cortadel_memory_tools
from .tools import make_add_memories_tool
from .tools import make_search_memory_tool

__version__ = "0.1.0"

__all__ = [
    "CortadelMemoryOptions",
    "CortadelMemoryPlugin",
    "CortadelMemoryService",
    "DEFAULT_APP_NAME",
    "DEFAULT_BASE_URL",
    "DEFAULT_TOP_K",
    "MEMORY_AUTHOR",
    "__version__",
    "cortadel_memory_tools",
    "make_add_memories_tool",
    "make_search_memory_tool",
]
