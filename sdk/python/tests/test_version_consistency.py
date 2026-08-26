"""`cortadel.__version__` must match the version pyproject.toml ships.

This exists because they drifted and nobody noticed: the 1.1.0 release bumped pyproject.toml but
left ``__version__ = "1.0.0"``, so the package published to PyPI as 1.1.0 while reporting 1.0.0 to
anyone who introspected it. Nothing failed, because nothing compared them.

``importlib.metadata.version`` reads the INSTALLED distribution metadata, which is derived from
pyproject.toml at build time — so the second test compares two independent sources of truth rather
than one against itself.
"""

from __future__ import annotations

import re
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as dist_version
from pathlib import Path

import pytest

import cortadel

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _pyproject_version() -> str:
    # Parsed with a regex rather than tomllib: this package supports Python 3.10, where tomllib
    # does not exist, and pulling in tomli just to read one line would add a dependency to the
    # test matrix. The [project] version line is unambiguous.
    text = PYPROJECT.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match, "could not find a version line in pyproject.toml"
    return match.group(1)


def test_dunder_version_matches_pyproject() -> None:
    declared = _pyproject_version()
    assert cortadel.__version__ == declared, (
        f"cortadel.__version__ is {cortadel.__version__!r} but pyproject.toml declares "
        f"{declared!r}. Bump both — a release that changes only one publishes a package that "
        f"misreports its own version."
    )


def test_dunder_version_matches_installed_distribution() -> None:
    """Belt and braces: when the package is installed, its metadata must agree too."""
    try:
        installed = dist_version("cortadel")
    except PackageNotFoundError:  # pragma: no cover - source-tree-only environments
        pytest.skip("cortadel is not installed as a distribution in this environment")
    assert cortadel.__version__ == installed, (
        f"cortadel.__version__ is {cortadel.__version__!r} but the installed distribution is "
        f"{installed!r}."
    )
