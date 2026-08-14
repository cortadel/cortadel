"""The memory tools: registration, schema, behaviour, scoping and error handling."""

from __future__ import annotations

import pytest
from cortadel import CortadelError, MemoryCreated

from conftest import E2E_USER, ClientRegistry, FakeCortadelClient, any_ctx, hit
from cortadel_pydantic_ai import TOOLSET_ID, cortadel_toolset
from cortadel_pydantic_ai._backend import Backend
from cortadel_pydantic_ai.toolset import build_toolset


def make_toolset(registry: ClientRegistry, **kwargs):
    backend = Backend(
        base_url="http://localhost:3001",
        user_id=kwargs.pop("user_id", E2E_USER),
        client_factory=registry,
        on_error=kwargs.pop("on_error", None),
        raise_on_error=kwargs.pop("raise_on_error", False),
    )
    return build_toolset(backend, **kwargs), backend


def fn(toolset, name: str):
    """The underlying coroutine for a registered tool, callable directly with a ctx."""
    return toolset.tools[name].function


class TestRegistration:
    def test_both_tools_are_registered_with_a_stable_toolset_id(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        assert toolset.id == TOOLSET_ID
        assert sorted(toolset.tools) == ["add_memories", "search_memory"]

    def test_tools_receive_the_run_context(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        assert toolset.tools["search_memory"].takes_ctx is True
        assert toolset.tools["add_memories"].takes_ctx is True

    def test_search_memory_schema(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        schema = toolset.tools["search_memory"].tool_def.parameters_json_schema
        assert schema["required"] == ["query"]
        assert schema["properties"]["query"]["type"] == "string"
        # The explicit-tool default: the model asked for these, so it gets the SDK's own 10.
        assert schema["properties"]["top_k"]["default"] == 10

    def test_add_memories_schema(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        schema = toolset.tools["add_memories"].tool_def.parameters_json_schema
        assert schema["required"] == ["text"]
        assert schema["properties"]["text"]["type"] == "string"

    def test_descriptions_come_from_the_docstrings(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        assert "long-term memory" in (toolset.tools["search_memory"].tool_def.description or "")
        assert "long-term memory" in (toolset.tools["add_memories"].tool_def.description or "")

    def test_toolset_id_is_overridable(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry, id="custom-id")
        assert toolset.id == "custom-id"


class TestSearchMemory:
    async def test_returns_hits_as_a_bulleted_list(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        out = await fn(toolset, "search_memory")(any_ctx(), "preferences")
        assert out == "- Alice prefers dark mode.\n- Alice ships on Fridays."

    async def test_passes_search_options_through(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry, search_mode="vector", rerank=True, memory_type="semantic")
        await fn(toolset, "search_memory")(any_ctx(), "preferences", 3)
        _query, options = registry.only().searches[0]
        assert options.top_k == 3
        assert options.mode == "vector"
        # The server accepts exactly one rerank value; the flag maps onto it.
        assert options.rerank == "cross_encoder"
        assert options.memory_type == "semantic"

    async def test_rerank_off_omits_the_option_entirely(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        await fn(toolset, "search_memory")(any_ctx(), "q")
        assert registry.only().searches[0][1].rerank is None

    async def test_top_k_is_clamped_to_the_servers_range(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        await fn(toolset, "search_memory")(any_ctx(), "q", 9999)
        assert registry.only().searches[0][1].top_k == 50
        await fn(toolset, "search_memory")(any_ctx(), "q", 0)
        assert registry.only().searches[1][1].top_k == 1

    async def test_top_k_defaults_to_ten_for_the_explicit_tool(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        await fn(toolset, "search_memory")(any_ctx(), "q")
        assert registry.only().searches[0][1].top_k == 10

    async def test_the_default_top_k_is_configurable(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry, top_k=3)
        await fn(toolset, "search_memory")(any_ctx(), "q")
        assert registry.only().searches[0][1].top_k == 3

    async def test_no_hits_reads_naturally_to_the_model(self) -> None:
        toolset, _ = make_toolset(ClientRegistry(hits=[]))
        assert await fn(toolset, "search_memory")(any_ctx(), "q") == "No relevant memories found."

    async def test_the_tool_never_scopes_the_search_to_a_session(self, registry: ClientRegistry) -> None:
        # Session scoping would hide everything learned in earlier conversations.
        toolset, _ = make_toolset(registry)
        await fn(toolset, "search_memory")(any_ctx(conversation_id="conv-1"), "q")
        assert registry.only().searches[0][1].session_id is None


class TestAddMemories:
    async def test_stores_the_text_and_confirms(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        out = await fn(toolset, "add_memories")(any_ctx(), "Alice is allergic to peanuts.")
        assert out == "Saved to long-term memory (event: ADD)."
        text, options = registry.only().adds[0]
        assert text == "Alice is allergic to peanuts."
        # `app_name` is only recorded on searches, so the app label rides on AddOptions.app.
        assert options.app == "cortadel-pydantic-ai"

    async def test_reports_deduplication_rather_than_claiming_a_write(self) -> None:
        registry = ClientRegistry()

        class Dedup(FakeCortadelClient):
            async def add(self, text, options=None):
                return MemoryCreated(id="m", content=text, event="SKIP_DUPLICATE")

        registry.clients[E2E_USER] = Dedup(E2E_USER)
        toolset, _ = make_toolset(registry)
        out = await fn(toolset, "add_memories")(any_ctx(), "Known already.")
        assert out == "Already known — no duplicate was created."

    async def test_empty_text_is_rejected_without_a_round_trip(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry)
        assert await fn(toolset, "add_memories")(any_ctx(), "   ") == "Nothing to save: the text was empty."
        assert registry.clients == {}


class TestUserScoping:
    async def test_a_callable_user_id_builds_one_client_per_user(self) -> None:
        registry = ClientRegistry(hits=[hit("shared")])
        toolset, _ = make_toolset(registry, user_id=lambda ctx: ctx.deps.user_id)

        await fn(toolset, "search_memory")(any_ctx(deps=any_ctx(user_id="e2e-alice")), "q")
        await fn(toolset, "search_memory")(any_ctx(deps=any_ctx(user_id="e2e-bob")), "q")

        assert sorted(registry.clients) == ["e2e-alice", "e2e-bob"]
        assert len(registry.clients["e2e-alice"].searches) == 1
        assert len(registry.clients["e2e-bob"].searches) == 1

    async def test_clients_are_pooled_across_calls_for_the_same_user(self, registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(registry, user_id=lambda ctx: ctx.deps.user_id)
        ctx = any_ctx(deps=any_ctx(user_id="e2e-alice"))
        await fn(toolset, "search_memory")(ctx, "one")
        await fn(toolset, "search_memory")(ctx, "two")
        assert registry.built == ["e2e-alice"]

    def test_a_missing_user_id_fails_loudly_at_construction(self) -> None:
        with pytest.raises(ValueError, match="user_id"):
            cortadel_toolset(base_url="http://localhost:3001")

    def test_user_id_can_come_from_the_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CORTADEL_USER_ID", "e2e-from-env")
        toolset = cortadel_toolset()
        assert sorted(toolset.tools) == ["add_memories", "search_memory"]


class TestErrorHandling:
    async def test_search_tells_the_model_memory_is_down_instead_of_raising(
        self, failing_registry: ClientRegistry
    ) -> None:
        toolset, _ = make_toolset(failing_registry)
        out = await fn(toolset, "search_memory")(any_ctx(), "q")
        assert "temporarily unavailable" in out

    async def test_add_tells_the_model_it_was_not_saved(self, failing_registry: ClientRegistry) -> None:
        toolset, _ = make_toolset(failing_registry)
        out = await fn(toolset, "add_memories")(any_ctx(), "fact")
        assert "not saved" in out

    async def test_failures_reach_on_error(self, failing_registry: ClientRegistry) -> None:
        seen: list[Exception] = []
        toolset, _ = make_toolset(failing_registry, on_error=seen.append)
        await fn(toolset, "search_memory")(any_ctx(), "q")
        assert len(seen) == 1
        assert isinstance(seen[0], CortadelError)
        assert seen[0].code == "transport_error"

    async def test_a_broken_on_error_callback_cannot_break_the_run(
        self, failing_registry: ClientRegistry
    ) -> None:
        def explode(_exc: Exception) -> None:
            raise RuntimeError("handler is broken")

        toolset, _ = make_toolset(failing_registry, on_error=explode)
        assert "temporarily unavailable" in await fn(toolset, "search_memory")(any_ctx(), "q")

    async def test_raise_on_error_propagates_instead_of_degrading(
        self, failing_registry: ClientRegistry
    ) -> None:
        toolset, _ = make_toolset(failing_registry, raise_on_error=True)
        search = fn(toolset, "search_memory")
        add = fn(toolset, "add_memories")
        ctx = any_ctx()
        with pytest.raises(CortadelError):
            await search(ctx, "q")
        with pytest.raises(CortadelError):
            await add(ctx, "fact")

    async def test_on_error_still_fires_before_the_re_raise(
        self, failing_registry: ClientRegistry
    ) -> None:
        # The two knobs compose: observe first, then decide whether the run dies.
        seen: list[Exception] = []
        toolset, _ = make_toolset(failing_registry, on_error=seen.append, raise_on_error=True)
        search = fn(toolset, "search_memory")
        ctx = any_ctx()
        with pytest.raises(CortadelError) as caught:
            await search(ctx, "q")
        assert seen == [caught.value]
