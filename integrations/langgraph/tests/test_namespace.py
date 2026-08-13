"""Namespace templating and the namespace -> Cortadel-user-id mapping."""
from __future__ import annotations

import pytest

from cortadel_langgraph import (
    DEFAULT_NAMESPACE,
    as_namespace,
    namespace_user_id,
    resolve_namespace,
)


def test_a_bare_string_is_a_one_label_namespace() -> None:
    assert as_namespace("memories") == ("memories",)
    assert as_namespace(["memories", "e2e-alice"]) == ("memories", "e2e-alice")


def test_a_literal_namespace_is_returned_unchanged() -> None:
    assert resolve_namespace(("memories", "e2e-alice")) == ("memories", "e2e-alice")


def test_placeholders_come_from_the_configurable_dict() -> None:
    resolved = resolve_namespace(
        ("org", "{org_id}", "{user_id}"),
        {"configurable": {"org_id": "acme", "user_id": "e2e-langgraph-integration"}},
    )
    assert resolved == ("org", "acme", "e2e-langgraph-integration")


def test_a_missing_placeholder_names_itself_in_the_error() -> None:
    with pytest.raises(ValueError, match="missing 'user_id'"):
        resolve_namespace(DEFAULT_NAMESPACE, {"configurable": {}})


def test_a_blank_placeholder_value_counts_as_missing() -> None:
    with pytest.raises(ValueError, match="missing 'user_id'"):
        resolve_namespace(DEFAULT_NAMESPACE, {"configurable": {"user_id": ""}})


def test_no_config_at_all_explains_how_to_supply_one() -> None:
    with pytest.raises(ValueError, match="needs .user_id. from the runnable config"):
        resolve_namespace(DEFAULT_NAMESPACE)


def test_only_a_whole_label_can_be_a_placeholder() -> None:
    """Half-literal labels would make the reverse (namespace -> user id) mapping ambiguous."""
    assert resolve_namespace(("user-{id}",), {"configurable": {"id": "x"}}) == ("user-{id}",)


def test_a_non_string_value_is_stringified() -> None:
    assert resolve_namespace(("u", "{n}"), {"configurable": {"n": 42}}) == ("u", "42")


def test_the_default_namespace_pairs_with_the_trailing_label_resolver() -> None:
    resolved = resolve_namespace(DEFAULT_NAMESPACE, {"configurable": {"user_id": "e2e-alice"}})
    assert namespace_user_id(-1)(resolved) == "e2e-alice"


def test_the_user_label_position_is_configurable() -> None:
    assert namespace_user_id(1)(("org", "acme", "e2e-alice")) == "acme"
    assert namespace_user_id(-1)(("org", "acme", "e2e-alice")) == "e2e-alice"


def test_an_out_of_range_index_says_which_namespace_failed() -> None:
    with pytest.raises(ValueError, match=r"\('memories',\) has no label at index 3"):
        namespace_user_id(3)(("memories",))
