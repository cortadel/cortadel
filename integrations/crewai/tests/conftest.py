"""Shared fakes. Every test here runs fully offline — no server, no keys.

The seam we stub is the Cortadel client itself: a small object implementing the
handful of methods this integration uses (``add``, ``add_conversation``,
``search``, ``list``, ``delete``, ``close``), returning the real SDK DTOs.
"""

from __future__ import annotations

import os
from typing import Any, Iterable, Optional

import pytest
from cortadel import (
    AddOptions,
    ConversationIngestItem,
    ConversationOptions,
    ConversationResult,
    CortadelError,
    ListOptions,
    MemoryCreated,
    MemoryList,
    MemoryListItem,
    SearchHit,
    SearchOptions,
    SearchResults,
)

#: Project-wide convention: disposable test data is namespaced under `e2e-*`.
TEST_USER_ID = "e2e-crewai-integration"


@pytest.fixture(autouse=True)
def _no_cortadel_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Guarantee the tests never pick up a developer's real server or key."""
    for name in ("CORTADEL_BASE_URL", "CORTADEL_USER_ID", "CORTADEL_API_KEY"):
        monkeypatch.delenv(name, raising=False)


class FakeCortadelClient:
    """Records calls and returns canned SDK DTOs."""

    def __init__(
        self,
        hits: Optional[list[SearchHit]] = None,
        conversation: Optional[ConversationResult] = None,
        items: Optional[list[MemoryListItem]] = None,
        add_event: str = "ADD",
    ) -> None:
        self.hits = hits if hits is not None else []
        self.conversation = conversation
        self.items = items if items is not None else []
        self.add_event = add_event

        self.added: list[tuple[str, Optional[AddOptions]]] = []
        self.conversations: list[tuple[list[Any], Optional[ConversationOptions]]] = []
        self.searches: list[tuple[str, Optional[SearchOptions]]] = []
        self.lists: list[Optional[ListOptions]] = []
        self.deleted: list[list[str]] = []
        self.closed = False
        self._counter = 0

    def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        self.added.append((text, options))
        self._counter += 1
        return MemoryCreated(
            id=f"mem-{self._counter}",
            content=text,
            state="active",
            created_at="2026-08-13T10:00:00Z",
            event=self.add_event,
            app_name="cortadel-crewai",
        )

    def add_conversation(
        self,
        messages: Iterable[Any],
        options: Optional[ConversationOptions] = None,
    ) -> ConversationResult:
        self.conversations.append((list(messages), options))
        if self.conversation is not None:
            return self.conversation
        return ConversationResult(
            results=[
                ConversationIngestItem(id="fact-1", memory="A distilled fact.", event="ADD")
            ]
        )

    def search(
        self, query: str, options: Optional[SearchOptions] = None
    ) -> SearchResults:
        self.searches.append((query, options))
        return SearchResults(query=query, results=list(self.hits), total=len(self.hits))

    def list(self, options: Optional[ListOptions] = None) -> MemoryList:
        self.lists.append(options)
        return MemoryList(
            items=list(self.items),
            total=len(self.items),
            page=1,
            size=len(self.items),
            pages=1,
        )

    def delete(self, memory_ids: Iterable[str]) -> str:
        ids = list(memory_ids)
        self.deleted.append(ids)
        return f"Deleted {len(ids)} memories"

    def close(self) -> None:
        self.closed = True


class BrokenCortadelClient:
    """Every call fails, as if the server were unreachable."""

    def __init__(self, error: Optional[Exception] = None) -> None:
        self.error = error or CortadelError(0, "transport_error", "connection refused")

    def _fail(self, *args: Any, **kwargs: Any) -> Any:
        raise self.error

    add = _fail
    add_conversation = _fail
    search = _fail
    list = _fail
    delete = _fail

    def close(self) -> None:
        return None


def make_hit(
    memory_id: str = "mem-1",
    content: str = "Alice ships on Fridays.",
    rrf_score: Optional[float] = 0.42,
    **kwargs: Any,
) -> SearchHit:
    """Build a SearchHit with sensible defaults."""
    return SearchHit(id=memory_id, content=content, rrf_score=rrf_score, **kwargs)


@pytest.fixture
def fake_client() -> FakeCortadelClient:
    return FakeCortadelClient()


@pytest.fixture
def broken_client() -> BrokenCortadelClient:
    return BrokenCortadelClient()
