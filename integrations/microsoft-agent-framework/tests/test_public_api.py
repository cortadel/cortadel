# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Guards on the package's public surface and on the Cortadel SDK methods it may use."""

from __future__ import annotations

import inspect

import agent_framework
import cortadel

import cortadel_agent_framework


def test_public_exports_are_exactly_what_is_documented() -> None:
    assert sorted(cortadel_agent_framework.__all__) == [
        "APP_NAME",
        "CortadelContextProvider",
        "__version__",
        "add_memories_tool",
        "cortadel_memory_tools",
        "search_memory_tool",
    ]
    for name in cortadel_agent_framework.__all__:
        assert hasattr(cortadel_agent_framework, name), name


def test_version_matches_the_manifest() -> None:
    assert cortadel_agent_framework.__version__ == "0.1.0"


def test_hooks_match_the_frameworks_signature() -> None:
    """If Agent Framework changes the hook contract, this must fail loudly rather than silently.

    Both hooks are keyword-only in ``agent_framework._sessions.ContextProvider``; overriding them
    with a different shape would make the provider silently never fire.
    """
    for hook in ("before_run", "after_run"):
        base = inspect.signature(getattr(agent_framework.ContextProvider, hook))
        ours = inspect.signature(getattr(cortadel_agent_framework.CortadelContextProvider, hook))
        assert list(base.parameters) == list(ours.parameters), hook
        assert [p.kind for p in base.parameters.values()] == [
            p.kind for p in ours.parameters.values()
        ], hook


def test_we_only_use_real_cortadel_sdk_methods() -> None:
    """The Cortadel facade is seven methods; this integration must not have invented an eighth."""
    used = {"add", "add_conversation", "search", "aclose"}
    assert used <= set(dir(cortadel.CortadelClient))


def test_cortadel_dtos_used_here_still_exist() -> None:
    for name in ("AddOptions", "ChatMessage", "ConversationOptions", "SearchOptions", "SearchHit"):
        assert hasattr(cortadel, name), name
