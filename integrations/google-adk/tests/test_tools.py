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

from typing import Any

from conftest import TEST_APP
from conftest import TEST_USER
from conftest import FakeClientFactory
from conftest import make_hit
from conftest import make_session
from cortadel import CortadelError
from cortadel_google_adk import CortadelMemoryService
from cortadel_google_adk import cortadel_memory_tools
from google.adk.agents.invocation_context import InvocationContext
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool
from google.adk.tools import ToolContext
import pytest


def build(factory: FakeClientFactory, **kwargs) -> CortadelMemoryService:
    return CortadelMemoryService("http://localhost:3001", client_factory=factory, **kwargs)


def tool_context() -> ToolContext:
    """A real ADK ``ToolContext`` over a real session."""
    return ToolContext(
        InvocationContext(
            session_service=InMemorySessionService(),
            session=make_session(),
            invocation_id="inv-1",
        )
    )


def declaration_schema(tool: FunctionTool) -> dict[str, Any]:
    """The parameter schema the model actually sees, either encoding."""
    declaration = tool._get_declaration()
    assert declaration is not None
    if declaration.parameters_json_schema is not None:
        schema = declaration.parameters_json_schema
        return {
            "properties": set(schema.get("properties", {})),
            "required": set(schema.get("required", [])),
        }
    return {
        "properties": set(declaration.parameters.properties or {}),
        "required": set(declaration.parameters.required or []),
    }


# ---------------------------------------------------------------------------
# Registration / schema shape
# ---------------------------------------------------------------------------


def test_returns_both_tools_as_function_tools(factory: FakeClientFactory) -> None:
    tools = cortadel_memory_tools(build(factory))
    assert [t.name for t in tools] == ["search_memory", "add_memories"]
    assert all(isinstance(t, FunctionTool) for t in tools)


def test_tools_can_be_selected_individually(factory: FakeClientFactory) -> None:
    service = build(factory)
    assert [t.name for t in cortadel_memory_tools(service, include_add=False)] == [
        "search_memory"
    ]
    assert [t.name for t in cortadel_memory_tools(service, include_search=False)] == [
        "add_memories"
    ]


def test_search_tool_schema_hides_the_tool_context(factory: FakeClientFactory) -> None:
    search, _ = cortadel_memory_tools(build(factory))
    schema = declaration_schema(search)
    # tool_context is injected by ADK, never asked of the model.
    assert schema["properties"] == {"query"}
    assert schema["required"] == {"query"}


def test_add_tool_schema_exposes_optional_memory_type(factory: FakeClientFactory) -> None:
    _, add = cortadel_memory_tools(build(factory))
    schema = declaration_schema(add)
    assert schema["properties"] == {"text", "memory_type"}
    assert schema["required"] == {"text"}


def test_tools_are_described_for_the_model(factory: FakeClientFactory) -> None:
    search, add = cortadel_memory_tools(build(factory))
    assert "memory" in search.description.lower()
    assert "memory" in add.description.lower()


# ---------------------------------------------------------------------------
# Behaviour
# ---------------------------------------------------------------------------


async def test_search_tool_returns_hits_with_metadata(factory: FakeClientFactory) -> None:
    factory.hits = [
        make_hit(
            content="The user prefers Terraform.",
            rrf_score=0.9,
            categories=["preferences"],
            memory_type="semantic",
            created_at="2026-08-13T10:00:00Z",
        )
    ]
    search, _ = cortadel_memory_tools(build(factory))

    result = await search.func(query="tooling", tool_context=tool_context())

    assert result == {
        "memories": [
            {
                "text": "The user prefers Terraform.",
                "score": 0.9,
                "categories": ["preferences"],
                "memory_type": "semantic",
                "timestamp": "2026-08-13T10:00:00Z",
            }
        ]
    }


async def test_search_tool_scopes_to_the_session_user(factory: FakeClientFactory) -> None:
    search, _ = cortadel_memory_tools(build(factory))

    await search.func(query="q", tool_context=tool_context())

    # make_session() is scoped to TEST_USER, so that is the Cortadel user.
    assert list(factory.clients) == [TEST_USER]


async def test_search_tool_honours_scope_recall_to_session(
    factory: FakeClientFactory,
) -> None:
    search, _ = cortadel_memory_tools(build(factory, scope_recall_to_session=True))

    await search.func(query="q", tool_context=tool_context())

    (call,) = factory.only().calls_to("search")
    assert call.options.session_id == "sess-1"


async def test_search_tool_does_not_scope_recall_by_default(
    factory: FakeClientFactory,
) -> None:
    """Cross-session recall is the point of long-term memory."""
    search, _ = cortadel_memory_tools(build(factory))

    await search.func(query="q", tool_context=tool_context())

    (call,) = factory.only().calls_to("search")
    assert call.options.session_id is None


async def test_search_tool_returns_empty_when_backend_is_down(
    factory: FakeClientFactory,
) -> None:
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = CortadelError(0, "transport_error", "refused")
    search, _ = cortadel_memory_tools(service)

    assert await search.func(query="q", tool_context=tool_context()) == {"memories": []}


async def test_add_tool_stores_and_reports_the_event(factory: FakeClientFactory) -> None:
    _, add = cortadel_memory_tools(build(factory))

    result = await add.func(
        text="  The user deploys to Cloud Run.  ",
        tool_context=tool_context(),
        memory_type="semantic",
    )

    assert result == {
        "stored": True,
        "text": "The user deploys to Cloud Run.",
        "event": "ADD",
    }
    (call,) = factory.only().calls_to("add")
    assert call.args == ("The user deploys to Cloud Run.",)
    assert call.options.memory_type == "semantic"


async def test_add_tool_surfaces_skip_duplicate(factory: FakeClientFactory) -> None:
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().add_event = "SKIP_DUPLICATE"
    _, add = cortadel_memory_tools(service)

    result = await add.func(text="already known", tool_context=tool_context())

    assert result["stored"] is True
    assert result["event"] == "SKIP_DUPLICATE"


async def test_add_tool_rejects_blank_text(factory: FakeClientFactory) -> None:
    _, add = cortadel_memory_tools(build(factory))

    result = await add.func(text="   ", tool_context=tool_context())

    assert result["stored"] is False
    assert factory.clients == {}


async def test_add_tool_reports_an_unavailable_backend(factory: FakeClientFactory) -> None:
    service = build(factory)
    await service.client_for(TEST_APP, TEST_USER)
    factory.only().raises = CortadelError(0, "transport_error", "refused")
    _, add = cortadel_memory_tools(service)

    result = await add.func(text="a fact", tool_context=tool_context())

    assert result["stored"] is False
    assert result["reason"] == "memory backend unavailable"


@pytest.mark.parametrize("tool_index", [0, 1])
def test_tool_functions_declare_a_real_tool_context(
    factory: FakeClientFactory, tool_index: int
) -> None:
    """ADK finds the context parameter by resolving its *type hint*.

    Under ``from __future__ import annotations`` that only works if
    ``ToolContext`` is a runtime import, so assert the hint really resolves.
    """
    from google.adk.utils.context_utils import find_context_parameter

    tool = cortadel_memory_tools(build(factory))[tool_index]
    assert find_context_parameter(tool.func) == "tool_context"
