"""The public constructor contract, pinned.

`CortadelMemory` is a dataclass, so its `__init__` is generated from field *order*. That makes the
option list quietly dangerous to extend: inserting a field shifts every positional slot after it,
and a caller who passed arguments positionally keeps running — silently binding its values to
different options, with no error to notice. The fix is the `KW_ONLY` marker in `memory.py`, and
these tests are what keep it there.

The contract, in one line: **`base_url` and `user_id` may be passed positionally, in that order;
everything else is keyword-only.** It mirrors `cortadel.CortadelClient(base_url, user_id, *, ...)`
and the sibling Cortadel integrations that lead with the same pair.

If one of these fails after you added an option, you added it *above* the `_: KW_ONLY` marker.
Move it below. Do not update the expected values here to match.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

import pytest

from conftest import E2E_USER
from cortadel_pydantic_ai import CortadelMemory, cortadel_toolset

POSITIONAL_PREFIX = ("base_url", "user_id")
"""The only parameters callers may pass positionally, in exactly this order."""

CANONICAL_OPTIONS = (
    "await_persist",
    "on_error",
    "raise_on_error",
    "scope_recall_to_session",
    "top_k",
)
"""Repo-wide canonical option names. Keyword-only here, so a rename cannot hide behind a slot."""


def params(target: Callable[..., Any]) -> list[inspect.Parameter]:
    """The parameters of `target`, minus `self`."""
    return [p for p in inspect.signature(target).parameters.values() if p.name != "self"]


class TestCortadelMemoryConstructor:
    def test_only_base_url_and_user_id_are_positional(self) -> None:
        positional = [
            p.name
            for p in params(CortadelMemory)
            if p.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
        ]
        assert tuple(positional) == POSITIONAL_PREFIX

    def test_every_other_parameter_is_keyword_only(self) -> None:
        # The guard that survives future edits: any option added anywhere in the field list has
        # to land here, not in a positional slot.
        offenders = [
            p.name
            for p in params(CortadelMemory)
            if p.kind is not inspect.Parameter.KEYWORD_ONLY and p.name not in POSITIONAL_PREFIX
        ]
        assert offenders == []

    def test_no_var_positional_slot_exists(self) -> None:
        # `*args` would re-open the hazard from the other end.
        assert all(
            p.kind is not inspect.Parameter.VAR_POSITIONAL for p in params(CortadelMemory)
        )

    def test_the_canonical_options_are_keyword_only(self) -> None:
        by_name = {p.name: p for p in params(CortadelMemory)}
        for name in CANONICAL_OPTIONS:
            assert name in by_name, f"canonical option {name!r} is missing"
            assert by_name[name].kind is inspect.Parameter.KEYWORD_ONLY

    def test_the_inherited_capability_fields_stay_keyword_only(self) -> None:
        # `id` / `description` / `defer_loading` come from `AbstractCapability`. They are already
        # keyword-only there; if a pydantic-ai release changed that, they would silently appear
        # ahead of our own fields in the generated `__init__`.
        by_name = {p.name: p for p in params(CortadelMemory)}
        for name in ("id", "description", "defer_loading"):
            assert by_name[name].kind is inspect.Parameter.KEYWORD_ONLY

    def test_positional_arguments_bind_to_base_url_then_user_id(self) -> None:
        # Pins the *order* of the pair, which the signature check alone would not catch if the
        # two were ever swapped.
        cap: CortadelMemory[Any] = CortadelMemory("https://app.cortadel.ai", E2E_USER)
        assert cap._backend.base_url == "https://app.cortadel.ai"
        assert cap._backend.user_id == E2E_USER

    def test_a_third_positional_argument_is_rejected(self) -> None:
        # The whole point: an option can never be reached positionally, so inserting one cannot
        # change what an existing positional call means.
        with pytest.raises(TypeError):
            CortadelMemory("http://localhost:3001", E2E_USER, "not-a-real-key")  # type: ignore[misc]


class TestToolsetFactory:
    def test_every_parameter_is_keyword_only(self) -> None:
        # The standalone factory takes no positional arguments at all — it is a builder, not the
        # client-shaped entry point, so there is no pair to mirror.
        assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in params(cortadel_toolset))

    def test_the_canonical_options_it_shares_are_keyword_only(self) -> None:
        by_name = {p.name: p for p in params(cortadel_toolset)}
        for name in ("on_error", "raise_on_error", "top_k"):
            assert name in by_name, f"canonical option {name!r} is missing"
            assert by_name[name].kind is inspect.Parameter.KEYWORD_ONLY

    def test_it_takes_no_positional_arguments(self) -> None:
        with pytest.raises(TypeError):
            cortadel_toolset("http://localhost:3001")  # type: ignore[misc]
