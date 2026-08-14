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

"""Offline fixtures. No server, no network, no API keys.

Every test stubs at the Cortadel client boundary via
``CortadelMemoryService(client_factory=...)``, so nothing here reads
``CORTADEL_*`` env or opens a socket. ADK objects are the *real* ones — a fake
``Session``/``Event`` would let an interface change slip through unnoticed.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Optional

from cortadel import ConversationResult
from cortadel import HealthResult
from cortadel import MemoryCreated
from cortadel import MemoryList
from cortadel import SearchHit
from cortadel import SearchResults
from google.adk.events.event import Event
from google.adk.sessions.session import Session
from google.genai import types
import pytest

TEST_USER = "e2e-google-adk"
TEST_APP = "e2e-adk-app"


@dataclass
class Call:
    """One recorded call to the fake client."""

    method: str
    args: tuple[Any, ...]
    options: Any = None


@dataclass
class FakeCortadelClient:
    """Implements exactly the seven-method Cortadel facade, and ``aclose``.

    Nothing more exists on the real client, so nothing more may be used here.
    """

    user_id: str
    hits: list[SearchHit] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)
    raises: Optional[BaseException] = None
    add_event: str = "ADD"
    closed: bool = False

    def _maybe_raise(self) -> None:
        if self.raises is not None:
            raise self.raises

    async def add(self, text: str, options: Any = None) -> MemoryCreated:
        self.calls.append(Call("add", (text,), options))
        self._maybe_raise()
        return MemoryCreated(id="m-1", content=text, event=self.add_event)

    async def add_conversation(self, messages: Any, options: Any = None) -> ConversationResult:
        self.calls.append(Call("add_conversation", (list(messages),), options))
        self._maybe_raise()
        return ConversationResult(results=[])

    async def search(self, query: str, options: Any = None) -> SearchResults:
        self.calls.append(Call("search", (query,), options))
        self._maybe_raise()
        return SearchResults(query=query, results=list(self.hits), total=len(self.hits))

    async def list(self, options: Any = None) -> MemoryList:  # noqa: A003 - facade name
        self.calls.append(Call("list", (), options))
        self._maybe_raise()
        return MemoryList()

    async def get(self, memory_id: str) -> None:
        self.calls.append(Call("get", (memory_id,)))
        self._maybe_raise()
        return None

    async def delete(self, memory_ids: Any) -> str:
        self.calls.append(Call("delete", (list(memory_ids),)))
        self._maybe_raise()
        return "deleted"

    async def health(self) -> HealthResult:
        self.calls.append(Call("health", ()))
        self._maybe_raise()
        return HealthResult(status="ok")

    async def aclose(self) -> None:
        self.closed = True

    # -- assertions helpers -------------------------------------------------

    def calls_to(self, method: str) -> list[Call]:
        return [call for call in self.calls if call.method == method]


class FakeClientFactory:
    """Builds (and remembers) one fake client per resolved Cortadel user id."""

    def __init__(self, hits: Optional[list[SearchHit]] = None) -> None:
        self.hits = hits or []
        self.clients: dict[str, FakeCortadelClient] = {}
        self.built: list[str] = []

    def __call__(self, user_id: str) -> FakeCortadelClient:
        self.built.append(user_id)
        client = FakeCortadelClient(user_id=user_id, hits=list(self.hits))
        self.clients[user_id] = client
        return client

    def only(self) -> FakeCortadelClient:
        assert len(self.clients) == 1, f"expected one client, got {sorted(self.clients)}"
        return next(iter(self.clients.values()))


@pytest.fixture
def factory() -> FakeClientFactory:
    return FakeClientFactory()


def make_event(
    *,
    author: str,
    text: Optional[str],
    event_id: str = "",
    invocation_id: str = "inv-1",
    partial: Optional[bool] = None,
) -> Event:
    """A real ADK ``Event``; ``text=None`` builds one with no text parts."""
    parts = [types.Part(text=text)] if text is not None else [types.Part(text=None)]
    return Event(
        id=event_id,
        invocation_id=invocation_id,
        author=author,
        partial=partial,
        content=types.Content(role="user" if author == "user" else "model", parts=parts),
    )


def make_session(*events: Event, session_id: str = "sess-1") -> Session:
    """A real ADK ``Session`` scoped to the test user."""
    return Session(
        id=session_id,
        app_name=TEST_APP,
        user_id=TEST_USER,
        events=list(events),
    )


def make_hit(
    *,
    memory_id: str = "mem-1",
    content: str = "The user deploys to Cloud Run.",
    **kwargs: Any,
) -> SearchHit:
    return SearchHit(id=memory_id, content=content, **kwargs)
