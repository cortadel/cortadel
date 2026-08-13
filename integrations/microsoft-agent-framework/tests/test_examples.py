# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""Tests for the code we ask people to copy and paste.

Why this file exists
--------------------
The rest of the suite substitutes a local `FakeChatClient` and never imports
`agent_framework.openai`. That is right for the *integration's* tests — but it means the README
quickstart and `examples/basic_memory_agent.py` were the only code in the package nothing
executed or even parsed, and both shipped a `OpenAIChatClient(model_id=...)` call that raises
`TypeError` on the line that builds the agent. Untested docs are still code.

These tests close that hole without needing a network, a model, or an API key: every snippet is
parsed, and every chat-client construction is bound against the *real* library signature via
`inspect.signature(...).bind_partial`, which validates argument names without constructing
anything.

The same idea covers the README's configuration tables: their option names *and* their documented
defaults are checked against the real signatures, in both directions. An option renamed in the
code but not in the table fails here, and so does one renamed in the table but not the code -- a
half-finished rename is the failure mode these tables have, and "the README says `top_k` is 10"
is only true if the signature agrees.
"""

from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path
from typing import Any

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
README = PACKAGE_ROOT / "README.md"
EXAMPLES = sorted((PACKAGE_ROOT / "examples").glob("*.py"))

#: ```python ... ``` fenced blocks. Only python blocks — bash install snippets are not code we run.
_PYTHON_BLOCK = re.compile(r"^```python\n(.*?)^```", re.MULTILINE | re.DOTALL)


def readme_snippets() -> list[str]:
    """Every ```python block in the README."""
    return _PYTHON_BLOCK.findall(README.read_text(encoding="utf-8"))


def _sources() -> list[Any]:
    """Every runnable snippet the package ships, as pytest params labelled by where it came from.

    Ids are set explicitly: the default id for a multi-line string parameter is the whole snippet,
    which makes the report unreadable.
    """
    params = [
        pytest.param(f"README block {i}", block, id=f"readme-block-{i}")
        for i, block in enumerate(readme_snippets(), start=1)
    ]
    params += [
        pytest.param(path.name, path.read_text(encoding="utf-8"), id=path.name)
        for path in EXAMPLES
    ]
    return params


def _calls_named(source: str, func_name: str) -> list[ast.Call]:
    """Every call to `func_name(...)` in a snippet, however it was imported."""
    tree = ast.parse(source)
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        target = node.func
        name = target.attr if isinstance(target, ast.Attribute) else getattr(target, "id", None)
        if name == func_name:
            out.append(node)
    return out


def test_the_package_actually_ships_snippets_to_check() -> None:
    """Guard the guard: a regex that silently matches nothing would make every test below vacuous."""
    assert readme_snippets(), "no ```python blocks found in README.md"
    assert EXAMPLES, "no example scripts found"


@pytest.mark.parametrize("label,source", _sources())
def test_snippet_parses(label: str, source: str) -> None:
    """Every snippet we ship must at least be valid Python."""
    ast.parse(source)


@pytest.mark.parametrize("label,source", _sources())
def test_chat_client_construction_matches_the_real_signature(label: str, source: str) -> None:
    """Bind each `OpenAIChatClient(...)` in our docs against the library's actual signature.

    This is the check that would have caught `model_id=` before it shipped. `bind_partial`
    validates parameter *names and arity* without calling anything, so no API key, no network and
    no model are involved.
    """
    calls = _calls_named(source, "OpenAIChatClient")
    if not calls:
        pytest.skip(f"{label} constructs no chat client")

    # Skip on the *distribution's* module, not on `agent_framework.openai`: core ships that path
    # as a lazy re-export shim, so importing it succeeds even when the provider is absent and only
    # the attribute access fails.
    pytest.importorskip(
        "agent_framework_openai",
        reason="agent-framework-openai is not installed; `test_no_model_id_kwarg` still applies",
    )
    from agent_framework.openai import OpenAIChatClient

    signature = inspect.signature(OpenAIChatClient.__init__)

    for call in calls:
        # `self` is bound by the descriptor protocol at call time; supply a placeholder for it.
        args: list[Any] = [None] + [ast.literal_eval(a) for a in call.args]
        kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords if kw.arg}
        signature.bind_partial(*args, **kwargs)


@pytest.mark.parametrize("label,source", _sources())
def test_no_model_id_kwarg(label: str, source: str) -> None:
    """The specific regression, checked even where agent-framework-openai is not installed.

    `OpenAIChatClient`'s first parameter is `model` (positional-or-keyword) and the signature takes
    no `**kwargs`, so `model_id=` is a `TypeError`, not a deprecated alias.
    """
    for call in _calls_named(source, "OpenAIChatClient"):
        assert "model_id" not in {kw.arg for kw in call.keywords}, (
            f"{label}: OpenAIChatClient takes `model`, not `model_id`"
        )


