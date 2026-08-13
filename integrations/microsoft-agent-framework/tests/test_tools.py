# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Tests for the FunctionTool leg — registration/schema shape, behaviour, error propagation."""

from __future__ import annotations

import asyncio
import logging

import pytest
from agent_framework import FunctionTool
from conftest import CortadelError, FakeCortadelClient, hit, invoke_text

from cortadel_agent_framework import (
    add_memories_tool,
    cortadel_memory_tools,
    search_memory_tool,
)

# No module-level `pytest.mark.asyncio`: `asyncio_mode = "auto"` already collects the async tests,
# and marking the sync ones would emit a PytestWarning that `filterwarnings = ["error"]` escalates.


# -- Registration and schema ----------------------------------------------------------------


def test_tools_are_framework_function_tools() -> None:
    """They must be the framework's own tool primitive, not ad-hoc callables."""
    tools = cortadel_memory_tools(FakeCortadelClient())  # type: ignore[arg-type]
    assert [type(t) for t in tools] == [FunctionTool, FunctionTool]
    assert [t.name for t in tools] == ["search_memory", "add_memories"]


def test_tool_names_are_overridable() -> None:
    """Two memory backends on one agent need distinct tool names."""
    renamed = search_memory_tool(FakeCortadelClient(), name="recall")  # type: ignore[arg-type]
    assert renamed.name == "recall"


def test_tools_have_model_facing_descriptions() -> None:
    for tool in cortadel_memory_tools(FakeCortadelClient()):  # type: ignore[arg-type]
        assert tool.description
        assert len(tool.description) > 40


def test_search_memory_schema_shape() -> None:
    """The JSON schema the model sees is derived from the annotated signature."""
    schema = search_memory_tool(FakeCortadelClient()).parameters()  # type: ignore[arg-type]
    properties = schema["properties"]
    assert set(properties) == {"query", "top_k"}
    assert schema["required"] == ["query"]
    # `Annotated[...]` metadata must survive into the parameter description.
    assert "recall" in properties["query"]["description"].lower()


def test_add_memories_schema_shape() -> None:
    schema = add_memories_tool(FakeCortadelClient()).parameters()  # type: ignore[arg-type]
    assert set(schema["properties"]) == {"text"}
    assert schema["required"] == ["text"]


# -- search_memory behaviour ----------------------------------------------------------------


async def test_search_memory_returns_one_memory_per_line() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode"), hit("m2", "Ships Fridays")])
    tool = search_memory_tool(client)  # type: ignore[arg-type]

    result = await invoke_text(tool, query="preferences")

    assert "- Prefers dark mode" in result
    assert "- Ships Fridays" in result


async def test_search_memory_reports_no_hits_plainly() -> None:
    tool = search_memory_tool(FakeCortadelClient(hits=[]))  # type: ignore[arg-type]
    assert "No memories found" in await invoke_text(tool, query="anything")


async def test_search_memory_clamps_top_k_to_the_supported_range() -> None:
    """The model can ask for anything; Cortadel accepts 1-50."""
    client = FakeCortadelClient()
    tool = search_memory_tool(client)  # type: ignore[arg-type]

    await invoke_text(tool, query="q", top_k=999)
    assert client.search_calls[0][1].top_k == 50  # type: ignore[union-attr]

    await invoke_text(tool, query="q", top_k=0)
    assert client.search_calls[1][1].top_k == 10  # type: ignore[union-attr]


async def test_search_memory_uses_the_configured_top_k() -> None:
    """The builder's `top_k` is the fallback for a model that does not ask for one."""
    client = FakeCortadelClient()
    await invoke_text(search_memory_tool(client, top_k=4), query="q")  # type: ignore[arg-type]
    assert client.search_calls[0][1].top_k == 4  # type: ignore[union-attr]


async def test_builder_top_k_does_not_shadow_the_model_facing_one() -> None:
    """The closure's fallback and the model's argument share a name; they must stay distinct.

    `search_memory(top_k=...)` is the SDK's spelling and is what the model sees in the schema, so
    the builder's `top_k` has to be captured before the inner parameter shadows it. Get that wrong
    and the model's value is silently ignored (or the fallback is).
    """
    client = FakeCortadelClient()
    tool = search_memory_tool(client, top_k=4)  # type: ignore[arg-type]

    await invoke_text(tool, query="q", top_k=7)
    assert client.search_calls[0][1].top_k == 7  # type: ignore[union-attr]

    await invoke_text(tool, query="q")
    assert client.search_calls[1][1].top_k == 4  # type: ignore[union-attr]


