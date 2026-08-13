"""Offline test doubles.

Every test in this suite runs with no network, no Cortadel server and no API keys. The seam is the
Cortadel client itself: :func:`fake_cortadel` swaps ``SyncCortadelClient`` and ``CortadelClient``
inside ``cortadel_langgraph.store`` for fakes that share one recording backend, so a test can
assert on the exact Cortadel call the store made and hand back real ``cortadel`` DTOs.

User ids here always use the project-wide ``e2e-*`` prefix for disposable test data.
"""
from __future__ import annotations

from typing import Any, Iterable, Optional

import pytest
from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationIngestItem,
    ConversationOptions,
    ConversationResult,
    CortadelError,
    HealthResult,
    ListOptions,
    MemoryCreated,
    MemoryDetail,
    MemoryList,
    MemoryListItem,
    SearchHit,
    SearchOptions,
    SearchResults,
)

USER = "e2e-langgraph-integration"
OTHER_USER = "e2e-langgraph-other"
NAMESPACE = ("memories", USER)


class Backend:
    """Shared state behind the sync and async fake clients."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []
        self.constructed: list[dict[str, Any]] = []
        self.closed: list[str] = []
        self.next_id = 0
        # Canned responses, overridable per test.
        self.search_hits: list[SearchHit] = []
        self.list_items: list[MemoryListItem] = []
        self.detail: Optional[MemoryDetail] = None
        self.conversation = ConversationResult(
            results=[ConversationIngestItem(id="m-conv", memory="a fact", event="ADD")]
        )
        self.health = HealthResult(status="ok", checked_at="2026-08-13T00:00:00Z")
        # When set, the named method raises this error instead of answering.
        self.failures: dict[str, CortadelError] = {}

    # -- helpers used by the fake clients -----------------------------------------------

    def record(self, user_id: str, method: str, *args: Any) -> None:
        self.calls.append((user_id, method, args))

    def maybe_fail(self, method: str) -> None:
        error = self.failures.get(method)
        if error is not None:
            raise error

    def mint_id(self) -> str:
        self.next_id += 1
        return f"cortadel-{self.next_id}"

    # -- assertions helpers -------------------------------------------------------------

    def methods(self) -> list[str]:
        return [method for _user, method, _args in self.calls]

    def users(self) -> list[str]:
        return [user for user, _method, _args in self.calls]

    def first(self, method: str) -> tuple[Any, ...]:
        for _user, name, args in self.calls:
            if name == method:
                return args
        raise AssertionError(f"no {method!r} call was recorded; got {self.methods()}")

    def count(self, method: str) -> int:
        return sum(1 for name in self.methods() if name == method)


class FakeSyncClient:
    """Stands in for ``cortadel.SyncCortadelClient``."""

    def __init__(
        self,
        base_url: str,
        user_id: str,
        *,
        api_key: Optional[str] = None,
        app_name: str = "cortadel-python",
        http_client: Any = None,
        timeout: float = 100.0,
    ) -> None:
        self.base_url = base_url
        self.user_id = user_id
        backend.constructed.append(
            {
                "kind": "sync",
                "base_url": base_url,
                "user_id": user_id,
                "api_key": api_key,
                "app_name": app_name,
                "timeout": timeout,
            }
        )

    def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        backend.record(self.user_id, "add", text, options)
        backend.maybe_fail("add")
        return MemoryCreated(id=backend.mint_id(), content=text, event="ADD")

    def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        backend.record(self.user_id, "search", query, options)
        backend.maybe_fail("search")
        hits = list(backend.search_hits)
        return SearchResults(query=query, results=hits, total=len(hits))

    def list(self, options: Optional[ListOptions] = None) -> MemoryList:
        backend.record(self.user_id, "list", options)
        backend.maybe_fail("list")
        items = list(backend.list_items)
        return MemoryList(items=items, total=len(items), page=1, size=len(items), pages=1)

    def get(self, memory_id: str) -> Optional[MemoryDetail]:
        backend.record(self.user_id, "get", memory_id)
        backend.maybe_fail("get")
        return backend.detail

    def delete(self, memory_ids: Iterable[str]) -> str:
        ids = list(memory_ids)
        backend.record(self.user_id, "delete", ids)
        backend.maybe_fail("delete")
        return f"deleted {len(ids)}"

    def add_conversation(
        self,
        messages: Iterable[ChatMessage],
        options: Optional[ConversationOptions] = None,
    ) -> ConversationResult:
        backend.record(self.user_id, "add_conversation", list(messages), options)
        backend.maybe_fail("add_conversation")
        return backend.conversation

    def health(self) -> HealthResult:
        backend.record(self.user_id, "health")
        backend.maybe_fail("health")
        return backend.health

    def close(self) -> None:
        backend.closed.append(f"sync:{self.user_id}")


class FakeAsyncClient(FakeSyncClient):
    """Stands in for ``cortadel.CortadelClient`` — same behaviour, awaitable."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        backend.constructed[-1]["kind"] = "async"

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:  # type: ignore[override]
        return super().add(text, options)

    async def search(  # type: ignore[override]
        self, query: str, options: Optional[SearchOptions] = None
    ) -> SearchResults:
        return super().search(query, options)

    async def list(self, options: Optional[ListOptions] = None) -> MemoryList:  # type: ignore[override]
        return super().list(options)

    async def get(self, memory_id: str) -> Optional[MemoryDetail]:  # type: ignore[override]
        return super().get(memory_id)

    async def delete(self, memory_ids: Iterable[str]) -> str:  # type: ignore[override]
        return super().delete(memory_ids)

    async def add_conversation(  # type: ignore[override]
        self,
        messages: Iterable[ChatMessage],
        options: Optional[ConversationOptions] = None,
    ) -> ConversationResult:
        return super().add_conversation(messages, options)

    async def health(self) -> HealthResult:  # type: ignore[override]
        return super().health()

    async def aclose(self) -> None:
        backend.closed.append(f"async:{self.user_id}")


backend = Backend()


@pytest.fixture(autouse=True)
def fake_cortadel(monkeypatch: pytest.MonkeyPatch) -> Backend:
    """Replace both Cortadel clients with recording fakes, and reset the backend per test."""
    global backend
    backend = Backend()
    monkeypatch.setattr("cortadel_langgraph.store.SyncCortadelClient", FakeSyncClient)
    monkeypatch.setattr("cortadel_langgraph.store.CortadelClient", FakeAsyncClient)
    return backend


@pytest.fixture
def store(fake_cortadel: Backend):
    """A store bound to one fixed test user. Depends on the fake so patching happens first."""
    from cortadel_langgraph import CortadelStore

    return CortadelStore("http://localhost:3001", USER, raise_on_error=True)


def hit(
    memory_id: str,
    content: str,
    *,
    score: float = 0.5,
    created_at: str = "2026-08-01T12:00:00Z",
    **extra: Any,
) -> SearchHit:
    return SearchHit(
        id=memory_id, content=content, rrf_score=score, created_at=created_at, **extra
    )


def list_item(memory_id: str, content: str, *, created_at: int = 1_754_049_600, **extra: Any):
    return MemoryListItem(id=memory_id, content=content, created_at=created_at, **extra)


def detail(memory_id: str, text: str, *, created_at: int = 1_754_049_600, **extra: Any):
    return MemoryDetail(id=memory_id, text=text, created_at=created_at, **extra)
