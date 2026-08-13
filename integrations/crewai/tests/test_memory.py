"""CortadelMemory: the retrieve→inject and persist-after-turn paths."""

from __future__ import annotations

import pytest
from cortadel import ChatMessage, ConversationResult, MemoryListItem
from crewai.memory.types import MemoryMatch, MemoryRecord
from crewai.memory.unified_memory import Memory

from cortadel_crewai import CortadelMemory
from tests.conftest import TEST_USER_ID, BrokenCortadelClient, FakeCortadelClient, make_hit


def build(client: object, **kwargs: object) -> CortadelMemory:
    return CortadelMemory(user_id=TEST_USER_ID, client=client, **kwargs)


# ---------------------------------------------------------------- construction


def test_is_a_real_crewai_memory(fake_client: FakeCortadelClient) -> None:
    """Must be a genuine Memory subclass or Crew(memory=...) will reject it."""
    memory = build(fake_client)
    assert isinstance(memory, Memory)
    assert memory.memory_kind == "memory"


def test_constructs_offline_without_lancedb_or_keys(
    fake_client: FakeCortadelClient,
) -> None:
    """No embedder, no OPENAI_API_KEY, no local vector store is ever built."""
    memory = build(fake_client)
    # A str storage would make Memory.model_post_init construct LanceDBStorage.
    assert not isinstance(memory.storage, str)
    assert memory._storage is memory.storage


def test_user_id_is_required() -> None:
    with pytest.raises(ValueError, match="user_id"):
        CortadelMemory()


