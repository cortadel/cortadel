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

from __future__ import annotations

import asyncio
import inspect
import logging

from conftest import TEST_APP
from conftest import TEST_USER
from conftest import FakeClientFactory
from conftest import make_event
from conftest import make_hit
from conftest import make_session
from cortadel import CortadelError
from cortadel_google_adk import DEFAULT_TOP_K
from cortadel_google_adk import CortadelMemoryService
from cortadel_google_adk._convert import MEMORY_AUTHOR
from google.adk.memory.base_memory_service import BaseMemoryService
from google.adk.memory.base_memory_service import SearchMemoryResponse
from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types
import pytest


def build(factory: FakeClientFactory, **kwargs) -> CortadelMemoryService:
    return CortadelMemoryService("http://localhost:3001", client_factory=factory, **kwargs)


# ---------------------------------------------------------------------------
# Interface conformance — guards against ADK changing the contract under us
# ---------------------------------------------------------------------------


def test_is_a_concrete_base_memory_service(factory: FakeClientFactory) -> None:
    service = build(factory)
    assert isinstance(service, BaseMemoryService)
    # Instantiating at all proves both @abstractmethod members are implemented.
    assert not inspect.isabstract(CortadelMemoryService)


@pytest.mark.parametrize(
    "method",
    ["add_session_to_memory", "add_events_to_memory", "add_memory", "search_memory"],
)
def test_overrides_match_base_signatures(method: str) -> None:
    """ADK calls these by keyword, so names, kinds and defaults are the contract.

    Annotation *text* deliberately is not compared: ADK writes ``str | None``
    where this package writes ``Optional[str]`` for the 3.10 floor, and
    TYPE_CHECKING imports quote their forward references. Those differences are
    cosmetic; a renamed or newly-required parameter is not.
    """

    def shape(func: object) -> list[tuple[str, object, object]]:
        return [
            (name, param.kind, param.default)
            for name, param in inspect.signature(func).parameters.items()
        ]

    ours = shape(getattr(CortadelMemoryService, method))
    theirs = shape(getattr(BaseMemoryService, method))
    assert ours == theirs, f"{method} drifted from BaseMemoryService"


# ---------------------------------------------------------------------------
# search_memory
# ---------------------------------------------------------------------------


async def test_search_maps_hits_to_memory_entries(factory: FakeClientFactory) -> None:
    factory.hits = [
        make_hit(
            memory_id="mem-7",
            content="The user prefers Terraform.",
            rrf_score=0.42,
            created_at="2026-08-13T10:00:00Z",
            categories=["preferences"],
            memory_type="semantic",
            gist="prefers Terraform",
        )
    ]
    service = build(factory)

    response = await service.search_memory(
        app_name=TEST_APP, user_id=TEST_USER, query="tooling preferences"
    )

    assert isinstance(response, SearchMemoryResponse)
    (entry,) = response.memories
    assert isinstance(entry, MemoryEntry)
    assert entry.content.parts[0].text == "The user prefers Terraform."
    assert entry.id == "mem-7"
    assert entry.author == MEMORY_AUTHOR
    assert entry.timestamp == "2026-08-13T10:00:00Z"
    assert entry.custom_metadata["source"] == "cortadel"
    assert entry.custom_metadata["rrf_score"] == 0.42
    assert entry.custom_metadata["categories"] == ["preferences"]
    assert entry.custom_metadata["memory_type"] == "semantic"
    assert entry.custom_metadata["gist"] == "prefers Terraform"
    # A hit that is not global must not claim to be one.
    assert "is_global" not in entry.custom_metadata


async def test_search_passes_configured_options(factory: FakeClientFactory) -> None:
    service = build(factory, top_k=3, search_mode="vector", rerank="cross_encoder")

    await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="anything")

    (call,) = factory.only().calls_to("search")
    assert call.args == ("anything",)
    assert call.options.top_k == 3
    assert call.options.mode == "vector"
    assert call.options.rerank == "cross_encoder"
    assert call.options.session_id is None


