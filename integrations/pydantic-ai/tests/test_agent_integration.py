"""End-to-end tests: a real `Agent`, driven by pydantic-ai's in-process models.

`FunctionModel` and `TestModel` need no API key and make no network calls, so these exercise the
genuine capability lifecycle — `for_run`, `get_toolset`, `get_instructions`, `after_run` — with
only the Cortadel client stubbed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from conftest import ClientRegistry, hit
from cortadel import CortadelError
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from cortadel_pydantic_ai import CortadelMemory

MARKER = "Alice is allergic to peanuts."


def marker_registry() -> ClientRegistry:
    return ClientRegistry(hits=[hit(MARKER, "m1")])


class Recorder:
    """A `FunctionModel` body that records what the model was given and replies with text."""

    def __init__(self, reply: str = "ok") -> None:
        self.reply = reply
        self.calls: list[list[ModelMessage]] = []
        self.infos: list[AgentInfo] = []
        # FunctionModel derives its model name from `function.__name__`.
        self.__name__ = "recorder"

    def __call__(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        self.calls.append(list(messages))
        self.infos.append(info)
        return ModelResponse(parts=[TextPart(self.reply)])

    @property
    def last_instructions(self) -> str:
        for message in reversed(self.calls[-1]):
            instructions = getattr(message, "instructions", None)
            if instructions:
                return instructions
        return ""


def build(registry: ClientRegistry, model: Any, **kwargs: Any) -> tuple[Agent, CortadelMemory[Any]]:
    kwargs.setdefault("instructions", "Be brief.")
    deps_type = kwargs.pop("deps_type", None)
    memory: CortadelMemory[Any] = CortadelMemory(
        base_url="http://localhost:3001",
        user_id=kwargs.pop("user_id", "e2e-pydantic-ai-agent"),
        client_factory=registry,
        **kwargs.pop("memory_kwargs", {}),
    )
    agent_kwargs: dict[str, Any] = {"capabilities": [memory], **kwargs}
    if deps_type is not None:
        agent_kwargs["deps_type"] = deps_type
    return Agent(model, **agent_kwargs), memory


class TestToolsReachTheModel:
    async def test_the_model_is_offered_both_memory_tools(self) -> None:
        recorder = Recorder()
        agent, _ = build(marker_registry(), FunctionModel(recorder))
        await agent.run("hello")
        assert sorted(t.name for t in recorder.infos[-1].function_tools) == [
            "add_memories",
            "search_memory",
        ]

    async def test_the_model_can_actually_call_search_memory(self) -> None:
        registry = marker_registry()
        step = {"n": 0}

        def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            step["n"] += 1
            if step["n"] == 1:
                return ModelResponse(
                    parts=[ToolCallPart("search_memory", {"query": "allergies"}, tool_call_id="c1")]
                )
            return ModelResponse(parts=[TextPart("done")])

        agent, _ = build(registry, FunctionModel(model), memory_kwargs={"recall": False})
        result = await agent.run("what am I allergic to?")

        assert result.output == "done"
        # The tool call reached Cortadel and its result came back into the transcript.
        assert [q for q, _ in registry.only().searches] == ["allergies"]
        returns = [
            part.content
            for message in result.all_messages()
            for part in message.parts
            if getattr(part, "part_kind", None) == "tool-return"
        ]
        assert any(MARKER in str(content) for content in returns)

    async def test_tools_disabled_means_the_model_sees_none(self) -> None:
        recorder = Recorder()
        agent, _ = build(marker_registry(), FunctionModel(recorder), memory_kwargs={"tools": False})
        await agent.run("hello")
        assert recorder.infos[-1].function_tools == []


class TestAutomaticRecall:
    async def test_memories_are_injected_before_the_model_runs(self) -> None:
        recorder = Recorder()
        agent, _ = build(marker_registry(), FunctionModel(recorder))
        await agent.run("suggest a dessert")
        assert MARKER in recorder.last_instructions

    async def test_the_agents_own_instructions_come_first(self) -> None:
        recorder = Recorder()
        agent, _ = build(marker_registry(), FunctionModel(recorder))
        await agent.run("suggest a dessert")
        instructions = recorder.last_instructions
        assert instructions.index("Be brief.") < instructions.index(MARKER)

    async def test_the_run_prompt_is_the_search_query(self) -> None:
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(Recorder()))
        await agent.run("suggest a dessert")
        assert [q for q, _ in registry.only().searches] == ["suggest a dessert"]

    async def test_one_search_per_run_across_a_multi_step_tool_loop(self) -> None:
        registry = marker_registry()
        step = {"n": 0}

        def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            step["n"] += 1
            if step["n"] <= 3:
                return ModelResponse(
                    parts=[ToolCallPart("add_memories", {"text": f"fact {step['n']}"}, tool_call_id=f"c{step['n']}")]
                )
            return ModelResponse(parts=[TextPart("done")])

        agent, _ = build(registry, FunctionModel(model))
        await agent.run("remember some things")

        assert step["n"] == 4  # four model requests...
        assert len(registry.only().searches) == 1  # ...but a single recall

    async def test_recall_disabled_injects_nothing(self) -> None:
        recorder = Recorder()
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(recorder), memory_kwargs={"recall": False})
        await agent.run("suggest a dessert")
        assert MARKER not in recorder.last_instructions
        # No recall, but persistence still runs — so the client exists, unsearched.
        assert registry.only().searches == []

    async def test_an_empty_recall_leaves_the_prompt_untouched(self) -> None:
        recorder = Recorder()
        agent, _ = build(ClientRegistry(hits=[]), FunctionModel(recorder))
        await agent.run("suggest a dessert")
        # No hits means no instruction at all — not an empty "memories:" section.
        assert recorder.last_instructions.strip() == "Be brief."


class TestAutomaticPersistence:
    async def test_the_turn_is_stored_after_the_run(self) -> None:
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(Recorder("Sorbet.")))
        await agent.run("suggest a dessert")

        messages, options = registry.only().conversations[0]
        assert [(m.role, m.content) for m in messages] == [
            ("user", "suggest a dessert"),
            ("assistant", "Sorbet."),
        ]
        assert options.session_id  # defaults to the run's conversation id

    async def test_each_turn_stores_only_its_own_messages(self) -> None:
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(Recorder("ok")))

        first = await agent.run("turn one")
        await agent.run("turn two", message_history=first.all_messages())

        client = registry.only()
        assert len(client.conversations) == 2
        # `new_messages()`, not `all_messages()`: turn two must not re-send turn one.
        assert [(m.role, m.content) for m in client.conversations[1][0]] == [
            ("user", "turn two"),
            ("assistant", "ok"),
        ]

    async def test_both_turns_share_a_conversation_id(self) -> None:
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(Recorder()))
        first = await agent.run("turn one")
        await agent.run("turn two", message_history=first.all_messages())

        sessions = [options.session_id for _messages, options in registry.only().conversations]
        assert sessions[0] and sessions[0] == sessions[1]

    async def test_persist_disabled_stores_nothing(self) -> None:
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(Recorder()), memory_kwargs={"persist": False})
        await agent.run("hello")
        assert registry.only().conversations == []

    async def test_await_persist_false_lands_the_write_by_aclose(self) -> None:
        registry = marker_registry()
        agent, memory = build(
            registry, FunctionModel(Recorder("ok")), memory_kwargs={"await_persist": False}
        )
        await agent.run("hello")
        await memory.aclose()  # drains the backgrounded write before closing the pool
        assert [(m.role, m.content) for m in registry.only().conversations[0][0]] == [
            ("user", "hello"),
            ("assistant", "ok"),
        ]


class TestMultiTurnInjection:
    async def test_replaying_history_sends_exactly_one_memory_block(self) -> None:
        recorder = Recorder()
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(recorder))

        first = await agent.run("turn one")
        await agent.run("turn two", message_history=first.all_messages())

        # Instructions are rebuilt per request, so the second turn carries one block, not two.
        assert recorder.last_instructions.count(MARKER) == 1

    async def test_recalled_memories_never_become_conversation_parts(self) -> None:
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(Recorder()))
        result = await agent.run("turn one")

        rendered_parts = [
            str(getattr(part, "content", ""))
            for message in result.all_messages()
            for part in message.parts
        ]
        assert all(MARKER not in text for text in rendered_parts)

    async def test_each_turn_searches_with_its_own_prompt(self) -> None:
        registry = marker_registry()
        agent, _ = build(registry, FunctionModel(Recorder()))
        first = await agent.run("turn one")
        await agent.run("turn two", message_history=first.all_messages())
        assert [q for q, _ in registry.only().searches] == ["turn one", "turn two"]


class TestPerUserScoping:
    async def test_deps_select_the_memory_namespace(self) -> None:
        @dataclass
        class Deps:
            user_id: str

        registry = marker_registry()
        agent, _ = build(
            registry,
            FunctionModel(Recorder()),
            deps_type=Deps,
            user_id=lambda ctx: ctx.deps.user_id,
        )

        await agent.run("hello", deps=Deps(user_id="e2e-alice"))
        await agent.run("hello", deps=Deps(user_id="e2e-bob"))

        assert sorted(registry.clients) == ["e2e-alice", "e2e-bob"]
        assert len(registry.clients["e2e-alice"].conversations) == 1
        assert len(registry.clients["e2e-bob"].conversations) == 1


class TestDegradation:
    async def test_the_run_succeeds_when_cortadel_is_unreachable(
        self, failing_registry: ClientRegistry
    ) -> None:
        recorder = Recorder("still works")
        agent, _ = build(failing_registry, FunctionModel(recorder))
        result = await agent.run("suggest a dessert")

        assert result.output == "still works"
        assert recorder.last_instructions.strip() == "Be brief."

    async def test_failures_are_reported_not_raised(self, failing_registry: ClientRegistry) -> None:
        seen: list[Exception] = []
        agent, _ = build(
            failing_registry,
            FunctionModel(Recorder()),
            memory_kwargs={"on_error": seen.append},
        )
        await agent.run("hello")
        # One failed recall plus one failed persist.
        assert len(seen) == 2

    async def test_raise_on_error_fails_the_run_instead(
        self, failing_registry: ClientRegistry
    ) -> None:
        # The opt-in inverse of every other test in this class: the run dies with Cortadel.
        agent, _ = build(
            failing_registry,
            FunctionModel(Recorder()),
            memory_kwargs={"raise_on_error": True},
        )
        # The failure surfaces unwrapped: pydantic-ai lets an instructions function's exception
        # through as-is, so callers can catch `CortadelError` itself.
        with pytest.raises(CortadelError):
            await agent.run("hello")

    async def test_it_works_with_test_model_too(self) -> None:
        registry = marker_registry()
        agent, memory = build(registry, TestModel())
        result = await agent.run("hello")
        assert result.output is not None
        await memory.aclose()
        assert registry.only().closed