# -- The README's option tables must describe the real signatures ---------------------------

#: A markdown table cell may itself contain an escaped pipe (`str \| None`), so cells are split on
#: unescaped pipes only. Splitting naively shifts every column after the first `\|` and would make
#: the default-value checks below compare the wrong cells.
_UNESCAPED_PIPE = re.compile(r"(?<!\\)\|")

#: An option row starts with a single backticked snake_case name.
_OPTION_NAME = re.compile(r"^`([a-z_][a-z0-9_]*)`$")


def _table_after(marker: str) -> list[list[str]]:
    """Rows (header dropped) of the first markdown table following `marker` in the README."""
    text = README.read_text(encoding="utf-8")
    assert text.count(marker) == 1, f"{marker!r} must appear exactly once in the README"

    rows: list[list[str]] = []
    for line in text[text.index(marker) + len(marker) :].splitlines():
        stripped = line.strip()
        if stripped.startswith("|"):
            cells = [c.strip() for c in _UNESCAPED_PIPE.split(stripped.strip("|"))]
            if all(cell and set(cell) <= set("-: ") for cell in cells):
                continue  # the |---|---| separator
            rows.append(cells)
        elif rows:
            break  # blank line or prose after the table: it ended
    return rows[1:]


def _documented_options(marker: str) -> dict[str, str]:
    """Map each documented option name to its raw "Default" cell."""
    options = {}
    for cells in _table_after(marker):
        match = _OPTION_NAME.match(cells[0])
        if match:
            options[match.group(1)] = cells[2]
    return options


#: Sentinel for a "Default" cell written as prose rather than a Python literal.
_NO_DEFAULT = object()


def _documented_default(cell: str) -> Any:
    """The default a table cell states, or `_NO_DEFAULT` when it is prose rather than a literal."""
    literal = re.fullmatch(r"`(.+)`", cell)
    if literal is None:
        return _NO_DEFAULT
    try:
        return ast.literal_eval(literal.group(1))
    except (ValueError, SyntaxError):
        return _NO_DEFAULT


_PROVIDER_TABLE = "## Configuration"
_TOOLS_TABLE = "The builders take these options"


def test_provider_configuration_table_lists_exactly_the_real_options() -> None:
    """Every documented provider option exists, and every real one is documented."""
    from cortadel_agent_framework import CortadelContextProvider

    real = set(inspect.signature(CortadelContextProvider.__init__).parameters) - {"self"}
    assert _documented_options(_PROVIDER_TABLE).keys() == real


def test_provider_configuration_table_states_the_real_defaults() -> None:
    """A table that says `top_k` is 10 while the signature says 5 is worse than no table."""
    from cortadel_agent_framework import CortadelContextProvider

    parameters = inspect.signature(CortadelContextProvider.__init__).parameters
    checked = 0
    for option, cell in _documented_options(_PROVIDER_TABLE).items():
        documented = _documented_default(cell)
        if documented is _NO_DEFAULT:
            continue  # prose default (e.g. "a generic '## Memories' header")
        assert documented == parameters[option].default, option
        checked += 1
    assert checked >= 10, "the defaults check went vacuous"


def test_tool_builder_table_lists_exactly_the_real_options() -> None:
    """Same guard for the tool builders, whose options are spread over two functions."""
    from cortadel_agent_framework import add_memories_tool, search_memory_tool

    real = set()
    for builder in (search_memory_tool, add_memories_tool):
        real |= set(inspect.signature(builder).parameters) - {"client"}
    assert _documented_options(_TOOLS_TABLE).keys() == real


def test_tool_builder_table_states_the_real_defaults() -> None:
    from cortadel_agent_framework import add_memories_tool, search_memory_tool

    signatures = [inspect.signature(b) for b in (search_memory_tool, add_memories_tool)]
    checked = 0
    for option, cell in _documented_options(_TOOLS_TABLE).items():
        documented = _documented_default(cell)
        if documented is _NO_DEFAULT:
            continue  # `name` differs per builder and is documented in prose
        for signature in signatures:
            parameter = signature.parameters.get(option)
            if parameter is not None:
                assert documented == parameter.default, option
                checked += 1
    assert checked >= 6, "the defaults check went vacuous"


def test_cortadel_memory_tools_forwards_what_the_readme_claims() -> None:
    """The README says the convenience builder forwards everything but `name` and `memory_type`."""
    from cortadel_agent_framework import cortadel_memory_tools

    forwarded = set(inspect.signature(cortadel_memory_tools).parameters) - {"client"}
    assert forwarded == _documented_options(_TOOLS_TABLE).keys() - {"name", "memory_type"}
