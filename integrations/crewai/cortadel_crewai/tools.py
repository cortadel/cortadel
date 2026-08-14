"""CrewAI-native tools that let an agent call Cortadel itself.

These are ordinary ``crewai.tools.BaseTool`` subclasses with pydantic
``args_schema`` models, so they drop into ``Agent(tools=[...])`` alongside any
other CrewAI tool. Use them when you want an agent to *decide* when to search
or store — as opposed to :class:`~cortadel_crewai.CortadelMemory`, which wires
Cortadel in automatically for every turn.

The two are independent: you can use either, or both together.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from cortadel import AddOptions, SearchOptions
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from cortadel_crewai._compat import (
    DEFAULT_APP_NAME,
    build_client,
    clamp_top_k,
    guard,
)


class SearchMemorySchema(BaseModel):
    """Arguments for :class:`CortadelSearchMemoryTool`."""

    query: str = Field(
        ...,
        description="Natural-language description of what you are trying to remember.",
    )
    top_k: int = Field(
        default=10,
        description="Maximum number of memories to return (1-50).",
    )


class AddMemoriesSchema(BaseModel):
    """Arguments for :class:`CortadelAddMemoriesTool`."""

    messages: list[str] = Field(
        ...,
        description=(
            "One or more durable facts, decisions, or preferences worth "
            "remembering for future tasks. Keep each one self-contained."
        ),
    )


class _CortadelToolBase(BaseTool):
    """Shared Cortadel client plumbing for the tools below."""

    base_url: Optional[str] = Field(default=None, exclude=True)
    user_id: Optional[str] = Field(default=None, exclude=True)
    # repr=False as well as exclude=True: this is a bearer token, and `exclude`
    # only keeps it out of model_dump(). CrewAI reprs tools when verbose.
    api_key: Optional[str] = Field(default=None, exclude=True, repr=False)
    app_name: str = Field(default=DEFAULT_APP_NAME, exclude=True)
    client: Any = Field(default=None, exclude=True)
    raise_on_error: bool = Field(default=False, exclude=True)
    on_error: Optional[Callable[[BaseException], None]] = Field(
        default=None, exclude=True, repr=False
    )

    def model_post_init(self, __context: Any) -> None:
        super().model_post_init(__context)
        if self.client is None:
            self.client = build_client(
                base_url=self.base_url,
                user_id=self.user_id,
                api_key=self.api_key,
                app_name=self.app_name,
            )


class CortadelSearchMemoryTool(_CortadelToolBase):
    """Let an agent search its long-term Cortadel memory."""

    name: str = "search_memory"
    description: str = (
        "Search long-term memory for facts, preferences, and decisions recorded "
        "in earlier sessions. Use this before answering anything that depends on "
        "prior context. Input is a natural-language query."
    )
    args_schema: type[BaseModel] = SearchMemorySchema

    mode: str = Field(default="hybrid", exclude=True)
    rerank: Optional[str] = Field(default=None, exclude=True)

    def _run(self, query: str, top_k: int = 10, **kwargs: Any) -> str:
        options = SearchOptions(
            top_k=clamp_top_k(top_k), mode=self.mode, rerank=self.rerank
        )
        results = guard(
            "search",
            lambda: self.client.search(query, options),
            None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )
        if results is None:
            return "Memory is temporarily unavailable; continue without it."
        if not results.results:
            return "No relevant memories found."

        lines = []
        for hit in results.results:
            prefix = "- "
            if hit.categories:
                prefix = f"- [{', '.join(hit.categories)}] "
            lines.append(f"{prefix}{hit.content}")
        return "Relevant memories:\n" + "\n".join(lines)


class CortadelAddMemoriesTool(_CortadelToolBase):
    """Let an agent write durable facts into Cortadel."""

    name: str = "add_memories"
    description: str = (
        "Save durable facts, preferences, or decisions to long-term memory so "
        "they are available in future sessions. Pass one or more short, "
        "self-contained statements."
    )
    args_schema: type[BaseModel] = AddMemoriesSchema

    infer: bool = Field(default=True, exclude=True)
    memory_type: Optional[str] = Field(default=None, exclude=True)

    def _run(self, messages: list[str] | str, **kwargs: Any) -> str:
        if isinstance(messages, str):
            messages = [messages]
        items = [m for m in messages if m and m.strip()]
        if not items:
            return "Nothing to save."

        options = AddOptions(
            app=self.app_name, infer=self.infer, memory_type=self.memory_type
        )
        saved = 0
        duplicates = 0
        for text in items:
            created = guard(
                "add",
                lambda text=text: self.client.add(text, options),
                None,
                raise_on_error=self.raise_on_error,
                on_error=self.on_error,
            )
            if created is None:
                continue
            # A 2xx does not mean a new memory was written — check the event.
            if created.event == "SKIP_DUPLICATE":
                duplicates += 1
            else:
                saved += 1

        if saved == 0 and duplicates == 0:
            return "Memory is temporarily unavailable; nothing was saved."
        parts = [f"Saved {saved} memory item(s)."]
        if duplicates:
            parts.append(f"{duplicates} were already known and were skipped.")
        return " ".join(parts)


def cortadel_tools(
    base_url: Optional[str] = None,
    user_id: Optional[str] = None,
    api_key: Optional[str] = None,
    app_name: str = DEFAULT_APP_NAME,
    client: Any = None,
    raise_on_error: bool = False,
    on_error: Optional[Callable[[BaseException], None]] = None,
) -> list[BaseTool]:
    """Build both Cortadel tools sharing one client.

    Mirrors CrewAI's own ``create_memory_tools`` helper::

        agent = Agent(role=..., goal=..., backstory=...,
                      tools=cortadel_tools(user_id="e2e-crewai-demo"))

    Args:
        raise_on_error: When True, Cortadel failures propagate to the agent loop
            instead of degrading to a "memory is unavailable" tool result.
        on_error: Called with the exception on every Cortadel failure. Setting it
            replaces the default warning log.
    """
    shared = client if client is not None else build_client(
        base_url=base_url, user_id=user_id, api_key=api_key, app_name=app_name
    )
    return [
        CortadelSearchMemoryTool(
            client=shared,
            app_name=app_name,
            raise_on_error=raise_on_error,
            on_error=on_error,
        ),
        CortadelAddMemoriesTool(
            client=shared,
            app_name=app_name,
            raise_on_error=raise_on_error,
            on_error=on_error,
        ),
    ]
