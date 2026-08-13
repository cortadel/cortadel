"""`CortadelMemory.apply()` — merging into ClaudeAgentOptions without clobbering the caller's."""
from __future__ import annotations

import pytest
from claude_agent_sdk import ClaudeAgentOptions, HookMatcher
from conftest import FakeCortadel

import cortadel_claude_agent_sdk
from cortadel_claude_agent_sdk import CortadelMemory


@pytest.fixture
def memory() -> CortadelMemory:
    return CortadelMemory.from_client(FakeCortadel())


def test_public_surface() -> None:
    assert sorted(cortadel_claude_agent_sdk.__all__) == [
        "CortadelLike",
        "CortadelMemory",
        "DEFAULT_APP_NAME",
        "DEFAULT_SERVER_NAME",
        "__version__",
    ]


def test_apply_wires_the_server_the_tools_and_both_hooks(memory: CortadelMemory) -> None:
    options = memory.apply()

    assert options.mcp_servers == {"cortadel": memory.mcp_server}
    assert options.allowed_tools == memory.allowed_tools
    assert sorted(options.hooks) == ["Stop", "UserPromptSubmit"]


def test_hook_matchers_have_no_tool_matcher_and_a_derived_timeout() -> None:
    """`HookMatcher.matcher` filters by tool name, which is meaningless for these two events."""
    memory = CortadelMemory.from_client(FakeCortadel(), recall_timeout=8.0, capture_timeout=30.0)

    hooks = memory.hooks()

    (recall,) = hooks["UserPromptSubmit"]
    (capture,) = hooks["Stop"]
    assert recall.matcher is None and capture.matcher is None
    assert recall.timeout == 13.0 and capture.timeout == 35.0
    assert recall.hooks == [memory.on_user_prompt_submit]
    assert capture.hooks == [memory.on_stop]


def test_apply_preserves_unrelated_options(memory: CortadelMemory) -> None:
    options = memory.apply(ClaudeAgentOptions(model="claude-sonnet-4-5", max_turns=3))

    assert options.model == "claude-sonnet-4-5"
    assert options.max_turns == 3


def test_apply_merges_rather_than_replaces(memory: CortadelMemory) -> None:
    async def other_hook(input_data, tool_use_id, context):  # noqa: ANN001, ANN202
        return {}

    base = ClaudeAgentOptions(
        mcp_servers={"weather": {"type": "stdio", "command": "weather-mcp"}},
        allowed_tools=["Read", "mcp__weather__get_temperature"],
        hooks={"UserPromptSubmit": [HookMatcher(hooks=[other_hook])]},
    )

    options = memory.apply(base)

    assert set(options.mcp_servers) == {"weather", "cortadel"}
    assert options.allowed_tools[:2] == ["Read", "mcp__weather__get_temperature"]
    assert "mcp__cortadel__search_memory" in options.allowed_tools
    assert [matcher.hooks[0] for matcher in options.hooks["UserPromptSubmit"]] == [
        other_hook,
        memory.on_user_prompt_submit,
    ]
    assert "Stop" in options.hooks


def test_apply_does_not_mutate_the_options_it_is_given(memory: CortadelMemory) -> None:
    base = ClaudeAgentOptions(allowed_tools=["Read"])

    memory.apply(base)

    assert base.allowed_tools == ["Read"]
    assert base.mcp_servers == {}
    assert base.hooks is None


def test_apply_does_not_duplicate_an_already_allowed_tool(memory: CortadelMemory) -> None:
    options = memory.apply(ClaudeAgentOptions(allowed_tools=["mcp__cortadel__search_memory"]))

    assert options.allowed_tools.count("mcp__cortadel__search_memory") == 1


def test_apply_can_wire_tools_only(memory: CortadelMemory) -> None:
    options = memory.apply(tools=True, auto_memory=False)

    assert "cortadel" in options.mcp_servers
    assert options.hooks is None


def test_apply_can_wire_auto_memory_only(memory: CortadelMemory) -> None:
    options = memory.apply(tools=False, auto_memory=True)

    assert options.mcp_servers == {}
    assert options.allowed_tools == []
    assert sorted(options.hooks) == ["Stop", "UserPromptSubmit"]


def test_apply_refuses_to_merge_into_an_mcp_config_path(memory: CortadelMemory) -> None:
    """`mcp_servers` may be a path to a config file; there is nothing sane to merge into."""
    with pytest.raises(ValueError, match="config-file path"):
        memory.apply(ClaudeAgentOptions(mcp_servers="/etc/mcp.json"))


# ── from_env ────────────────────────────────────────────────────────────────────────────────


def test_from_env_reads_the_plugin_environment_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORTADEL_URL", "http://localhost:3001")
    monkeypatch.setenv("CORTADEL_USER_ID", "e2e-from-env")
    monkeypatch.setenv("CORTADEL_CLIENT_NAME", "my-agent")

    memory = CortadelMemory.from_env()

    assert memory.client._user_id == "e2e-from-env"
    assert memory._app_name == "my-agent"


def test_from_env_names_the_missing_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CORTADEL_URL", raising=False)
    monkeypatch.delenv("CORTADEL_USER_ID", raising=False)

    with pytest.raises(ValueError, match="CORTADEL_URL and CORTADEL_USER_ID"):
        CortadelMemory.from_env()


def test_explicit_arguments_win_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORTADEL_URL", "http://localhost:3001")
    monkeypatch.setenv("CORTADEL_USER_ID", "e2e-from-env")
    monkeypatch.setenv("CORTADEL_CLIENT_NAME", "my-agent")

    memory = CortadelMemory.from_env(app_name="explicit", top_k=9)

    assert memory._app_name == "explicit"
    assert memory._top_k == 9
