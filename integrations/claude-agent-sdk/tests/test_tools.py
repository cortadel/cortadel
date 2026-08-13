"""The memory tools, driven through the real in-process MCP server."""
from __future__ import annotations

import pytest
from conftest import FakeCortadel, call_tool, hit, list_tools, tool_text
from cortadel import CortadelError

from cortadel_claude_agent_sdk import CortadelMemory


@pytest.fixture
def fake() -> FakeCortadel:
    return FakeCortadel()


@pytest.fixture
def memory(fake: FakeCortadel) -> CortadelMemory:
    return CortadelMemory.from_client(fake)


# ── Registration and schema shape ───────────────────────────────────────────────────────────


async def test_registers_exactly_the_two_memory_tools(memory: CortadelMemory) -> None:
    tools = await list_tools(memory)
    assert sorted(tool.name for tool in tools) == ["add_memories", "search_memory"]


async def test_search_schema_requires_query_and_leaves_top_k_optional(
    memory: CortadelMemory,
) -> None:
    (search,) = [tool for tool in await list_tools(memory) if tool.name == "search_memory"]
    assert search.inputSchema["required"] == ["query"]
    assert set(search.inputSchema["properties"]) == {"query", "top_k"}
    assert search.inputSchema["properties"]["top_k"]["type"] == "integer"


async def test_add_schema_requires_text_and_constrains_memory_type(
    memory: CortadelMemory,
) -> None:
    (add,) = [tool for tool in await list_tools(memory) if tool.name == "add_memories"]
    assert add.inputSchema["required"] == ["text"]
    assert add.inputSchema["properties"]["memory_type"]["enum"] == [
        "episodic",
        "semantic",
        "procedural",
    ]


async def test_search_is_annotated_read_only(memory: CortadelMemory) -> None:
    """`readOnlyHint` is what lets Claude batch recall with other read-only calls."""
    (search,) = [tool for tool in await list_tools(memory) if tool.name == "search_memory"]
    assert search.annotations is not None and search.annotations.readOnlyHint is True


async def test_allowed_tools_carry_the_mcp_server_prefix(memory: CortadelMemory) -> None:
    assert memory.allowed_tools == [
        "mcp__cortadel__search_memory",
        "mcp__cortadel__add_memories",
    ]


async def test_server_name_drives_the_prefix(fake: FakeCortadel) -> None:
    memory = CortadelMemory.from_client(fake, server_name="team_memory")
    assert memory.allowed_tools == [
        "mcp__team_memory__search_memory",
        "mcp__team_memory__add_memories",
    ]
    assert memory.mcp_server["name"] == "team_memory"


async def test_mcp_server_is_built_once(memory: CortadelMemory) -> None:
    assert memory.mcp_server is memory.mcp_server


# ── search_memory ───────────────────────────────────────────────────────────────────────────


async def test_search_returns_formatted_hits(fake: FakeCortadel, memory: CortadelMemory) -> None:
    fake.search_results = [hit("mem-a", "Alice ships on Fridays.", rrf_score=0.42)]

    result = await call_tool(memory, "search_memory", {"query": "when does alice ship?"})

    assert not result.isError
    assert tool_text(result) == "- (2026-08-13, score 0.42) [id mem-a] Alice ships on Fridays."


