"""The package's public surface, and the SDK methods it is allowed to call."""

from __future__ import annotations

import ast
import pathlib
import subprocess
import sys
import textwrap

import cortadel_crewai

#: The whole Cortadel facade. `close` is lifecycle, not part of the data surface.
CORTADEL_SURFACE = {"add", "add_conversation", "search", "list", "get", "delete", "health"}

PACKAGE_DIR = pathlib.Path(cortadel_crewai.__file__).parent


def test_exports_are_exactly_the_documented_surface() -> None:
    assert sorted(cortadel_crewai.__all__) == [
        "AddMemoriesSchema",
        "CortadelAddMemoriesTool",
        "CortadelConversationListener",
        "CortadelMemory",
        "CortadelSearchMemoryTool",
        "SearchMemorySchema",
        "__version__",
        "cortadel_tools",
    ]
    for name in cortadel_crewai.__all__:
        assert hasattr(cortadel_crewai, name), name


def test_version_matches_the_manifest() -> None:
    assert cortadel_crewai.__version__ == "0.1.0"


def _client_attribute_uses() -> set[str]:
    """Every attribute this package reaches for on a Cortadel client.

    Walks the package's own AST rather than the SDK's `dir()`, so an invented
    eighth method would be caught at the call site where it was invented.
    """
    used: set[str] = set()
    for path in sorted(PACKAGE_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            # `self.client.add(...)` / `shared_client.search(...)`
            if isinstance(node, ast.Attribute) and "client" in ast.unparse(node.value):
                used.add(node.attr)
            # `getattr(self.client, "close", None)`
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "getattr"
                and node.args
                and "client" in ast.unparse(node.args[0])
                and len(node.args) > 1
                and isinstance(node.args[1], ast.Constant)
                and isinstance(node.args[1].value, str)
            ):
                used.add(node.args[1].value)
    return used


def test_only_calls_methods_that_exist_on_the_cortadel_client() -> None:
    """The facade is exactly seven methods (plus close); never invent an eighth."""
    import cortadel

    used = _client_attribute_uses()
    # Guard against a scan that silently matched nothing.
    assert {"add", "add_conversation", "search", "list", "delete"} <= used, used

    assert used <= CORTADEL_SURFACE | {"close"}, used - (CORTADEL_SURFACE | {"close"})
    for name in used:
        assert callable(getattr(cortadel.SyncCortadelClient, name, None)), name


def test_the_published_facade_is_still_those_seven_methods() -> None:
    """If the SDK grows a method, this fails so the mapping table gets revisited."""
    import cortadel

    client_methods = {
        name
        for name in dir(cortadel.SyncCortadelClient)
        if not name.startswith("_") and callable(getattr(cortadel.SyncCortadelClient, name))
    }
    assert CORTADEL_SURFACE <= client_methods
    assert client_methods - CORTADEL_SURFACE == {"close"}


def test_does_not_import_the_private_generated_transport() -> None:
    """cortadel._generated is private; building on it would be a layering break."""
    for path in PACKAGE_DIR.rglob("*.py"):
        assert "_generated" not in path.read_text(encoding="utf-8"), path


def test_inert_storage_satisfies_the_crewai_storage_protocol() -> None:
    """The ``storage`` slot is duck-typed, so nothing else checks this.

    ``InertStorage`` declares its methods variadic instead of restating
    ``StorageBackend``'s parameter lists, so this test is what pins the
    contract: ``isinstance`` against the ``runtime_checkable`` protocol fails
    the moment CrewAI adds a member we do not stub, and every method is called
    with the exact keyword shape ``crewai.memory.unified_memory`` uses,
    asserting it reports "nothing stored locally" rather than raising.
    """
    import asyncio
    from datetime import datetime, timezone

    from crewai.memory.storage.backend import StorageBackend
    from crewai.memory.types import MemoryRecord

    from cortadel_crewai._inert import InertStorage

    storage = InertStorage()
    assert isinstance(storage, StorageBackend)

    record = MemoryRecord(id="e2e-crewai-inert", content="ignored")

    assert storage.save([record]) is None
    assert (
        storage.search(
            [0.1],
            scope_prefix="/a",
            categories=["c"],
            metadata_filter={"k": 1},
            limit=3,
            min_score=0.0,
        )
        == []
    )
    assert (
        storage.delete(
            scope_prefix="/a",
            categories=None,
            record_ids=["e2e-crewai-inert"],
            older_than=datetime.now(timezone.utc),
            metadata_filter=None,
        )
        == 0
    )
    assert storage.update(record) is None
    assert storage.get_record("e2e-crewai-inert") is None
    assert storage.list_records(scope_prefix="/a", limit=10, offset=0) == []
    assert storage.get_scope_info("/a").path == "/a"
    assert storage.list_scopes("/") == []
    assert storage.list_categories(scope_prefix="/a") == {}
    assert storage.count(scope_prefix=None) == 0
    assert storage.reset(scope_prefix=None) is None
    assert storage.close() is None

    # StorageBackend declares these three async and callers await them, so they
    # must stay awaitable however trivial the body is.
    assert asyncio.run(storage.asave([record])) is None
    assert asyncio.run(storage.asearch([0.1], limit=2)) == []
    assert asyncio.run(storage.adelete(record_ids=["e2e-crewai-inert"])) == 0


def test_constructing_memory_builds_no_local_vector_store(tmp_path: pathlib.Path) -> None:
    """A fresh interpreter: CortadelMemory must not pull in LanceDB, must not
    need an LLM key, and must not write ./.crewai into the caller's cwd.

    Run out-of-process because an in-process assertion on sys.modules would be
    import-order dependent — an earlier test importing crewai internals could
    make it pass or fail for the wrong reason.
    """
    script = textwrap.dedent(
        """
        import os, pathlib, sys
        os.environ.pop("OPENAI_API_KEY", None)
        for name in ("CORTADEL_BASE_URL", "CORTADEL_USER_ID", "CORTADEL_API_KEY"):
            os.environ.pop(name, None)

        from cortadel_crewai import CortadelMemory
        from cortadel_crewai._inert import InertStorage

        memory = CortadelMemory(user_id="e2e-crewai-integration", client=object())

        assert "lancedb" not in sys.modules, "LanceDB was imported"
        assert isinstance(memory.storage, InertStorage), type(memory.storage)
        assert memory._storage is memory.storage
        assert not pathlib.Path(".crewai").exists(), "a local store was written"
        print("OK")
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "OK" in result.stdout