def test_user_id_is_bound_into_the_client_at_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cortadel scopes every call to the construction-time user id — there is no
    per-call user parameter, so per-user isolation means one client per user."""
    captured: list[dict[str, object]] = []

    def fake_sync_client(base_url: str, user_id: str, **kwargs: object) -> object:
        captured.append({"base_url": base_url, "user_id": user_id, **kwargs})
        return FakeCortadelClient()

    monkeypatch.setattr("cortadel_crewai._compat.SyncCortadelClient", fake_sync_client)

    CortadelMemory(base_url="http://memory.internal:3001", user_id="e2e-user-a")
    CortadelMemory(base_url="http://memory.internal:3001", user_id="e2e-user-b")

    assert [c["user_id"] for c in captured] == ["e2e-user-a", "e2e-user-b"]
    assert captured[0]["base_url"] == "http://memory.internal:3001"
    assert captured[0]["app_name"] == "cortadel-crewai"


def test_falls_back_to_cortadel_env_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict[str, object]] = []

    def fake_sync_client(base_url: str, user_id: str, **kwargs: object) -> object:
        captured.append({"base_url": base_url, "user_id": user_id, **kwargs})
        return FakeCortadelClient()

    monkeypatch.setattr("cortadel_crewai._compat.SyncCortadelClient", fake_sync_client)
    monkeypatch.setenv("CORTADEL_BASE_URL", "https://app.cortadel.ai")
    monkeypatch.setenv("CORTADEL_USER_ID", TEST_USER_ID)
    monkeypatch.setenv("CORTADEL_API_KEY", "not-a-real-key")

    CortadelMemory()

    assert captured[0]["base_url"] == "https://app.cortadel.ai"
    assert captured[0]["user_id"] == TEST_USER_ID
    assert captured[0]["api_key"] == "not-a-real-key"


def test_api_key_never_leaks_into_repr_or_dump(
    fake_client: FakeCortadelClient,
) -> None:
    """It is a bearer token. Crew.copy() dumps every agent, so a plain field
    would put it into an intermediate dict — and print() would show it."""
    memory = build(fake_client, api_key="not-a-real-key")

    assert "not-a-real-key" not in repr(memory)
    assert "api_key" not in memory.model_dump()
    assert memory.api_key == "not-a-real-key"  # still usable, just not printed


def test_survives_crew_construction(fake_client: FakeCortadelClient) -> None:
    """Crew's `memory` field is a discriminated union — the instance must pass
    through untouched, not be coerced back into a plain Memory."""
    from crewai import Agent, Crew, Task

    memory = build(fake_client)
    agent = Agent(role="r", goal="g", backstory="b", llm="gpt-4o-mini")
    task = Task(description="d", expected_output="e", agent=agent)
    crew = Crew(agents=[agent], tasks=[task], memory=memory)

    assert crew.memory is memory
    assert isinstance(crew.memory, CortadelMemory)


# ------------------------------------------------------------------ read path


def test_recall_searches_cortadel_and_maps_hits(
    fake_client: FakeCortadelClient,
) -> None:
    fake_client.hits = [
        make_hit("mem-a", "Alice prefers dark mode.", 0.9, categories=["preferences"]),
        make_hit("mem-b", "Alice ships on Fridays.", 0.4),
    ]
    memory = build(fake_client)

    matches = memory.recall("what does alice prefer?", limit=5)

    assert [m.record.content for m in matches] == [
        "Alice prefers dark mode.",
        "Alice ships on Fridays.",
    ]
    assert all(isinstance(m, MemoryMatch) for m in matches)
    assert matches[0].score == 0.9
    assert matches[0].record.categories == ["preferences"]

    query, options = fake_client.searches[0]
    assert query == "what does alice prefer?"
    assert options.top_k == 5
    assert options.mode == "hybrid"


def test_recall_clamps_limit_to_cortadel_max_top_k(
    fake_client: FakeCortadelClient,
) -> None:
    """Cortadel rejects top_k above 50; CrewAI callers may ask for more."""
    build(fake_client).recall("q", limit=500)
    assert fake_client.searches[0][1].top_k == 50


def test_recall_passes_rerank_and_memory_type(fake_client: FakeCortadelClient) -> None:
    memory = build(fake_client, rerank="cross_encoder", memory_type="semantic")
    memory.recall("q")
    _, options = fake_client.searches[0]
    assert options.rerank == "cross_encoder"
    assert options.memory_type == "semantic"


def test_recall_ignores_blank_queries(fake_client: FakeCortadelClient) -> None:
    assert build(fake_client).recall("   ") == []
    assert fake_client.searches == []


def test_recall_carries_cortadel_provenance(fake_client: FakeCortadelClient) -> None:
    fake_client.hits = [make_hit(text_rank=1, vector_rank=3, memory_type="episodic")]
    match = build(fake_client).recall("q")[0]
    assert "cortadel:bm25_rank=1" in match.match_reasons
    assert "cortadel:vector_rank=3" in match.match_reasons
    assert match.record.metadata["cortadel_rrf_score"] == 0.42


def test_recall_parses_iso_timestamp_with_z_suffix(
    fake_client: FakeCortadelClient,
) -> None:
    """Cortadel sends `...Z`; normalise it rather than depend on the interpreter."""
    fake_client.hits = [make_hit(created_at="2026-08-13T10:00:00Z")]
    record = build(fake_client).recall("q")[0].record
    assert record.created_at.year == 2026
    assert record.created_at.tzinfo is not None


def test_dedupe_window_suppresses_repeat_injection(
    fake_client: FakeCortadelClient,
) -> None:
    """Agents re-recall every turn; the same facts should not be re-injected."""
    fake_client.hits = [make_hit("mem-a"), make_hit("mem-b", "Second.")]
    memory = build(fake_client, dedupe_window=10)

    first = memory.recall("q")
    second = memory.recall("q")

    assert len(first) == 2
    assert second == []


def test_dedupe_window_counts_ids_not_recalls(
    fake_client: FakeCortadelClient,
) -> None:
    """The window is N *ids*, as documented — a 2-id window forgets the first
    hit as soon as a second recall pushes two more ids through it."""
    fake_client.hits = [make_hit("mem-a"), make_hit("mem-b", "Second.")]
    memory = build(fake_client, dedupe_window=2)

    memory.recall("q")  # remembers mem-a, mem-b
    fake_client.hits = [make_hit("mem-c", "Third."), make_hit("mem-d", "Fourth.")]
    memory.recall("q")  # ring now holds mem-c, mem-d only

    fake_client.hits = [make_hit("mem-a"), make_hit("mem-c", "Third.")]
    third = memory.recall("q")

    assert [m.record.id for m in third] == ["mem-a"]  # mem-c still suppressed


def test_dedupe_window_off_by_default(fake_client: FakeCortadelClient) -> None:
    fake_client.hits = [make_hit("mem-a")]
    memory = build(fake_client)
    assert len(memory.recall("q")) == 1
    assert len(memory.recall("q")) == 1


# ----------------------------------------------------------------- write path


def test_remember_adds_to_cortadel(fake_client: FakeCortadelClient) -> None:
    record = build(fake_client).remember("Alice ships on Fridays.")

    assert isinstance(record, MemoryRecord)
    assert record.id == "mem-1"
    assert record.content == "Alice ships on Fridays."
    assert record.metadata["cortadel_event"] == "ADD"

    text, options = fake_client.added[0]
    assert text == "Alice ships on Fridays."
    assert options.app == "cortadel-crewai"
    assert options.infer is True


def test_remember_forwards_crewai_bookkeeping_as_metadata(
    fake_client: FakeCortadelClient,
) -> None:
    build(fake_client).remember(
        "A fact.", scope="/team", categories=["ops"], importance=0.9, source="alice"
    )
    _, options = fake_client.added[0]
    assert options.metadata["crewai_scope"] == "/team"
    assert options.metadata["crewai_source"] == "alice"
    assert options.metadata["crewai_integration"] == "cortadel-crewai"


def test_remember_respects_read_only(fake_client: FakeCortadelClient) -> None:
    memory = build(fake_client, read_only=True)
    assert memory.remember("nope") is None
    assert memory.remember_many(["nope"]) == []
    assert fake_client.added == []


def test_remember_many_stores_each_item(fake_client: FakeCortadelClient) -> None:
    records = build(fake_client).remember_many(["one", "two", "three"])
    assert len(records) == 3
    assert [t for t, _ in fake_client.added] == ["one", "two", "three"]


def test_remember_conversation_uses_add_conversation(
    fake_client: FakeCortadelClient,
) -> None:
    records = build(fake_client).remember_conversation(
        [
            ChatMessage(role="user", content="Where do I deploy?"),
            ChatMessage(role="assistant", content="Deploy to the staging cluster."),
        ],
        session_id="run-1",
        project="acme",
    )

    assert [r.content for r in records] == ["A distilled fact."]
    messages, options = fake_client.conversations[0]
    assert [m.role for m in messages] == ["user", "assistant"]
    assert options.session_id == "run-1"
    assert options.project == "acme"


def test_remember_conversation_handles_no_facts_extracted(
    fake_client: FakeCortadelClient,
) -> None:
    """`results` and `no_facts_extracted` are mutually exclusive on the wire."""
    fake_client.conversation = ConversationResult(no_facts_extracted=True)
    records = build(fake_client).remember_conversation(
        [ChatMessage(role="user", content="hi")]
    )
    assert records == []


# ------------------------------------------------------------------- listing


def test_list_records_maps_list_items(fake_client: FakeCortadelClient) -> None:
    fake_client.items = [
        MemoryListItem(id="m1", content="First.", created_at=1_760_000_000),
        MemoryListItem(id="m2", content="Second.", created_at=1_760_000_100),
    ]
    records = build(fake_client).list_records(limit=50)
    assert [r.content for r in records] == ["First.", "Second."]
    assert fake_client.lists[0].size == 50


def test_list_records_caps_page_size_at_cortadel_max(
    fake_client: FakeCortadelClient,
) -> None:
    build(fake_client).list_records(limit=5000)
    assert fake_client.lists[0].size == 100


# ------------------------------------------------------------------ mutation


def test_forget_deletes_by_id(fake_client: FakeCortadelClient) -> None:
    assert build(fake_client).forget(record_ids=["m1", "m2"]) == 2
    assert fake_client.deleted == [["m1", "m2"]]


def test_forget_without_ids_deletes_nothing(fake_client: FakeCortadelClient) -> None:
    """Criteria-based deletion has no Cortadel equivalent — never guess."""
    assert build(fake_client).forget(scope="/team", categories=["ops"]) == 0
    assert fake_client.deleted == []


def test_reset_and_update_are_inert(fake_client: FakeCortadelClient) -> None:
    memory = build(fake_client)
    assert memory.update("m1", content="x") is None
    # The parent's signature is positional — update(record_id, content, ...) —
    # so a **kwargs-only override would TypeError here.
    assert memory.update("m1", "new text") is None
    assert memory.reset() is None
    assert memory.reset_all() is None
    assert fake_client.deleted == []


def test_list_records_offset_is_floored_to_a_page(
    fake_client: FakeCortadelClient,
) -> None:
    """Cortadel paginates by page/size, so an offset mid-page rounds down."""
    build(fake_client).list_records(limit=50, offset=25)
    assert fake_client.lists[0].page == 1

    build(fake_client).list_records(limit=50, offset=50)
    assert fake_client.lists[1].page == 2


def test_close_closes_only_a_client_it_owns(fake_client: FakeCortadelClient) -> None:
    """An injected client belongs to the caller."""
    build(fake_client).close()
    assert fake_client.closed is False


# ------------------------------------------------------- graceful degradation


def test_recall_degrades_to_empty_when_server_unreachable(
    broken_client: BrokenCortadelClient,
) -> None:
    """Memory must never take down the agent."""
    assert build(broken_client).recall("q") == []


def test_remember_degrades_to_an_unpersisted_record(
    broken_client: BrokenCortadelClient,
) -> None:
    """A failed write must not return None.

    CrewAI's own `Save to memory` tool reads `record.scope` / `record.importance`
    straight off this return value with no None check, so a None would turn a
    dead Cortadel server into an AttributeError inside the agent loop.
    """
    record = build(broken_client).remember("a fact")

    assert isinstance(record, MemoryRecord)
    assert record.id == ""  # nothing was stored, so there is no id to address
    assert record.content == "a fact"
    assert record.metadata["cortadel_persisted"] is False
    assert record.metadata["cortadel_event"] == "DEGRADED"


def test_builtin_remember_tool_survives_a_dead_server(
    broken_client: BrokenCortadelClient,
) -> None:
    """The advertised 'CrewAI's own memory tools route to Cortadel' must also
    hold when Cortadel is down — otherwise the agent burns a retry on a
    ToolUsageError instead of continuing without memory."""
    from crewai.tools.memory_tools import create_memory_tools

    tools = create_memory_tools(build(broken_client))
    remember_tool = next(t for t in tools if t.name == "Save to memory")

    assert "Saved to memory" in remember_tool._run(contents=["A new fact."])


def test_other_writes_degrade_when_server_unreachable(
    broken_client: BrokenCortadelClient,
) -> None:
    # remember_many returns only what was *created*, so a dead server yields [].
    assert build(broken_client).remember_many(["a", "b"]) == []
    assert build(broken_client).list_records() == []
    assert build(broken_client).forget(record_ids=["m1"]) == 0


def test_raise_on_error_propagates_errors(broken_client: BrokenCortadelClient) -> None:
    from cortadel import CortadelError

    memory = build(broken_client, raise_on_error=True)
    with pytest.raises(CortadelError):
        memory.recall("q")
    with pytest.raises(CortadelError):
        memory.remember("a fact")


def test_fail_open_is_the_default(broken_client: BrokenCortadelClient) -> None:
    """A memory outage must never take the agent down unless asked to."""
    memory = build(broken_client)
    assert memory.raise_on_error is False
    assert memory.on_error is None
    assert memory.recall("q") == []


def test_failure_is_logged_not_silent(
    broken_client: BrokenCortadelClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("WARNING", logger="cortadel_crewai"):
        build(broken_client).recall("q")
    assert "search failed" in caplog.text


def test_on_error_callback_observes_swallowed_failures(
    broken_client: BrokenCortadelClient, caplog: pytest.LogCaptureFixture
) -> None:
    """A callback replaces the warning — you are already being told."""
    seen: list[BaseException] = []
    memory = build(broken_client, on_error=seen.append)

    with caplog.at_level("WARNING", logger="cortadel_crewai"):
        assert memory.recall("q") == []

    assert [type(e).__name__ for e in seen] == ["CortadelError"]
    assert "search failed" not in caplog.text


def test_on_error_callback_also_fires_when_raising(
    broken_client: BrokenCortadelClient,
) -> None:
    """It is an observer, not a handler: raise_on_error still re-raises."""
    from cortadel import CortadelError

    seen: list[BaseException] = []
    memory = build(broken_client, raise_on_error=True, on_error=seen.append)

    with pytest.raises(CortadelError):
        memory.recall("q")
    assert len(seen) == 1


def test_a_broken_on_error_callback_cannot_mask_the_failure(
    broken_client: BrokenCortadelClient,
) -> None:
    """An observer that itself raises must not become the error the caller sees."""

    def explode(exc: BaseException) -> None:
        raise RuntimeError("the callback is broken too")

    assert build(broken_client, on_error=explode).recall("q") == []


def test_on_error_never_lands_in_a_model_dump(
    fake_client: FakeCortadelClient,
) -> None:
    """Crew.copy() dumps every agent; a callable field would break that."""
    memory = build(fake_client, on_error=lambda exc: None)
    assert "on_error" not in memory.model_dump()


# ------------------------------------------------------------ crewai plumbing


def test_scope_view_delegates_to_cortadel(fake_client: FakeCortadelClient) -> None:
    """Agent(memory=memory.scope(...)) must still reach Cortadel."""
    fake_client.hits = [make_hit()]
    view = build(fake_client).scope("/agent/researcher")
    assert len(view.recall("q")) == 1
    assert fake_client.searches


def test_builtin_crewai_memory_tools_route_to_cortadel(
    fake_client: FakeCortadelClient,
) -> None:
    """CrewAI's own RecallMemoryTool/RememberTool duck-type onto recall/remember."""
    from crewai.tools.memory_tools import create_memory_tools

    fake_client.hits = [make_hit(content="Alice ships on Fridays.")]
    tools = create_memory_tools(build(fake_client))

    recall_tool = next(t for t in tools if t.name == "Search memory")
    assert "Alice ships on Fridays." in recall_tool._run(queries=["when?"])

    remember_tool = next(t for t in tools if t.name == "Save to memory")
    remember_tool._run(contents=["A new fact."])
    assert fake_client.added[0][0] == "A new fact."


def test_arecall_delegates_to_the_sync_override(
    fake_client: FakeCortadelClient,
) -> None:
    import asyncio

    fake_client.hits = [make_hit()]
    matches = asyncio.run(build(fake_client).arecall("q"))
    assert len(matches) == 1
