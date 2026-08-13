"""The `CortadelMemory` capability, exercised directly through its hooks."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import E2E_USER, ClientRegistry, any_ctx, hit
from cortadel import CortadelError
from pydantic_ai.capabilities import AbstractCapability

from cortadel_pydantic_ai import CortadelMemory


def make(registry: ClientRegistry, **kwargs: Any) -> CortadelMemory[Any]:
    kwargs.setdefault("base_url", "http://localhost:3001")
    kwargs.setdefault("user_id", E2E_USER)
    return CortadelMemory(client_factory=registry, **kwargs)


class FakeResult:
    """Stands in for `AgentRunResult` — `after_run` only reads `new_messages()`."""

    def __init__(self, messages: list[Any]) -> None:
        self._messages = messages

    def new_messages(self, **_kwargs: Any) -> list[Any]:
        return self._messages


class TestConstruction:
    def test_it_is_a_pydantic_ai_capability(self, registry: ClientRegistry) -> None:
        assert isinstance(make(registry), AbstractCapability)

    def test_user_id_is_required(self) -> None:
        with pytest.raises(ValueError, match="user_id"):
            CortadelMemory(base_url="http://localhost:3001")

    def test_blank_user_id_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="user_id"):
            CortadelMemory(user_id="   ")

    def test_settings_fall_back_to_the_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CORTADEL_BASE_URL", "https://app.cortadel.ai")
        monkeypatch.setenv("CORTADEL_USER_ID", "e2e-from-env")
        monkeypatch.setenv("CORTADEL_API_KEY", "not-a-real-key")
        cap: CortadelMemory[Any] = CortadelMemory()
        assert cap._backend.base_url == "https://app.cortadel.ai"
        assert cap._backend.user_id == "e2e-from-env"
        assert cap._backend.api_key == "not-a-real-key"

    def test_explicit_arguments_beat_the_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CORTADEL_USER_ID", "e2e-from-env")
        cap: CortadelMemory[Any] = CortadelMemory(user_id="e2e-explicit")
        assert cap._backend.user_id == "e2e-explicit"

    def test_it_is_not_spec_serializable(self, registry: ClientRegistry) -> None:
        # Its options include callables, which a YAML/JSON agent spec cannot express.
        assert CortadelMemory.get_serialization_name() is None


class TestToolsetContribution:
    def test_tools_are_contributed_by_default(self, registry: ClientRegistry) -> None:
        toolset = make(registry).get_toolset()
        assert toolset is not None
        assert sorted(toolset.tools) == ["add_memories", "search_memory"]

    def test_tools_can_be_switched_off(self, registry: ClientRegistry) -> None:
        assert make(registry, tools=False).get_toolset() is None

    def test_the_toolset_shares_the_capabilitys_client_cache(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        toolset = cap.get_toolset()
        assert toolset is not None
        # One backend, so the tool and the recall path reuse the same pooled client.
        assert cap._backend.client_for(any_ctx()) is registry.only()


class TestRecall:
    async def test_hits_are_rendered_into_instructions(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        block = await cap._recall_instructions(any_ctx(prompt="preferences?"))
        assert block is not None
        assert "- Alice prefers dark mode." in block
        assert "- Alice ships on Fridays." in block

    async def test_get_instructions_returns_the_recall_callable(self, registry: ClientRegistry) -> None:
        assert make(registry).get_instructions() is not None

    async def test_recall_can_be_switched_off(self, registry: ClientRegistry) -> None:
        assert make(registry, recall=False).get_instructions() is None

    async def test_no_hits_injects_nothing(self) -> None:
        cap = make(ClientRegistry(hits=[]))
        assert await cap._recall_instructions(any_ctx(prompt="q")) is None

    async def test_no_query_skips_the_search_entirely(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        assert await cap._recall_instructions(any_ctx()) is None
        assert registry.clients == {}

    async def test_the_search_runs_once_per_run_not_once_per_step(self, registry: ClientRegistry) -> None:
        # Instructions are re-resolved on every model request; a five-step tool loop must still
        # make exactly one Cortadel call.
        cap = make(registry)
        ctx = any_ctx(prompt="preferences?")
        blocks = [await cap._recall_instructions(ctx) for _ in range(5)]
        assert len(registry.only().searches) == 1
        assert len(set(blocks)) == 1

    async def test_an_empty_recall_is_also_cached(self) -> None:
        registry = ClientRegistry(hits=[])
        cap = make(registry)
        ctx = any_ctx(prompt="q")
        await cap._recall_instructions(ctx)
        await cap._recall_instructions(ctx)
        assert len(registry.only().searches) == 1

    async def test_top_k_defaults_to_five_for_automatic_injection(self, registry: ClientRegistry) -> None:
        # Tighter than the explicit tool's 10: these tokens are spent on every single run.
        cap = make(registry)
        await cap._recall_instructions(any_ctx(prompt="q"))
        assert registry.only().searches[0][1].top_k == 5

    async def test_search_options_are_passed_through(self, registry: ClientRegistry) -> None:
        cap = make(registry, top_k=3, search_mode="vector", rerank=True, memory_type="episodic")
        await cap._recall_instructions(any_ctx(prompt="q"))
        _query, options = registry.only().searches[0]
        assert (options.top_k, options.mode, options.rerank, options.memory_type) == (
            3,
            "vector",
            "cross_encoder",
            "episodic",
        )

    async def test_recall_spans_sessions_by_default(self, registry: ClientRegistry) -> None:
        # The whole point of long-term memory: do not hide earlier conversations.
        cap = make(registry)
        await cap._recall_instructions(any_ctx(prompt="q", conversation_id="conv-1"))
        assert registry.only().searches[0][1].session_id is None

    async def test_recall_can_be_scoped_to_the_session_on_request(self, registry: ClientRegistry) -> None:
        cap = make(registry, scope_recall_to_session=True)
        await cap._recall_instructions(any_ctx(prompt="q", conversation_id="conv-1"))
        assert registry.only().searches[0][1].session_id == "conv-1"

    async def test_a_custom_header_is_used(self, registry: ClientRegistry) -> None:
        cap = make(registry, instructions_header="KNOWN FACTS:")
        block = await cap._recall_instructions(any_ctx(prompt="q"))
        assert block is not None and block.startswith("KNOWN FACTS:")

    async def test_an_unreachable_server_injects_nothing(self, failing_registry: ClientRegistry) -> None:
        cap = make(failing_registry)
        assert await cap._recall_instructions(any_ctx(prompt="q")) is None

    async def test_recall_failures_reach_on_error(self, failing_registry: ClientRegistry) -> None:
        seen: list[Exception] = []
        cap = make(failing_registry, on_error=seen.append)
        await cap._recall_instructions(any_ctx(prompt="q"))
        assert len(seen) == 1 and isinstance(seen[0], CortadelError)


class TestErrorPolicy:
    async def test_failures_are_swallowed_by_default(self, failing_registry: ClientRegistry) -> None:
        cap = make(failing_registry)
        assert await cap._recall_instructions(any_ctx(prompt="q")) is None

    async def test_raise_on_error_propagates_the_failure(self, failing_registry: ClientRegistry) -> None:
        cap = make(failing_registry, raise_on_error=True)
        with pytest.raises(CortadelError):
            await cap._recall_instructions(any_ctx(prompt="q"))

    async def test_on_error_still_fires_before_the_re_raise(
        self, failing_registry: ClientRegistry
    ) -> None:
        # The two knobs compose rather than replace each other: observe first, then decide
        # whether the run dies.
        seen: list[Exception] = []
        cap = make(failing_registry, on_error=seen.append, raise_on_error=True)
        with pytest.raises(CortadelError) as caught:
            await cap._recall_instructions(any_ctx(prompt="q"))
        assert seen == [caught.value]

    async def test_raise_on_error_also_covers_persistence(
        self, failing_registry: ClientRegistry
    ) -> None:
        from pydantic_ai.messages import ModelRequest, UserPromptPart

        cap = make(failing_registry, raise_on_error=True)
        result = FakeResult([ModelRequest(parts=[UserPromptPart(content="I prefer metric.")])])
        with pytest.raises(CortadelError):
            await cap.after_run(any_ctx(), result=result)

    async def test_a_swallowed_failure_without_a_callback_warns(
        self, failing_registry: ClientRegistry, caplog: pytest.LogCaptureFixture
    ) -> None:
        cap = make(failing_registry)
        with caplog.at_level("WARNING", logger="cortadel_pydantic_ai"):
            await cap._recall_instructions(any_ctx(prompt="q"))
        assert any("memory call failed" in record.getMessage() for record in caplog.records)


class TestPerRunIsolation:
    async def test_for_run_returns_a_copy_with_a_fresh_recall_cache(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        await cap._recall_instructions(any_ctx(prompt="first"))

        run_copy = await cap.for_run(any_ctx())
        assert run_copy is not cap
        assert run_copy._recalled is None
        assert run_copy._recall_done is False

        await run_copy._recall_instructions(any_ctx(prompt="second"))
        assert [q for q, _ in registry.only().searches] == ["first", "second"]

    async def test_the_copy_keeps_sharing_the_pooled_clients(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        run_copy = await cap.for_run(any_ctx())
        # Same backend object, so HTTP keep-alive survives across runs.
        assert run_copy._backend is cap._backend

    async def test_concurrent_runs_do_not_see_each_others_memories(self) -> None:
        registry = ClientRegistry(hits=[hit("shared fact")])
        cap = make(registry, user_id=lambda ctx: ctx.deps.user_id)

        alice = await cap.for_run(any_ctx())
        bob = await cap.for_run(any_ctx())
        await alice._recall_instructions(any_ctx(prompt="q", deps=any_ctx(user_id="e2e-alice")))
        await bob._recall_instructions(any_ctx(prompt="q", deps=any_ctx(user_id="e2e-bob")))

        assert sorted(registry.clients) == ["e2e-alice", "e2e-bob"]
        assert len(registry.clients["e2e-alice"].searches) == 1
        assert len(registry.clients["e2e-bob"].searches) == 1


class TestPersistence:
    def turn(self) -> FakeResult:
        from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

        return FakeResult(
            [
                ModelRequest(parts=[UserPromptPart(content="I prefer metric units.")]),
                ModelResponse(parts=[TextPart(content="Noted.")]),
            ]
        )

    async def test_the_turn_is_stored_after_the_run(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        result = self.turn()
        assert await cap.after_run(any_ctx(), result=result) is result

        messages, _options = registry.only().conversations[0]
        assert [(m.role, m.content) for m in messages] == [
            ("user", "I prefer metric units."),
            ("assistant", "Noted."),
        ]

    async def test_the_session_defaults_to_the_conversation_id(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        await cap.after_run(any_ctx(conversation_id="conv-7"), result=self.turn())
        assert registry.only().conversations[0][1].session_id == "conv-7"

    async def test_an_explicit_session_id_wins(self, registry: ClientRegistry) -> None:
        cap = make(registry, session_id="fixed-session")
        await cap.after_run(any_ctx(conversation_id="conv-7"), result=self.turn())
        assert registry.only().conversations[0][1].session_id == "fixed-session"

    async def test_a_callable_session_id_is_resolved(self, registry: ClientRegistry) -> None:
        cap = make(registry, session_id=lambda ctx: f"thread-{ctx.deps.thread}")
        await cap.after_run(any_ctx(deps=any_ctx(thread=9)), result=self.turn())
        assert registry.only().conversations[0][1].session_id == "thread-9"

    async def test_project_and_tags_are_recorded(self, registry: ClientRegistry) -> None:
        cap = make(registry, project="acme/api", tags=["support"])
        await cap.after_run(any_ctx(), result=self.turn())
        options = registry.only().conversations[0][1]
        assert options.project == "acme/api"
        assert options.tags == ["support"]

    async def test_persistence_can_be_switched_off(self, registry: ClientRegistry) -> None:
        cap = make(registry, persist=False)
        await cap.after_run(any_ctx(), result=self.turn())
        assert registry.clients == {}

    async def test_the_write_is_awaited_by_default(self, registry: ClientRegistry) -> None:
        # `after_run` is the last hook in a run, so the safe default is to finish the write
        # before returning rather than leave a task the process may never run.
        cap = make(registry)
        await cap.after_run(any_ctx(), result=self.turn())
        assert registry.only().conversations
        assert cap._backend._pending == set()

    async def test_await_persist_false_defers_the_write_and_aclose_drains_it(
        self, registry: ClientRegistry
    ) -> None:
        cap = make(registry, await_persist=False)
        await cap.after_run(any_ctx(), result=self.turn())
        # Nothing has run yet — the write is a scheduled task, not a completed call.
        assert registry.clients == {}
        assert len(cap._backend._pending) == 1

        await cap.aclose()
        assert registry.only().conversations
        assert cap._backend._pending == set()

    async def test_a_backgrounded_write_failure_cannot_escape(
        self, failing_registry: ClientRegistry
    ) -> None:
        # `raise_on_error` has no caller left to raise into once the write is off the critical
        # path, so the failure is observed and the run is untouched.
        seen: list[Exception] = []
        cap = make(failing_registry, await_persist=False, raise_on_error=True, on_error=seen.append)
        result = self.turn()
        assert await cap.after_run(any_ctx(), result=result) is result
        await cap.aclose()
        assert len(seen) == 1 and isinstance(seen[0], CortadelError)

    async def test_a_turn_with_nothing_conversational_is_not_sent(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        await cap.after_run(any_ctx(), result=FakeResult([]))
        assert registry.clients == {}

    async def test_an_unreachable_server_still_returns_the_result(
        self, failing_registry: ClientRegistry
    ) -> None:
        cap = make(failing_registry)
        result = self.turn()
        assert await cap.after_run(any_ctx(), result=result) is result

    async def test_persistence_failures_reach_on_error(self, failing_registry: ClientRegistry) -> None:
        seen: list[Exception] = []
        cap = make(failing_registry, on_error=seen.append)
        await cap.after_run(any_ctx(), result=self.turn())
        assert len(seen) == 1 and isinstance(seen[0], CortadelError)

    async def test_a_broken_result_object_cannot_fail_the_run(self, registry: ClientRegistry) -> None:
        class Broken:
            def new_messages(self, **_kwargs: Any) -> list[Any]:
                raise RuntimeError("boom")

        cap = make(registry)
        broken = Broken()
        assert await cap.after_run(any_ctx(), result=broken) is broken


class TestLifecycle:
    async def test_aclose_closes_every_pooled_client(self) -> None:
        registry = ClientRegistry(hits=[hit("x")])
        cap = make(registry, user_id=lambda ctx: ctx.deps.user_id)
        await cap._recall_instructions(any_ctx(prompt="q", deps=any_ctx(user_id="e2e-alice")))
        fresh = await cap.for_run(any_ctx())
        await fresh._recall_instructions(any_ctx(prompt="q", deps=any_ctx(user_id="e2e-bob")))

        await cap.aclose()
        assert all(client.closed for client in registry.clients.values())

    async def test_aclose_is_safe_to_call_twice(self, registry: ClientRegistry) -> None:
        cap = make(registry)
        await cap.aclose()
        await cap.aclose()
