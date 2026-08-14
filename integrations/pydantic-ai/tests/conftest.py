"""Offline test fixtures.

Everything here stubs at the Cortadel-client boundary — the `MemoryClient` protocol — so the
suite needs no live server, no network and no API keys. The pydantic-ai side runs for real
against `TestModel`/`FunctionModel`, which are in-process and need no LLM provider.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

import pytest
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

E2E_USER = "e2e-pydantic-ai-integration"
"""Test data uses `e2e-*` user ids by project convention — never a real identity."""


class FakeCortadelClient:
    """Records calls and returns canned results. Implements the `MemoryClient` protocol."""

    def __init__(
        self,
        user_id: str = E2E_USER,
        *,
        hits: Optional[list[SearchHit]] = None,
        fail_with: Optional[Exception] = None,
    ) -> None:
        self.user_id = user_id
        self.hits = hits if hits is not None else []
        self.fail_with = fail_with
        self.searches: list[tuple[str, Optional[SearchOptions]]] = []
        self.adds: list[tuple[str, Optional[AddOptions]]] = []
        self.conversations: list[tuple[list[ChatMessage], Optional[ConversationOptions]]] = []
        self.closed = False

    async def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        if self.fail_with is not None:
            raise self.fail_with
        self.searches.append((query, options))
        return SearchResults(query=query, results=list(self.hits), total=len(self.hits))

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        if self.fail_with is not None:
            raise self.fail_with
        self.adds.append((text, options))
        return MemoryCreated(id="mem-1", content=text, event="ADD")

    async def add_conversation(
        self,
        messages: Iterable[ChatMessage],
        options: Optional[ConversationOptions] = None,
    ) -> ConversationResult:
        if self.fail_with is not None:
            raise self.fail_with
        recorded = list(messages)
        self.conversations.append((recorded, options))
        return ConversationResult(results=[], no_facts_extracted=None)

    async def aclose(self) -> None:
        self.closed = True


class ClientRegistry:
    """A `client_factory` that hands out one `FakeCortadelClient` per user id.

    Mirrors the real constraint: a Cortadel client is bound to a single user at construction.
    """

    def __init__(
        self,
        *,
        hits: Optional[list[SearchHit]] = None,
        fail_with: Optional[Exception] = None,
    ) -> None:
        self.hits = hits if hits is not None else []
        self.fail_with = fail_with
        self.clients: dict[str, FakeCortadelClient] = {}
        self.built: list[str] = []

    def __call__(self, user_id: str) -> FakeCortadelClient:
        self.built.append(user_id)
        client = self.clients.get(user_id)
        if client is None:
            client = FakeCortadelClient(user_id, hits=self.hits, fail_with=self.fail_with)
            self.clients[user_id] = client
        return client

    def only(self) -> FakeCortadelClient:
        assert len(self.clients) == 1, f"expected exactly one client, got {list(self.clients)}"
        return next(iter(self.clients.values()))


def hit(content: str, memory_id: str = "m1", score: float = 0.9) -> SearchHit:
    return SearchHit(id=memory_id, content=content, rrf_score=score)


@pytest.fixture
def registry() -> ClientRegistry:
    return ClientRegistry(
        hits=[
            hit("Alice prefers dark mode.", "m1"),
            hit("Alice ships on Fridays.", "m2"),
        ]
    )


@pytest.fixture
def failing_registry() -> ClientRegistry:
    return ClientRegistry(fail_with=CortadelError(0, "transport_error", "connection refused"))


@pytest.fixture(autouse=True)
def _no_cortadel_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Guarantee the suite is unaffected by a developer's own CORTADEL_* environment."""
    for name in ("CORTADEL_BASE_URL", "CORTADEL_API_KEY", "CORTADEL_USER_ID"):
        monkeypatch.delenv(name, raising=False)


def any_ctx(**kwargs: Any) -> Any:
    """A minimal stand-in for `RunContext` for unit tests that never touch an Agent."""
    from types import SimpleNamespace

    kwargs.setdefault("deps", None)
    kwargs.setdefault("prompt", None)
    kwargs.setdefault("messages", [])
    kwargs.setdefault("conversation_id", None)
    return SimpleNamespace(**kwargs)