async def test_default_top_k_is_five(factory: FakeClientFactory) -> None:
    """5, not the SDK's 10: the dominant caller is automatic injection."""
    assert DEFAULT_TOP_K == 5
    service = build(factory)

    await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="anything")

    (call,) = factory.only().calls_to("search")
    assert call.options.top_k == 5
    assert call.options.mode == "hybrid"


async def test_blank_query_never_reaches_the_server(factory: FakeClientFactory) -> None:
    service = build(factory)

    response = await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="   ")

    assert response.memories == []
    assert factory.clients == {}


async def test_session_scoped_search_pins_the_session(factory: FakeClientFactory) -> None:
    service = build(factory)

    await service.search_memory_in_session(
        app_name=TEST_APP, user_id=TEST_USER, query="q", session_id="sess-9"
    )

    (call,) = factory.only().calls_to("search")
    assert call.options.session_id == "sess-9"


# ---------------------------------------------------------------------------
# User-id scoping — one client per user, never one client for two users
# ---------------------------------------------------------------------------


async def test_each_adk_user_gets_its_own_client(factory: FakeClientFactory) -> None:
    service = build(factory)

    await service.search_memory(app_name=TEST_APP, user_id="e2e-alice", query="q")
    await service.search_memory(app_name=TEST_APP, user_id="e2e-bob", query="q")
    await service.search_memory(app_name=TEST_APP, user_id="e2e-alice", query="q2")

    assert sorted(factory.clients) == ["e2e-alice", "e2e-bob"]
    # Alice's second search reused her client rather than building a third.
    assert factory.built == ["e2e-alice", "e2e-bob"]
    assert len(factory.clients["e2e-alice"].calls_to("search")) == 2
    assert len(factory.clients["e2e-bob"].calls_to("search")) == 1


async def test_pinned_user_id_overrides_the_session_user(factory: FakeClientFactory) -> None:
    service = build(factory, user_id="e2e-shared-kb")

    await service.search_memory(app_name=TEST_APP, user_id="e2e-alice", query="q")
    await service.search_memory(app_name=TEST_APP, user_id="e2e-bob", query="q")

    assert list(factory.clients) == ["e2e-shared-kb"]


async def test_resolver_wins_over_pinned_user_id(factory: FakeClientFactory) -> None:
    service = build(
        factory,
        user_id="e2e-ignored",
        user_id_resolver=lambda app, user: f"{app}:{user}",
    )

    await service.search_memory(app_name=TEST_APP, user_id="e2e-alice", query="q")

    assert list(factory.clients) == [f"{TEST_APP}:e2e-alice"]


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------


async def test_add_session_sends_a_conversation(factory: FakeClientFactory) -> None:
    session = make_session(
        make_event(author="user", text="I deploy to Cloud Run.", event_id="e1"),
        make_event(author="assistant_agent", text="Noted.", event_id="e2"),
    )
    service = build(factory)

    await service.add_session_to_memory(session)

    (call,) = factory.only().calls_to("add_conversation")
    (messages,) = call.args
    assert [(m.role, m.content, m.uuid) for m in messages] == [
        ("user", "I deploy to Cloud Run.", "e1"),
        # Any author that is not literally "user" is the assistant side.
        ("assistant", "Noted.", "e2"),
    ]
    assert call.options.session_id == "sess-1"
    assert call.options.is_agent_memory is False


async def test_add_session_is_delta_only(factory: FakeClientFactory) -> None:
    first = make_event(author="user", text="turn one", event_id="e1")
    session = make_session(first)
    service = build(factory)

    await service.add_session_to_memory(session)
    # ADK explicitly allows adding the same session again as it grows.
    session.events.append(make_event(author="user", text="turn two", event_id="e2"))
    await service.add_session_to_memory(session)
    # A third call with nothing new must not hit the server at all.
    await service.add_session_to_memory(session)

    calls = factory.only().calls_to("add_conversation")
    assert len(calls) == 2
    assert [m.content for m in calls[0].args[0]] == ["turn one"]
    assert [m.content for m in calls[1].args[0]] == ["turn two"]


async def test_delta_ledger_is_per_session(factory: FakeClientFactory) -> None:
    service = build(factory)
    event = make_event(author="user", text="same text", event_id="")

    await service.add_session_to_memory(make_session(event, session_id="sess-a"))
    await service.add_session_to_memory(make_session(event, session_id="sess-b"))

    assert len(factory.only().calls_to("add_conversation")) == 2


