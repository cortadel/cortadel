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

"""Model-callable Cortadel memory tools, as ADK ``FunctionTool``s.

ADK already ships ``load_memory``, which routes through whatever
``BaseMemoryService`` the runner holds — so once
:class:`~cortadel_google_adk.memory_service.CortadelMemoryService` is wired in,
the agent can already *read* memory with no extra tools. These exist for the two
things that covers badly:

* ADK has **no built-in write tool**, so an agent cannot decide "this is worth
  remembering" on its own. ``add_memories`` gives it one.
* ``load_memory`` throws away everything except the text. ``search_memory``
  returns Cortadel's score, categories, cognitive type and gist too, and honours
  the service's session scoping.
"""

from __future__ import annotations

from typing import Any
from typing import Optional

from google.adk.tools import FunctionTool

# Imported at runtime (not under TYPE_CHECKING) on purpose: ADK finds the
# context parameter with typing.get_type_hints(), which resolves the annotation
# against module globals. Under `from __future__ import annotations` a
# TYPE_CHECKING-only import would leave `ToolContext` unresolvable, ADK would
# fail to recognise the parameter, and it would leak into the tool's JSON
# schema as a required model argument.
from google.adk.tools import ToolContext

from ._convert import memory_entry_text
from .memory_service import CortadelMemoryService

__all__ = ["cortadel_memory_tools", "make_search_memory_tool", "make_add_memories_tool"]


def cortadel_memory_tools(
    service: CortadelMemoryService,
    *,
    include_search: bool = True,
    include_add: bool = True,
) -> list[FunctionTool]:
    """Builds the Cortadel memory tools bound to one service instance.

    Args:
      service: The memory service the tools read and write through. Usually the
        same instance passed to ``Runner(memory_service=...)``, so tool calls
        and automatic memory share one client pool and one dedup ledger.
      include_search: Include the ``search_memory`` tool.
      include_add: Include the ``add_memories`` tool.

    Returns:
      The tools, ready to drop into ``LlmAgent(tools=[...])``.
    """
    tools: list[FunctionTool] = []
    if include_search:
        tools.append(make_search_memory_tool(service))
    if include_add:
        tools.append(make_add_memories_tool(service))
    return tools


def make_search_memory_tool(service: CortadelMemoryService) -> FunctionTool:
    """Builds the model-callable ``search_memory`` tool."""

    async def search_memory(query: str, tool_context: ToolContext) -> dict[str, Any]:
        """Searches the user's long-term memory for facts relevant to a query.

        Call this whenever answering well needs something the user told you in
        an earlier conversation — preferences, decisions, names, ongoing work.

        Args:
          query: What to look for, in natural language. Describe the
            information you need, e.g. "the user's preferred deployment target".

        Returns:
          A dict with a "memories" list. Each entry has "text" plus, when the
          server computed them, "score", "categories", "memory_type" and
          "gist". An empty list means nothing relevant was stored.
        """
        session = tool_context.session
        response = await _search(service, session.app_name, session.user_id, session.id, query)
        memories: list[dict[str, Any]] = []
        for entry in response.memories:
            text = memory_entry_text(entry)
            if not text:
                continue
            item: dict[str, Any] = {"text": text}
            metadata = entry.custom_metadata or {}
            for out_key, meta_key in (
                ("score", "rrf_score"),
                ("categories", "categories"),
                ("memory_type", "memory_type"),
                ("gist", "gist"),
            ):
                if metadata.get(meta_key) is not None:
                    item[out_key] = metadata[meta_key]
            if entry.timestamp:
                item["timestamp"] = entry.timestamp
            memories.append(item)
        return {"memories": memories}

    return FunctionTool(search_memory)


def make_add_memories_tool(service: CortadelMemoryService) -> FunctionTool:
    """Builds the model-callable ``add_memories`` tool."""

    async def add_memories(
        text: str,
        tool_context: ToolContext,
        memory_type: Optional[str] = None,
    ) -> dict[str, Any]:
        """Stores a durable fact about the user in long-term memory.

        Call this when the user reveals something worth remembering beyond this
        conversation — a preference, a constraint, a decision, a stable fact
        about them or their work. Do not store transient chatter, and do not
        store secrets.

        Args:
          text: The fact to remember, written as a standalone sentence that will
            still make sense with no surrounding conversation, e.g. "The user
            deploys to Cloud Run and prefers Terraform over the console".
          memory_type: Optional cognitive type — "episodic" for a specific
            event, "semantic" for a general fact, "procedural" for how the user
            likes something done. Leave unset to let the server classify.

        Returns:
          A dict with "stored" (bool), "text" (what was stored) and "event" —
          "ADD" for a new memory, "SKIP_DUPLICATE" when the same fact is already
          known, so do not retry that one.
        """
        fact = (text or "").strip()
        if not fact:
            return {"stored": False, "text": "", "reason": "empty text"}

        session = tool_context.session
        created = await service.add_fact(
            app_name=session.app_name,
            user_id=session.user_id,
            text=fact,
            memory_type=memory_type,
        )
        if created is None:
            return {"stored": False, "text": fact, "reason": "memory backend unavailable"}

        result: dict[str, Any] = {"stored": created.event != "ERROR", "text": fact}
        if created.event:
            result["event"] = created.event
        return result

    return FunctionTool(add_memories)


async def _search(
    service: CortadelMemoryService,
    app_name: str,
    user_id: str,
    session_id: str,
    query: str,
):
    if service.scope_recall_to_session:
        return await service.search_memory_in_session(
            app_name=app_name,
            user_id=user_id,
            query=query,
            session_id=session_id,
        )
    return await service.search_memory(app_name=app_name, user_id=user_id, query=query)
