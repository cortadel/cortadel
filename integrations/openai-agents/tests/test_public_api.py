"""The package's public surface, and its conformance to the SDK's ``Session`` protocol."""

from __future__ import annotations

import inspect

import cortadel_openai_agents
from agents.memory import Session
from conftest import USER_ID
from cortadel_openai_agents import CortadelSession, cortadel_memory_tools


def test_public_namespace_matches_declared_all() -> None:
    assert sorted(cortadel_openai_agents.__all__) == [
        "CortadelSession",
        "DEFAULT_APP_NAME",
        "DEFAULT_BASE_URL",
        "DEFAULT_MEMORY_HEADER",
        "InjectionSite",
        "__version__",
        "cortadel_memory_tools",
    ]
    for name in cortadel_openai_agents.__all__:
        assert hasattr(cortadel_openai_agents, name), name


def test_version_matches_manifest() -> None:
    assert cortadel_openai_agents.__version__ == "0.1.0"


def test_app_name_identifies_this_integration() -> None:
    assert cortadel_openai_agents.DEFAULT_APP_NAME == "cortadel-openai-agents"


#: Names the Cortadel integrations agreed on repo-wide. Both entry points spell each concept the
#: same way, so a user moving between integrations never has to relearn one.
CANONICAL_SESSION_OPTIONS = {
    "top_k": 5,  # automatic per-turn injection
    "scope_recall_to_session": False,
    "await_persist": True,  # see the README: a run can be the last thing a process does
    "raise_on_error": False,
    "on_error": None,
    "app_name": "cortadel-openai-agents",  # the published package name, verbatim
}

CANONICAL_TOOL_OPTIONS = {
    "top_k": 10,  # explicit search tool — the Cortadel SDK's own SearchOptions default
    "raise_on_error": False,
    "on_error": None,
    "app_name": "cortadel-openai-agents",
}

#: Spellings other integrations used before the names were unified. None may come back.
RETIRED_SPELLINGS = (
    "limit",
    "search_limit",
    "strict",
    "fail_open",
    "scope_search_to_session",
    "scope_recall_to_thread",
    "recall_scope",
    "user_scope",
    "wait_for_persist",
)


def test_session_options_use_the_canonical_names_and_defaults() -> None:
    parameters = inspect.signature(CortadelSession.__init__).parameters

    for name, default in CANONICAL_SESSION_OPTIONS.items():
        assert name in parameters, name
        assert parameters[name].default == default, name

    for retired in RETIRED_SPELLINGS:
        assert retired not in parameters, retired


def test_tool_options_use_the_canonical_names_and_defaults() -> None:
    parameters = inspect.signature(cortadel_memory_tools).parameters

    for name, default in CANONICAL_TOOL_OPTIONS.items():
        assert name in parameters, name
        assert parameters[name].default == default, name

    for retired in RETIRED_SPELLINGS:
        assert retired not in parameters, retired


def test_tool_names_match_cortadels_own_mcp_surface(fake_client) -> None:
    """``search_memory`` and ``add_memories`` — plural on add, as the MCP server spells it."""
    assert [tool.name for tool in cortadel_memory_tools(client=fake_client)] == [
        "search_memory",
        "add_memories",
    ]


def test_on_error_is_a_callback_never_a_mode_string() -> None:
    """``on_error`` means "observe a failure" everywhere; ``raise_on_error`` decides propagation."""
    for signature in (
        inspect.signature(CortadelSession.__init__),
        inspect.signature(cortadel_memory_tools),
    ):
        annotation = signature.parameters["on_error"].annotation
        assert "OnError" in str(annotation), annotation
        assert signature.parameters["raise_on_error"].annotation == "bool"


def test_session_satisfies_the_runtime_checkable_session_protocol(fake_client) -> None:
    session = CortadelSession(session_id="s", user_id=USER_ID, client=fake_client)
    assert isinstance(session, Session)


def test_session_method_signatures_match_the_protocol(fake_client) -> None:
    """The runner calls these positionally/by keyword exactly as the protocol declares them.

    ``agents/memory/session.py`` keeps the released signatures deliberately, and
    ``_call_session_method`` only passes ``wrapper`` to sessions that opt in — which we do not.
    """
    session = CortadelSession(session_id="s", user_id=USER_ID, client=fake_client)

    assert str(inspect.signature(session.get_items)) == "(limit: 'int | None' = None) -> 'list[TResponseInputItem]'"
    assert str(inspect.signature(session.add_items)) == "(items: 'list[TResponseInputItem]') -> 'None'"
    assert str(inspect.signature(session.pop_item)) == "() -> 'TResponseInputItem | None'"
    assert str(inspect.signature(session.clear_session)) == "() -> 'None'"

    for name in ("get_items", "add_items", "pop_item", "clear_session"):
        assert inspect.iscoroutinefunction(getattr(session, name)), name


def test_session_exposes_session_settings_attribute(fake_client) -> None:
    """``prepare_input_with_session`` reads it with ``getattr(session, "session_settings", None)``."""
    session = CortadelSession(session_id="s", user_id=USER_ID, client=fake_client)
    assert session.session_settings is None

    configured = CortadelSession(
        session_id="s", user_id=USER_ID, client=fake_client, session_settings={"limit": 4}
    )
    assert configured.session_settings is not None
    assert configured.session_settings.limit == 4