async def test_failed_write_is_retried_next_turn(factory: FakeClientFactory) -> None:
    session = make_session(make_event(author="user", text="remember this", event_id="e1"))
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    client = factory.only()
    client.raises = CortadelError(0, "transport_error", "connection refused")

    await service.add_session_to_memory(session)
    assert len(client.calls_to("add_conversation")) == 1

    client.raises = None
    await service.add_session_to_memory(session)

    calls = client.calls_to("add_conversation")
    assert len(calls) == 2, "a dropped write must not be recorded as ingested"
    assert [m.content for m in calls[1].args[0]] == ["remember this"]


async def test_raised_write_is_also_retried_next_turn(
    factory: FakeClientFactory,
) -> None:
    """A raised write must not leave its events marked as already ingested."""
    session = make_session(make_event(author="user", text="remember this", event_id="e1"))
    service = build(factory, raise_on_error=True)
    await service.client_for(TEST_APP, TEST_USER)
    client = factory.only()
    client.raises = CortadelError(500, "server_error", "boom")

    with pytest.raises(CortadelError):
        await service.add_session_to_memory(session)

    client.raises = None
    await service.add_session_to_memory(session)

    calls = client.calls_to("add_conversation")
    assert len(calls) == 2
    assert [m.content for m in calls[1].args[0]] == ["remember this"]


async def test_non_text_and_partial_events_are_skipped(factory: FakeClientFactory) -> None:
    session = make_session(
        make_event(author="user", text=None, event_id="e1"),
        make_event(author="assistant_agent", text="streaming chun", event_id="e2", partial=True),
        make_event(author="assistant_agent", text="streaming chunk", event_id="e3"),
    )
    service = build(factory)

    await service.add_session_to_memory(session)

    (call,) = factory.only().calls_to("add_conversation")
    assert [m.content for m in call.args[0]] == ["streaming chunk"]


async def test_session_with_no_usable_events_makes_no_call(factory: FakeClientFactory) -> None:
    service = build(factory)

    await service.add_session_to_memory(make_session())
    await service.add_session_to_memory(
        make_session(make_event(author="user", text=None, event_id="e1"))
    )

    assert not any(c.calls_to("add_conversation") for c in factory.clients.values())


async def test_add_events_honours_custom_metadata(factory: FakeClientFactory) -> None:
    service = build(factory)

    await service.add_events_to_memory(
        app_name=TEST_APP,
        user_id=TEST_USER,
        events=[make_event(author="user", text="hello", event_id="e1")],
        session_id="sess-42",
        custom_metadata={
            "tags": ["onboarding", "prefs"],
            "project": "cortadel",
            "is_agent_memory": True,
            "transcript_path": "/tmp/t.jsonl",
            "unknown_key": "ignored",
        },
    )

    (call,) = factory.only().calls_to("add_conversation")
    assert call.options.tags == ["onboarding", "prefs"]
    assert call.options.project == "cortadel"
    assert call.options.is_agent_memory is True
    assert call.options.transcript_path == "/tmp/t.jsonl"
    assert call.options.session_id == "sess-42"


async def test_constructor_defaults_flow_into_conversation_options(
    factory: FakeClientFactory,
) -> None:
    service = build(factory, project="proj", tags=["adk"], is_agent_memory=True)

    await service.add_events_to_memory(
        app_name=TEST_APP,
        user_id=TEST_USER,
        events=[make_event(author="user", text="hello", event_id="e1")],
        session_id="s",
    )

    (call,) = factory.only().calls_to("add_conversation")
    assert call.options.project == "proj"
    assert call.options.tags == ["adk"]
    assert call.options.is_agent_memory is True


# ---------------------------------------------------------------------------
# add_memory / add_fact — direct writes
# ---------------------------------------------------------------------------


def entry(text: str) -> MemoryEntry:
    return MemoryEntry(content=types.Content(role="user", parts=[types.Part(text=text)]))


