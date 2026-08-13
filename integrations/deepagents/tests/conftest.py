"""Shared offline test doubles.

Nothing here touches a network, a Cortadel server, or an LLM. The stub sits at the Cortadel client
boundary: `FakeCortadelClient` implements exactly the SDK surface this integration uses
(`search`, `add`, `add_conversation`) plus the rest of the facade for shape parity, and records
every call so tests can assert on the arguments the integration actually sent.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import Runnable

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

BASE_URL = "http://localhost:3001"
# Every id a test can reach the server with is `e2e-` scoped, so a suite accidentally pointed at a
# real Cortadel instance can only ever write into a throwaway namespace.
USER_ID = "e2e-deepagents-integration"
OTHER_USER_ID = "e2e-deepagents-other"
FALLBACK_USER_ID = "e2e-deepagents-fallback"
"""The `user_id=` constructor argument, used when a run carries no id of its own."""
STATIC_USER_ID = "e2e-deepagents-static"
"""Same role as `FALLBACK_USER_ID`, named for the test that reads it as "the static argument"."""


@dataclass
class SearchCall:
    query: str
    options: SearchOptions | None


@dataclass
class AddCall:
    text: str
    options: AddOptions | None


@dataclass
class ConversationCall:
    messages: list[ChatMessage]
    options: ConversationOptions | None


@dataclass
class FakeCortadelClient:
    """A blocking stand-in for `cortadel.SyncCortadelClient`.

    Structurally compatible with the real client for the seven public methods; the integration
    never touches anything else. Set `fail_with` to make every call raise, which is how the
    graceful-degradation tests are driven.
    """

    user_id: str = USER_ID
    hits: list[SearchHit] = field(default_factory=list)
    fail_with: Exception | None = None
    closed: bool = False

    searches: list[SearchCall] = field(default_factory=list)
    adds: list[AddCall] = field(default_factory=list)
    conversations: list[ConversationCall] = field(default_factory=list)

    def _maybe_fail(self) -> None:
        if self.fail_with is not None:
            raise self.fail_with

    def search(self, query: str, options: SearchOptions | None = None) -> SearchResults:
        self.searches.append(SearchCall(query, options))
        self._maybe_fail()
        return SearchResults(query=query, results=list(self.hits), total=len(self.hits))

    def add(self, text: str, options: AddOptions | None = None) -> MemoryCreated:
        self.adds.append(AddCall(text, options))
        self._maybe_fail()
        return MemoryCreated(id=f"mem-{len(self.adds)}", content=text, event="ADD")

    def add_conversation(
        self,
        messages: Any,
        options: ConversationOptions | None = None,
    ) -> ConversationResult:
        self.conversations.append(ConversationCall(list(messages), options))
        self._maybe_fail()
        return ConversationResult(
            results=[ConversationIngestItem(id="mem-conv", memory="a fact", event="ADD")]
        )

    def list(self, options: ListOptions | None = None) -> MemoryList:  # noqa: A003
        self._maybe_fail()
        return MemoryList()

    def get(self, memory_id: str) -> MemoryDetail | None:
        self._maybe_fail()
        return None

    def delete(self, memory_ids: Any) -> str:
        self._maybe_fail()
        return "deleted"

    def health(self) -> HealthResult:
        self._maybe_fail()
        return HealthResult(status="ok")

    def close(self) -> None:
        self.closed = True


def hit(
    memory_id: str,
    content: str,
    *,
    created_at: str | None = None,
    score: float | None = None,
) -> SearchHit:
    return SearchHit(id=memory_id, content=content, created_at=created_at, rrf_score=score)


def transport_error(message: str = "connection refused") -> CortadelError:
    """The failure a laptop sees when the Cortadel server is not running."""
    return CortadelError(0, "transport_error", message)


class RecordingFakeChatModel(GenericFakeChatModel):
    """A `GenericFakeChatModel` that can be bound to tools and records what it was asked.

    `create_deep_agent` always binds tools (the filesystem/subagent built-ins), and
    `GenericFakeChatModel.bind_tools` raises `NotImplementedError`, so a plain fake cannot drive
    the real graph. This subclass accepts the binding and keeps every request's messages, which is
    how the injection tests read back the system prompt the agent would have sent.
    """

    requests: list[list[BaseMessage]] = []

    def __init__(self, responses: Iterable[AIMessage], **kwargs: Any) -> None:
        super().__init__(messages=iter(responses), **kwargs)
        # `GenericFakeChatModel` is a pydantic model; bypass field validation for the recorder.
        object.__setattr__(self, "requests", [])

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Runnable[Any, BaseMessage]:
        return self

    def _generate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Any:
        self.requests.append(list(messages))
        return super()._generate(messages, *args, **kwargs)

    @property
    def system_prompts(self) -> list[str]:
        """The text of the system message on every recorded request."""
        prompts: list[str] = []
        for request in self.requests:
            for message in request:
                if message.type == "system":
                    prompts.append(message.text if isinstance(message.text, str) else str(message.text))
        return prompts
