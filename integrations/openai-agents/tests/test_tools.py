"""The function tools: schema shape, invocation, user scoping, and failure behaviour."""

from __future__ import annotations

import json

import pytest
from agents import Agent, Runner
from agents.tool import FunctionTool
from agents.tool_context import ToolContext
from conftest import USER_ID, FakeCortadelClient, FakeModel, hit
from cortadel import CortadelError
from cortadel_openai_agents import CortadelSession, cortadel_memory_tools


def tool_context() -> ToolContext:
    return ToolContext(context=None, tool_name="t", tool_call_id="call-1", tool_arguments="{}")


async def invoke(tool: FunctionTool, **arguments: object) -> str:
    return await tool.on_invoke_tool(tool_context(), json.dumps(arguments))


def test_both_tools_are_real_function_tools_with_strict_schemas(fake_client) -> None:
    search, add = cortadel_memory_tools(client=fake_client)

    assert isinstance(search, FunctionTool) and isinstance(add, FunctionTool)
    assert (search.name, add.name) == ("search_memory", "add_memories")
    assert search.strict_json_schema and add.strict_json_schema

    assert search.params_json_schema["required"] == ["query"]
    assert search.params_json_schema["properties"]["query"]["type"] == "string"
    assert search.params_json_schema["additionalProperties"] is False

    assert add.params_json_schema["required"] == ["text"]
    assert add.params_json_schema["properties"]["text"]["type"] == "string"


def test_tool_descriptions_tell_the_model_when_to_use_them(fake_client) -> None:
    search, add = cortadel_memory_tools(client=fake_client)

    assert "long-term memory" in search.description
    assert "long-term memory" in add.description
    # Parameter descriptions come from the Google-style docstrings.
    assert search.params_json_schema["properties"]["query"]["description"]
    assert add.params_json_schema["properties"]["text"]["description"]


async def test_search_memory_returns_numbered_hits(fake_client) -> None:
    fake_client.hits = [hit("Alice prefers dark mode.", memory_id="m1"), hit("Alice ships on Fridays.", memory_id="m2")]
    search, _ = cortadel_memory_tools(client=fake_client)

    output = await invoke(search, query="preferences")

    assert output == "1. Alice prefers dark mode.\n2. Alice ships on Fridays."
    assert fake_client.searches[0][0] == "preferences"


async def test_search_memory_reports_an_empty_result_plainly(fake_client) -> None:
    search, _ = cortadel_memory_tools(client=fake_client)

    assert await invoke(search, query="anything") == "No relevant memories found."


async def test_search_memory_honours_top_k_mode_rerank_and_min_score(fake_client) -> None:
    fake_client.hits = [hit("strong", memory_id="m1", score=0.9), hit("weak", memory_id="m2", score=0.1)]
    search, _ = cortadel_memory_tools(
        client=fake_client, top_k=2, search_mode="text", rerank="cross_encoder", min_score=0.5
    )

    output = await invoke(search, query="q")

    assert output == "1. strong"
    _, options = fake_client.searches[0]
    assert options is not None
    assert (options.top_k, options.mode, options.rerank) == (2, "text", "cross_encoder")


async def test_search_memory_defaults_to_the_cortadel_sdk_top_k(fake_client) -> None:
    """An explicit tool call gets the SDK's own default of 10, not the per-turn injection's 5."""
    search, _ = cortadel_memory_tools(client=fake_client)

    await invoke(search, query="q")

    _, options = fake_client.searches[0]
    assert options is not None
    assert options.top_k == 10
    assert options.session_id is None, "a tool search spans conversations unless scoped"


async def test_search_memory_can_be_scoped_to_one_conversation(fake_client) -> None:
    search, _ = cortadel_memory_tools(client=fake_client, session_id="e2e-scoped-chat")

    await invoke(search, query="q")

    _, options = fake_client.searches[0]
    assert options is not None
    assert options.session_id == "e2e-scoped-chat"


async def test_on_error_observes_tool_failures_instead_of_logging(
    unreachable_client, caplog
) -> None:
    seen: list[Exception] = []
    search, add = cortadel_memory_tools(client=unreachable_client, on_error=seen.append)

    with caplog.at_level("WARNING", logger="cortadel_openai_agents"):
        assert "unavailable" in await invoke(search, query="q")
        assert "unavailable" in await invoke(add, text="t")

    assert [exc.code for exc in seen] == ["transport_error", "transport_error"]  # type: ignore[attr-defined]
    assert caplog.text == ""