async def test_add_memory_writes_each_entry(factory: FakeClientFactory) -> None:
    service = build(factory)

    await service.add_memory(
        app_name=TEST_APP,
        user_id=TEST_USER,
        memories=[entry("fact one"), entry(""), entry("fact two")],
        custom_metadata={"memory_type": "semantic", "infer": False, "metadata": {"k": "v"}},
    )

    calls = factory.only().calls_to("add")
    assert [c.args[0] for c in calls] == ["fact one", "fact two"]
    assert calls[0].options.memory_type == "semantic"
    assert calls[0].options.infer is False
    assert calls[0].options.metadata == {"k": "v"}
    # AddOptions.app credits the ADK app that created the memory.
    assert calls[0].options.app == TEST_APP


async def test_infer_stays_unset_when_not_requested(factory: FakeClientFactory) -> None:
    """`infer=False` disables extraction — an unset key must never mean False."""
    service = build(factory)

    await service.add_memory(app_name=TEST_APP, user_id=TEST_USER, memories=[entry("fact")])

    (call,) = factory.only().calls_to("add")
    assert call.options.infer is None


async def test_add_fact_reports_the_pipeline_event(factory: FakeClientFactory) -> None:
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().add_event = "SKIP_DUPLICATE"

    created = await service.add_fact(app_name=TEST_APP, user_id=TEST_USER, text="known fact")

    assert created is not None
    assert created.event == "SKIP_DUPLICATE"


async def test_add_fact_ignores_blank_text(factory: FakeClientFactory) -> None:
    service = build(factory)

    assert await service.add_fact(app_name=TEST_APP, user_id=TEST_USER, text="   ") is None
    assert factory.clients == {}


# ---------------------------------------------------------------------------
# Failure policy — `raise_on_error` (fail-open by default) and `on_error`
# ---------------------------------------------------------------------------


def test_raise_on_error_is_declared_false_by_default() -> None:
    """Pins the *inverted* rename of the old ``fail_open=True``.

    ``raise_on_error`` is the opposite polarity of the option it replaced, so
    the default has to flip with it. A rename that kept ``True`` would still
    type-check and still pass every "an error propagates" test — only this
    assertion catches it.
    """
    params = inspect.signature(CortadelMemoryService.__init__).parameters

    assert "fail_open" not in params, "fail_open was renamed to raise_on_error"
    assert params["raise_on_error"].default is False
    assert params["on_error"].default is None


@pytest.mark.parametrize("raise_on_error", [False, True])
async def test_raise_on_error_binds_value_to_behaviour(
    factory: FakeClientFactory, raise_on_error: bool
) -> None:
    """``True`` raises, ``False`` swallows — the mapping, not just one half.

    Parametrised on purpose: an implementation that read the flag backwards
    would pass either case alone, and fail this one.
    """
    service = build(factory, raise_on_error=raise_on_error)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = CortadelError(503, "unavailable", "degraded")

    if raise_on_error:
        with pytest.raises(CortadelError) as excinfo:
            await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")
        assert excinfo.value.status == 503
        assert excinfo.value.code == "unavailable"

        with pytest.raises(CortadelError):
            await service.add_session_to_memory(
                make_session(make_event(author="user", text="hi", event_id="e1"))
            )
    else:
        response = await service.search_memory(
            app_name=TEST_APP, user_id=TEST_USER, query="q"
        )
        assert response.memories == []
        # Writes degrade too, rather than taking the turn down.
        await service.add_session_to_memory(
            make_session(make_event(author="user", text="hi", event_id="e1"))
        )


async def test_default_service_degrades_search_to_empty(factory: FakeClientFactory) -> None:
    """No failure options at all must mean fail-open."""
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = CortadelError(0, "transport_error", "connection refused")

    response = await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    assert response.memories == []


async def test_default_service_swallows_non_cortadel_errors(
    factory: FakeClientFactory,
) -> None:
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = RuntimeError("boom")

    assert (
        await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")
    ).memories == []
    await service.add_session_to_memory(
        make_session(make_event(author="user", text="hi", event_id="e1"))
    )


