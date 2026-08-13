# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Offline test fixtures.

Nothing here touches the network. The Cortadel client is stubbed at its facade boundary — the
handful of methods this integration actually calls (``search``, ``add_conversation``, ``add``) —
using the SDK's own real DTOs, so a field renamed upstream breaks these tests instead of
silently passing.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Optional

import pytest
from agent_framework import AgentSession, Message, SessionContext
from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    CortadelError,
    MemoryCreated,
    SearchHit,
    SearchOptions,
    SearchResults,
)

# Every user id in this suite is disposable test data.
TEST_USER_ID = "e2e-agent-framework-integration"


class FakeCortadelClient:
    """A stand-in for :class:`cortadel.CortadelClient`.

    Implements only the three methods the integration uses, records every call, and can be told
    to raise so the graceful-degradation paths get exercised.
    """

    def __init__(
        self,
        *,
        hits: Optional[list[SearchHit]] = None,
        search_error: Optional[BaseException] = None,
        add_conversation_error: Optional[BaseException] = None,
        add_error: Optional[BaseException] = None,
        created_event: str = "ADD",
    ) -> None:
        self._hits = hits or []
        self._search_error = search_error
        self._add_conversation_error = add_conversation_error
        self._add_error = add_error
        self._created_event = created_event

        self.search_calls: list[tuple[str, Optional[SearchOptions]]] = []
        self.add_conversation_calls: list[tuple[list[ChatMessage], Optional[ConversationOptions]]] = []
        self.add_calls: list[tuple[str, Optional[AddOptions]]] = []
        self.closed = False

    async def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        self.search_calls.append((query, options))
        if self._search_error is not None:
            raise self._search_error
        return SearchResults(query=query, results=list(self._hits), total=len(self._hits))

    async def add_conversation(
        self,
        messages: Iterable[ChatMessage],
        options: Optional[ConversationOptions] = None,
    ) -> ConversationResult:
        self.add_conversation_calls.append((list(messages), options))
        if self._add_conversation_error is not None:
            raise self._add_conversation_error
        return ConversationResult(results=[], no_facts_extracted=None)

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        self.add_calls.append((text, options))
        if self._add_error is not None:
            raise self._add_error
        return MemoryCreated(id="mem-1", content=text, event=self._created_event)

    async def aclose(self) -> None:
        self.closed = True


class FakeResponse:
    """Minimal stand-in for ``AgentResponse`` — the provider only reads ``.messages``."""

    def __init__(self, messages: list[Message]) -> None:
        self.messages = messages


async def invoke_text(tool: Any, **arguments: Any) -> str:
    """Invoke a ``FunctionTool`` and return the text the model would actually see.

    ``FunctionTool.invoke`` returns ``list[Content]``, not the wrapped function's raw value —
    every result is uniformly wrapped as Content items. Going through that real parsing path
    (rather than ``skip_parsing=True``) is what the model experiences, so that is what is tested.
    """
    contents = await tool.invoke(**arguments)
    return "".join(c.text for c in contents if c.type == "text")


def make_context(
    input_messages: list[Message],
    *,
    response_messages: Optional[list[Message]] = None,
) -> SessionContext:
    """Build a real ``SessionContext``, optionally with a response attached.

    ``SessionContext.response`` is a read-only property fed by the framework after invocation,
    so the private backing attribute is set here to reproduce the post-run state faithfully.
    """
    context = SessionContext(input_messages=input_messages)
    if response_messages is not None:
        context._response = FakeResponse(response_messages)  # type: ignore[assignment]
    return context


def hit(memory_id: str, content: str, *, gist: Optional[str] = None) -> SearchHit:
    """Build a real ``SearchHit`` DTO."""
    return SearchHit(id=memory_id, content=content, gist=gist, rrf_score=0.5)


@pytest.fixture
def session() -> AgentSession:
    """A real Agent Framework session with a deterministic id."""
    return AgentSession(session_id="e2e-session-1")


@pytest.fixture
def state() -> dict[str, Any]:
    """The provider-scoped state dict the framework hands to each hook."""
    return {}


@pytest.fixture
def agent() -> object:
    """The hooks receive an agent but this integration never reads it."""
    return object()


__all__ = [
    "TEST_USER_ID",
    "CortadelError",
    "FakeCortadelClient",
    "FakeResponse",
    "hit",
    "invoke_text",
    "make_context",
]