async def test_the_top_k_default_is_the_sdks_own() -> None:
    """An explicit search tool retrieves 10 — the Cortadel SDK's own `SearchOptions` default."""
    client = FakeCortadelClient()
    await invoke_text(search_memory_tool(client), query="q")  # type: ignore[arg-type]
    assert client.search_calls[0][1].top_k == 10  # type: ignore[union-attr]


# -- add_memories behaviour -----------------------------------------------------------------


async def test_add_memories_stores_and_labels_the_app() -> None:
    client = FakeCortadelClient()
    result = await invoke_text(add_memories_tool(client), text="Alice ships on Fridays")  # type: ignore[arg-type]

    text, options = client.add_calls[0]
    assert text == "Alice ships on Fridays"
    assert options is not None
    assert options.app == "cortadel-agent-framework"
    assert "Remembered" in result


async def test_add_memories_surfaces_the_pipeline_event() -> None:
    """A 2xx does not mean a new memory was written."""
    client = FakeCortadelClient(created_event="SKIP_DUPLICATE")
    result = await invoke_text(add_memories_tool(client), text="already known")  # type: ignore[arg-type]
    assert "Already remembered" in result


async def test_add_memories_rejects_empty_text() -> None:
    client = FakeCortadelClient()
    result = await invoke_text(add_memories_tool(client), text="   ")  # type: ignore[arg-type]
    assert "Nothing to remember" in result
    assert client.add_calls == []


# -- Scoping and errors ---------------------------------------------------------------------


def test_tools_are_bound_to_one_client_so_the_model_cannot_change_user() -> None:
    """User scoping is structural: no tool parameter accepts a user id."""
    for tool in cortadel_memory_tools(FakeCortadelClient()):  # type: ignore[arg-type]
        assert "user_id" not in tool.parameters()["properties"]


async def test_search_tool_degrades_gracefully() -> None:
    """A tool error must come back as text the model can act on, not an exception."""
    client = FakeCortadelClient(search_error=CortadelError(0, "transport_error", "boom"))
    result = await invoke_text(search_memory_tool(client), query="q")  # type: ignore[arg-type]
    assert "temporarily unavailable" in result


async def test_add_tool_degrades_gracefully() -> None:
    client = FakeCortadelClient(add_error=CortadelError(503, "http_error", "down"))
    result = await invoke_text(add_memories_tool(client), text="fact")  # type: ignore[arg-type]
    assert "temporarily unavailable" in result


async def test_tools_can_propagate_failures_instead() -> None:
    """`raise_on_error=True` is the opt-in fail-closed mode; the default stays fail-open."""
    boom = CortadelError(0, "transport_error", "boom")

    with pytest.raises(CortadelError):
        await invoke_text(
            search_memory_tool(FakeCortadelClient(search_error=boom), raise_on_error=True),  # type: ignore[arg-type]
            query="q",
        )

    with pytest.raises(CortadelError):
        await invoke_text(
            add_memories_tool(FakeCortadelClient(add_error=boom), raise_on_error=True),  # type: ignore[arg-type]
            text="fact",
        )


async def test_tools_report_failures_to_the_on_error_callback() -> None:
    """`on_error` is a callback, and it replaces the warning log rather than adding to it."""
    seen: list[Exception] = []
    boom = CortadelError(503, "http_error", "down")

    tools = cortadel_memory_tools(  # type: ignore[arg-type]
        FakeCortadelClient(search_error=boom, add_error=boom), on_error=seen.append
    )
    search, add = tools

    assert "temporarily unavailable" in await invoke_text(search, query="q")
    assert "temporarily unavailable" in await invoke_text(add, text="fact")
    assert seen == [boom, boom]


async def test_a_raising_on_error_callback_cannot_break_the_tool(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An observer must not become the thing that takes the agent down."""

    def explode(exc: Exception) -> None:
        raise RuntimeError("the telemetry sink is down too")

    client = FakeCortadelClient(search_error=CortadelError(0, "transport_error", "boom"))
    with caplog.at_level(logging.WARNING):
        result = await invoke_text(search_memory_tool(client, on_error=explode), query="q")  # type: ignore[arg-type]

    assert "temporarily unavailable" in result
    assert "on_error callback raised" in caplog.text


async def test_tool_cancellation_is_never_swallowed() -> None:
    with pytest.raises(asyncio.CancelledError):
        await invoke_text(
            search_memory_tool(FakeCortadelClient(search_error=asyncio.CancelledError())),  # type: ignore[arg-type]
            query="q",
        )

    with pytest.raises(asyncio.CancelledError):
        await invoke_text(
            add_memories_tool(FakeCortadelClient(add_error=asyncio.CancelledError())),  # type: ignore[arg-type]
            text="fact",
        )