async def test_search_uses_configured_top_k_by_default(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    await call_tool(memory, "search_memory", {"query": "anything at all"})

    (query, options) = fake.searches[0]
    assert query == "anything at all"
    assert options is not None and options.top_k == 5 and options.mode == "hybrid"


async def test_search_honours_an_explicit_top_k(fake: FakeCortadel, memory: CortadelMemory) -> None:
    await call_tool(memory, "search_memory", {"query": "anything at all", "top_k": 3})

    assert fake.searches[0][1].top_k == 3


async def test_search_clamps_top_k_to_the_server_range(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    """The SDK's own schema validation rejects out-of-range values, but a direct handler call
    should still not send the server a top_k it will reject."""
    await memory._tool_search({"query": "anything at all", "top_k": 900})

    assert fake.searches[0][1].top_k == 50


async def test_search_reports_an_empty_result_set(memory: CortadelMemory) -> None:
    result = await call_tool(memory, "search_memory", {"query": "nothing stored yet"})

    assert not result.isError
    assert "No memories found" in tool_text(result)


async def test_search_rejects_a_missing_query(memory: CortadelMemory) -> None:
    """Enforced by the MCP server from the JSON Schema, before our handler runs."""
    result = await call_tool(memory, "search_memory", {})

    assert result.isError
    assert "query" in tool_text(result)


# ── add_memories ────────────────────────────────────────────────────────────────────────────


async def test_add_stores_the_text_and_stamps_the_app(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    await call_tool(memory, "add_memories", {"text": "Alice prefers dark mode."})

    (text, options) = fake.adds[0]
    assert text == "Alice prefers dark mode."
    assert options is not None and options.app == "cortadel-claude-agent-sdk"
    assert options.memory_type is None


async def test_add_passes_through_memory_type(fake: FakeCortadel, memory: CortadelMemory) -> None:
    await call_tool(memory, "add_memories", {"text": "Deploys go out on Tuesday.", "memory_type": "procedural"})

    assert fake.adds[0][1].memory_type == "procedural"


async def test_add_surfaces_the_pipeline_event(fake: FakeCortadel, memory: CortadelMemory) -> None:
    """A 2xx does not mean a memory was written — the model needs to see SKIP_DUPLICATE."""
    from cortadel import MemoryCreated

    fake.created = MemoryCreated(id="mem-9", event="SKIP_DUPLICATE")

    result = await call_tool(memory, "add_memories", {"text": "Alice prefers dark mode."})

    assert not result.isError
    assert "mem-9" in tool_text(result) and "SKIP_DUPLICATE" in tool_text(result)


# ── Error propagation ───────────────────────────────────────────────────────────────────────


async def test_search_failure_becomes_an_is_error_result(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    """A tool failure must reach the model as a readable result, not raise into the agent loop."""
    fake.search_error = CortadelError(503, "transport_error", "connection refused")

    result = await call_tool(memory, "search_memory", {"query": "when does alice ship?"})

    assert result.isError
    text = tool_text(result)
    assert "transport_error" in text and "503" in text and "connection refused" in text


async def test_add_failure_becomes_an_is_error_result(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    fake.add_error = CortadelError(422, "validation_error", "text is required")

    result = await call_tool(memory, "add_memories", {"text": "Alice prefers dark mode."})

    assert result.isError
    assert "validation_error" in tool_text(result)


async def test_unexpected_failure_still_becomes_an_is_error_result(
    fake: FakeCortadel, memory: CortadelMemory
) -> None:
    fake.search_error = RuntimeError("boom")

    result = await call_tool(memory, "search_memory", {"query": "when does alice ship?"})

    assert result.isError
    assert "RuntimeError: boom" in tool_text(result)


async def test_a_tool_failure_also_reaches_on_error(fake: FakeCortadel) -> None:
    seen: list[BaseException] = []
    memory = CortadelMemory.from_client(fake, on_error=seen.append)
    fake.search_error = CortadelError(503, "transport_error", "connection refused")

    result = await call_tool(memory, "search_memory", {"query": "when does alice ship?"})

    assert result.isError
    assert [type(exc).__name__ for exc in seen] == ["CortadelError"]


async def test_raise_on_error_does_not_change_tool_behaviour(fake: FakeCortadel) -> None:
    """A tool failure is already surfaced — to the model, as `is_error` — so it is never
    swallowed, and `raise_on_error` has nothing to change."""
    memory = CortadelMemory.from_client(fake, raise_on_error=True)
    fake.add_error = CortadelError(422, "validation_error", "text is required")

    result = await call_tool(memory, "add_memories", {"text": "Alice prefers dark mode."})

    assert result.isError
    assert "validation_error" in tool_text(result)
