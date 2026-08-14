"""The CrewAI-native Cortadel tools: schema shape, behaviour, error handling."""

from __future__ import annotations

import pytest
from crewai.tools import BaseTool

from cortadel_crewai import (
    AddMemoriesSchema,
    CortadelAddMemoriesTool,
    CortadelSearchMemoryTool,
    SearchMemorySchema,
    cortadel_tools,
)
from tests.conftest import TEST_USER_ID, BrokenCortadelClient, FakeCortadelClient, make_hit


# ------------------------------------------------------------ registration


def test_tools_are_crewai_base_tools(fake_client: FakeCortadelClient) -> None:
    tools = cortadel_tools(client=fake_client)
    assert [t.name for t in tools] == ["search_memory", "add_memories"]
    assert all(isinstance(t, BaseTool) for t in tools)


def test_tool_arg_schemas_are_declared(fake_client: FakeCortadelClient) -> None:
    search, add = cortadel_tools(client=fake_client)
    assert search.args_schema is SearchMemorySchema
    assert add.args_schema is AddMemoriesSchema

    fields = search.args_schema.model_json_schema()["properties"]
    assert set(fields) == {"query", "top_k"}
    assert "messages" in add.args_schema.model_json_schema()["properties"]


def test_tools_describe_themselves_for_the_llm(
    fake_client: FakeCortadelClient,
) -> None:
    search, add = cortadel_tools(client=fake_client)
    assert "memory" in search.description.lower()
    assert "memory" in add.description.lower()


def test_cortadel_tools_share_one_client(fake_client: FakeCortadelClient) -> None:
    search, add = cortadel_tools(client=fake_client)
    assert search.client is add.client is fake_client


def test_tool_requires_a_user_id() -> None:
    with pytest.raises(ValueError, match="user_id"):
        CortadelSearchMemoryTool()


def test_tool_api_key_never_leaks_into_repr_or_dump(
    fake_client: FakeCortadelClient,
) -> None:
    """It is a bearer token, and CrewAI reprs tools when verbose."""
    tool = CortadelSearchMemoryTool(client=fake_client, api_key="not-a-real-key")

    assert "not-a-real-key" not in repr(tool)
    assert "api_key" not in tool.model_dump()
    assert tool.api_key == "not-a-real-key"


def test_tools_attach_to_an_agent(fake_client: FakeCortadelClient) -> None:
    from crewai import Agent

    agent = Agent(
        role="r",
        goal="g",
        backstory="b",
        llm="gpt-4o-mini",
        tools=cortadel_tools(client=fake_client),
    )
    assert [t.name for t in agent.tools] == ["search_memory", "add_memories"]


# ----------------------------------------------------------------- searching


def test_search_tool_returns_formatted_memories(
    fake_client: FakeCortadelClient,
) -> None:
    fake_client.hits = [
        make_hit("m1", "Alice prefers dark mode.", categories=["preferences"]),
        make_hit("m2", "Alice ships on Fridays."),
    ]
    tool = CortadelSearchMemoryTool(client=fake_client)

    output = tool._run(query="alice preferences", top_k=5)

    assert "Alice prefers dark mode." in output
    assert "[preferences]" in output
    assert "Alice ships on Fridays." in output
    assert fake_client.searches[0][1].top_k == 5


def test_search_tool_defaults_to_top_k_10(fake_client: FakeCortadelClient) -> None:
    """Matches the Cortadel SDK's own SearchOptions default for an explicit tool."""
    assert SearchMemorySchema.model_fields["top_k"].default == 10
    CortadelSearchMemoryTool(client=fake_client)._run(query="q")
    assert fake_client.searches[0][1].top_k == 10


def test_search_tool_clamps_top_k(fake_client: FakeCortadelClient) -> None:
    CortadelSearchMemoryTool(client=fake_client)._run(query="q", top_k=9999)
    assert fake_client.searches[0][1].top_k == 50


def test_search_tool_reports_no_results(fake_client: FakeCortadelClient) -> None:
    output = CortadelSearchMemoryTool(client=fake_client)._run(query="q")
    assert output == "No relevant memories found."


# ------------------------------------------------------------------- storing


def test_add_tool_stores_each_message(fake_client: FakeCortadelClient) -> None:
    output = CortadelAddMemoriesTool(client=fake_client)._run(
        messages=["Fact one.", "Fact two."]
    )
    assert "Saved 2 memory item(s)." in output
    assert [t for t, _ in fake_client.added] == ["Fact one.", "Fact two."]


def test_add_tool_accepts_a_bare_string(fake_client: FakeCortadelClient) -> None:
    """LLMs frequently pass a string where a list is declared."""
    CortadelAddMemoriesTool(client=fake_client)._run(messages="Just one.")
    assert [t for t, _ in fake_client.added] == ["Just one."]


def test_add_tool_reports_server_side_dedup(fake_client: FakeCortadelClient) -> None:
    """A 2xx does not mean a write happened — Cortadel dedups."""
    fake_client.add_event = "SKIP_DUPLICATE"
    output = CortadelAddMemoriesTool(client=fake_client)._run(messages=["Known."])
    assert "already known" in output
    assert "Saved 0 memory item(s)." in output


def test_add_tool_ignores_blank_input(fake_client: FakeCortadelClient) -> None:
    assert CortadelAddMemoriesTool(client=fake_client)._run(messages=["  ", ""]) == (
        "Nothing to save."
    )
    assert fake_client.added == []


# ------------------------------------------------------- graceful degradation


def test_search_tool_degrades_when_server_unreachable(
    broken_client: BrokenCortadelClient,
) -> None:
    output = CortadelSearchMemoryTool(client=broken_client)._run(query="q")
    assert "temporarily unavailable" in output


def test_add_tool_degrades_when_server_unreachable(
    broken_client: BrokenCortadelClient,
) -> None:
    output = CortadelAddMemoriesTool(client=broken_client)._run(messages=["a fact"])
    assert "temporarily unavailable" in output


def test_raise_on_error_tool_propagates_errors(
    broken_client: BrokenCortadelClient,
) -> None:
    from cortadel import CortadelError

    tool = CortadelSearchMemoryTool(client=broken_client, raise_on_error=True)

    # Only _run() is inside the block: constructing the tool must not be what
    # raises, or this would still pass with the search path never reached.
    with pytest.raises(CortadelError):
        tool._run(query="q")


def test_cortadel_tools_forwards_error_options(
    broken_client: BrokenCortadelClient,
) -> None:
    """The factory must thread both options onto both tools, or one of them
    silently keeps the fail-open default."""
    seen: list[BaseException] = []

    def record(exc: BaseException) -> None:
        seen.append(exc)

    search, add = cortadel_tools(
        client=broken_client, raise_on_error=True, on_error=record
    )

    assert (search.raise_on_error, add.raise_on_error) == (True, True)
    assert search.on_error is record
    assert add.on_error is record


def test_tool_on_error_callback_observes_swallowed_failures(
    broken_client: BrokenCortadelClient,
) -> None:
    seen: list[BaseException] = []
    output = CortadelAddMemoriesTool(client=broken_client, on_error=seen.append)._run(
        messages=["a fact"]
    )

    assert "temporarily unavailable" in output
    assert [type(e).__name__ for e in seen] == ["CortadelError"]
