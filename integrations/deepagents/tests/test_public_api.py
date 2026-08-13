"""The package's public surface: what it exports, and the shape of the tools it registers."""

from __future__ import annotations

import cortadel_deepagents
from conftest import USER_ID, FakeCortadelClient
from cortadel_deepagents import CortadelMemoryMiddleware, create_cortadel_tools
from langchain_core.tools import BaseTool


def test_exports_are_exactly_the_documented_surface() -> None:
    assert sorted(cortadel_deepagents.__all__) == [
        "CORTADEL_SYSTEM_PROMPT",
        "ClientProvider",
        "CortadelMemoryMiddleware",
        "CortadelMemoryState",
        "DEFAULT_APP_NAME",
        "DEFAULT_BASE_URL",
        "RecalledMemory",
        "__version__",
        "create_cortadel_tools",
        "resolve_user_id",
    ]
    for name in cortadel_deepagents.__all__:
        assert hasattr(cortadel_deepagents, name), name


def test_version_matches_the_manifest() -> None:
    assert cortadel_deepagents.__version__ == "0.1.0"


def test_default_app_name_identifies_this_integration() -> None:
    # `app_name` is recorded for access logging on the Cortadel side; it must name the integration.
    assert cortadel_deepagents.DEFAULT_APP_NAME == "cortadel-deepagents"


def test_tools_are_langchain_tools_with_the_expected_names_and_schemas() -> None:
    tools = create_cortadel_tools(client=FakeCortadelClient(), user_id=USER_ID)

    assert [tool.name for tool in tools] == ["search_memory", "add_memories"]
    assert all(isinstance(tool, BaseTool) for tool in tools)

    search, add = tools
    search_fields = search.args_schema.model_fields
    assert set(search_fields) == {"query", "top_k"}
    assert search_fields["query"].annotation is str
    # 10 = the Cortadel SDK's own `SearchOptions.top_k`, the default for an explicit search tool.
    assert search_fields["top_k"].default == 10

    add_fields = add.args_schema.model_fields
    assert set(add_fields) == {"memories"}
    assert add_fields["memories"].annotation == list[str]

    # `runtime` is injected by the tool node, so it must not appear in the model-facing schema.
    assert "runtime" not in search.args
    assert "runtime" not in add.args


def test_tool_runtime_is_detected_as_an_injected_argument() -> None:
    """Regression guard for the PEP 563 trap documented at the top of `tools.py`.

    `StructuredTool._injected_args_keys` reads raw `signature()` annotations, so adding
    `from __future__ import annotations` to `tools.py` would stringify them, `runtime` would be
    stripped from the call, and both tools would fail at invocation with a `TypeError`. The
    private attribute is asserted deliberately: it is the exact mechanism that breaks.
    """
    for tool in create_cortadel_tools(client=FakeCortadelClient(), user_id=USER_ID):
        assert "runtime" in tool._injected_args_keys, tool.name


def test_tool_descriptions_are_domain_agnostic() -> None:
    tools = create_cortadel_tools(client=FakeCortadelClient(), user_id=USER_ID)
    joined = " ".join(tool.description for tool in tools).lower()
    for term in ("patient", "medical", "legal", "trading", "portfolio", "diagnosis"):
        assert term not in joined


def test_middleware_registers_its_tools_by_default_and_can_be_told_not_to() -> None:
    with_tools = CortadelMemoryMiddleware(client=FakeCortadelClient(), user_id=USER_ID)
    assert [tool.name for tool in with_tools.tools] == ["search_memory", "add_memories"]

    without_tools = CortadelMemoryMiddleware(
        client=FakeCortadelClient(), user_id=USER_ID, expose_tools=False
    )
    assert list(without_tools.tools) == []


def test_middleware_name_is_stable() -> None:
    # `create_agent` keys its graph nodes off `middleware.name` and rejects duplicates.
    assert CortadelMemoryMiddleware(client=FakeCortadelClient()).name == "CortadelMemoryMiddleware"
