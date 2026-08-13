"""Shared offline test doubles.

Nothing here touches a network, a Cortadel server, or an LLM. The Cortadel boundary is stubbed
with :class:`FakeCortadelClient`, which implements exactly the seven public SDK methods and
returns the SDK's real frozen DTOs — so a field renamed upstream breaks these tests rather than
silently passing. The model boundary is stubbed with :class:`FakeModel`, which lets the tests
drive a genuine ``Runner.run()`` and observe what the runner actually sent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest
from agents import set_tracing_disabled
from agents.items import ModelResponse, TResponseInputItem
from agents.models.interface import Model
from agents.usage import Usage
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
    SearchHit,
    SearchOptions,
    SearchResults,
)
from openai.types.responses import ResponseOutputMessage, ResponseOutputText

BASE_URL = "http://localhost:3001"
USER_ID = "e2e-openai-agents-user"
SESSION_ID = "e2e-openai-agents-session"

# The SDK's tracing exporter posts to OpenAI. Off, so the suite cannot touch a network even if
# someone runs it on a machine that happens to have OPENAI_API_KEY set.
set_tracing_disabled(True)


def hit(content: str, *, memory_id: str = "mem-1", score: float | None = 0.9) -> SearchHit:
    return SearchHit(id=memory_id, content=content, rrf_score=score)


@dataclass
class FakeCortadelClient:
    """Stands in for ``cortadel.CortadelClient`` — the full public surface, nothing more.

    Every call is recorded so tests can assert on the exact options object that was built.
    """

    hits: list[SearchHit] = field(default_factory=list)
    #: When set, every method raises it. Models "the Cortadel server is unreachable".
    fail_with: BaseException | None = None
    add_event: str = "ADD"

    searches: list[tuple[str, SearchOptions | None]] = field(default_factory=list)
    conversations: list[tuple[list[ChatMessage], ConversationOptions | None]] = field(
        default_factory=list
    )
    adds: list[tuple[str, AddOptions | None]] = field(default_factory=list)
    deletes: list[list[str]] = field(default_factory=list)
    closed: bool = False

    def _maybe_fail(self) -> None:
        if self.fail_with is not None:
            raise self.fail_with

    async def add(self, text: str, options: AddOptions | None = None) -> MemoryCreated:
        self.adds.append((text, options))
        self._maybe_fail()
        return MemoryCreated(id="mem-new", content=text, event=self.add_event)

    async def add_conversation(
        self, messages: Any, options: ConversationOptions | None = None
    ) -> ConversationResult:
        self.conversations.append((list(messages), options))
        self._maybe_fail()
        return ConversationResult(
            results=[ConversationIngestItem(id="mem-new", memory="a fact", event="ADD")]
        )

    async def search(self, query: str, options: SearchOptions | None = None) -> SearchResults:
        self.searches.append((query, options))
        self._maybe_fail()
        return SearchResults(query=query, results=list(self.hits), total=len(self.hits))

    async def list(self, options: ListOptions | None = None) -> MemoryList:
        self._maybe_fail()
        return MemoryList()

    async def get(self, memory_id: str) -> MemoryDetail | None:
        self._maybe_fail()
        return None

    async def delete(self, memory_ids: Any) -> str:
        self.deletes.append(list(memory_ids))
        self._maybe_fail()
        return "deleted"

    async def health(self) -> HealthResult:
        self._maybe_fail()
        return HealthResult(status="ok")

    async def aclose(self) -> None:
        self.closed = True


class FakeModel(Model):
    """A ``Model`` that returns canned assistant text and records every call it received.

    Subclasses the SDK's real ``Model`` ABC because ``Agent.__post_init__`` type-checks it.
    ``**kwargs`` on both methods keeps it working if the SDK adds a keyword argument.
    """

    def __init__(self, replies: list[str] | None = None) -> None:
        self.replies = replies or ["Understood."]
        self.calls: list[dict[str, Any]] = []

    @property
    def last_instructions(self) -> str | None:
        return self.calls[-1]["system_instructions"]

    @property
    def last_input(self) -> list[TResponseInputItem]:
        received = self.calls[-1]["input"]
        return received if isinstance(received, list) else [received]

    async def get_response(
        self,
        system_instructions: str | None = None,
        input: Any = None,
        *args: Any,
        **kwargs: Any,
    ) -> ModelResponse:
        self.calls.append({"system_instructions": system_instructions, "input": input})
        index = min(len(self.calls) - 1, len(self.replies) - 1)
        return ModelResponse(
            output=[
                ResponseOutputMessage(
                    id=f"msg-{len(self.calls)}",
                    type="message",
                    role="assistant",
                    status="completed",
                    content=[
                        ResponseOutputText(
                            type="output_text", text=self.replies[index], annotations=[]
                        )
                    ],
                )
            ],
            usage=Usage(),
            response_id=None,
        )

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover
        raise NotImplementedError("FakeModel is non-streaming.")


@pytest.fixture
def fake_client() -> FakeCortadelClient:
    return FakeCortadelClient()


@pytest.fixture
def unreachable_client() -> FakeCortadelClient:
    return FakeCortadelClient(
        fail_with=CortadelError(0, "transport_error", "Connection refused")
    )