async def test_add_memories_stores_and_labels_the_creating_app(fake_client) -> None:
    _, add = cortadel_memory_tools(client=fake_client)

    assert await invoke(add, text="Alice uses Neovim.") == "Stored."

    text, options = fake_client.adds[0]
    assert text == "Alice uses Neovim."
    assert options is not None
    # `app_name` is only recorded on searches; `AddOptions.app` is what labels a written memory.
    assert options.app == "cortadel-openai-agents"


async def test_add_memories_reports_what_the_write_pipeline_actually_did(fake_client) -> None:
    """A 200 is not proof a memory was written — the pipeline may dedupe or supersede."""
    fake_client.add_event = "SKIP_DUPLICATE"
    _, add = cortadel_memory_tools(client=fake_client)
    assert await invoke(add, text="already known") == "Already remembered; nothing new stored."

    fake_client.add_event = "SUPERSEDE"
    assert await invoke(add, text="revised") == "Stored (event: SUPERSEDE)."


async def test_tools_report_an_outage_to_the_model_instead_of_failing_the_run(
    unreachable_client,
) -> None:
    search, add = cortadel_memory_tools(client=unreachable_client)

    assert "unavailable" in await invoke(search, query="q")
    assert "unavailable" in await invoke(add, text="t")


async def test_raise_on_error_fails_the_tool_call_instead(unreachable_client) -> None:
    search, _ = cortadel_memory_tools(client=unreachable_client, raise_on_error=True)

    with pytest.raises(CortadelError):
        await invoke(search, query="q")


def test_a_client_is_built_per_user_and_scoping_is_not_overridable(monkeypatch) -> None:
    built: list[tuple] = []

    def record(user_id, **kwargs):
        built.append((user_id, kwargs))
        return FakeCortadelClient()

    monkeypatch.setattr("cortadel_openai_agents.tools.build_client", record)

    cortadel_memory_tools("e2e-alice", base_url="http://localhost:3001")
    cortadel_memory_tools("e2e-bob", base_url="http://localhost:3001")

    assert [user_id for user_id, _ in built] == ["e2e-alice", "e2e-bob"]

    # No tool takes a user id, because no Cortadel SDK method does.
    search, add = cortadel_memory_tools(client=FakeCortadelClient())
    assert "user_id" not in search.params_json_schema["properties"]
    assert "user_id" not in add.params_json_schema["properties"]


def test_identity_must_be_supplied_exactly_once(fake_client) -> None:
    with pytest.raises(ValueError, match="either user_id or a pre-built client"):
        cortadel_memory_tools()
    with pytest.raises(ValueError, match="not both"):
        cortadel_memory_tools("e2e-alice", client=fake_client)


async def test_a_session_hands_out_tools_bound_to_its_own_client(fake_client) -> None:
    session = CortadelSession(session_id="s", user_id=USER_ID, client=fake_client, top_k=3)

    search, add = session.tools()

    assert (search.name, add.name) == ("search_memory", "add_memories")

    await invoke(search, query="q")
    _, options = fake_client.searches[0]
    assert options is not None
    # The session's retrieval settings win, so a tool call and an automatic recall agree.
    assert options.top_k == 3
    assert options.session_id is None


async def test_session_tools_inherit_scope_recall_to_session(fake_client) -> None:
    session = CortadelSession(
        session_id="e2e-scoped-session",
        user_id=USER_ID,
        client=fake_client,
        scope_recall_to_session=True,
    )

    search, _ = session.tools()
    await invoke(search, query="q")

    _, options = fake_client.searches[0]
    assert options is not None
    assert options.session_id == "e2e-scoped-session"


async def test_an_agent_can_call_search_memory_through_the_runner(fake_client) -> None:
    """The tools are ordinary agent tools — registration goes through the normal path."""
    fake_client.hits = [hit("Alice prefers dark mode.")]
    agent = Agent(
        name="Assistant",
        instructions="Use your memory.",
        model=FakeModel(["Done."]),
        tools=cortadel_memory_tools(client=fake_client),
    )

    result = await Runner.run(agent, "hi")

    assert result.final_output == "Done."
    tool_names = {tool.name for tool in agent.tools}
    assert tool_names == {"search_memory", "add_memories"}