async def test_swallowed_failure_logs_a_warning_when_unobserved(
    factory: FakeClientFactory, caplog: pytest.LogCaptureFixture
) -> None:
    """Without an observer, the log is the only trace a memory call failed."""
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = CortadelError(0, "transport_error", "connection refused")

    with caplog.at_level(logging.WARNING, logger="cortadel_google_adk.memory_service"):
        await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    assert any(record.levelno == logging.WARNING for record in caplog.records)


async def test_on_error_observes_a_swallowed_failure(factory: FakeClientFactory) -> None:
    seen: list[BaseException] = []
    service = build(factory, on_error=seen.append)
    await service.client_for(TEST_APP, TEST_USER)
    boom = CortadelError(0, "transport_error", "connection refused")
    factory.only().raises = boom

    response = await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    assert response.memories == []
    assert seen == [boom]


async def test_on_error_also_observes_a_raised_failure(factory: FakeClientFactory) -> None:
    """The callback is an observer, not an alternative to ``raise_on_error``."""
    seen: list[BaseException] = []
    service = build(factory, raise_on_error=True, on_error=seen.append)
    await service.client_for(TEST_APP, TEST_USER)
    boom = CortadelError(500, "server_error", "boom")
    factory.only().raises = boom

    with pytest.raises(CortadelError):
        await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    assert seen == [boom]


async def test_on_error_replaces_the_warning(
    factory: FakeClientFactory, caplog: pytest.LogCaptureFixture
) -> None:
    service = build(factory, on_error=lambda exc: None)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = CortadelError(0, "transport_error", "refused")

    with caplog.at_level(logging.WARNING, logger="cortadel_google_adk.memory_service"):
        await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    assert caplog.records == []


async def test_a_broken_on_error_cannot_break_the_run(factory: FakeClientFactory) -> None:
    def explode(exc: BaseException) -> None:
        raise ValueError("the observer is broken")

    service = build(factory, on_error=explode)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = CortadelError(0, "transport_error", "refused")

    response = await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    assert response.memories == []


async def test_a_failing_client_factory_goes_through_the_policy() -> None:
    """Building the client is part of the call, not something outside the policy."""
    seen: list[BaseException] = []

    def broken_factory(user_id: str) -> object:
        raise ValueError(f"cannot build a client for {user_id}")

    service = CortadelMemoryService(
        "http://localhost:3001", client_factory=broken_factory, on_error=seen.append
    )

    response = await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    assert response.memories == []
    assert [type(exc) for exc in seen] == [ValueError]


async def test_cancellation_is_never_swallowed_or_observed(
    factory: FakeClientFactory,
) -> None:
    seen: list[BaseException] = []
    service = build(factory, on_error=seen.append)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")

    # Cancellation is control flow, not a memory failure.
    assert seen == []


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def test_aclose_closes_every_pooled_client(factory: FakeClientFactory) -> None:
    service = build(factory)
    await service.search_memory(app_name=TEST_APP, user_id="e2e-alice", query="q")
    await service.search_memory(app_name=TEST_APP, user_id="e2e-bob", query="q")

    await service.aclose()

    assert all(client.closed for client in factory.clients.values())


async def test_async_context_manager_closes(factory: FakeClientFactory) -> None:
    async with build(factory) as service:
        await service.search_memory(app_name=TEST_APP, user_id=TEST_USER, query="q")
    assert factory.only().closed


async def test_client_pool_evicts_and_closes_the_least_recent(
    factory: FakeClientFactory,
) -> None:
    service = build(factory, max_clients=2)

    await service.search_memory(app_name=TEST_APP, user_id="e2e-a", query="q")
    await service.search_memory(app_name=TEST_APP, user_id="e2e-b", query="q")
    await service.search_memory(app_name=TEST_APP, user_id="e2e-c", query="q")

    assert factory.clients["e2e-a"].closed is True
    assert factory.clients["e2e-b"].closed is False
    assert factory.clients["e2e-c"].closed is False


def test_env_is_not_required_to_construct(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CORTADEL_BASE_URL", raising=False)
    monkeypatch.delenv("CORTADEL_API_KEY", raising=False)
    # Real client factory, but nothing is called — construction alone must work
    # with no env, no server and no key.
    service = CortadelMemoryService()
    assert service.resolve_user_id(TEST_APP, TEST_USER) == TEST_USER
