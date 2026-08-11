"""Encapsulation boundary test (mirrors ``sdk/typescript/test/client.test.ts``'s equivalent
check). ``cortadel._generated`` (the Kiota-generated transport) must never be reachable from the
public ``cortadel`` namespace: not as an attribute, and not as the ``__module__`` of anything the
package exports."""
from __future__ import annotations

import cortadel


def test_public_namespace_matches_declared_all() -> None:
    assert sorted(cortadel.__all__) == [
        "AddOptions",
        "ChatMessage",
        "ConversationIngestItem",
        "ConversationOptions",
        "ConversationResult",
        "CortadelClient",
        "CortadelError",
        "DEFAULT_LIST_SIZE",
        "HealthResult",
        "ListOptions",
        "MemoryCreated",
        "MemoryDetail",
        "MemoryList",
        "MemoryListItem",
        "SearchHit",
        "SearchOptions",
        "SearchResults",
        "SyncCortadelClient",
        "__version__",
    ]


def test_no_exported_symbol_originates_from_generated_tree() -> None:
    offenders = []
    for name in cortadel.__all__:
        obj = getattr(cortadel, name)
        module = getattr(obj, "__module__", None)
        if module and module.startswith("cortadel._generated"):
            offenders.append((name, module))
    assert offenders == []


def test_generated_package_is_not_part_of_the_public_surface() -> None:
    # Importable (it has to be, to work at all), but never exported or referenced by name from
    # the package's own public docs/__all__.
    assert "_generated" not in cortadel.__all__
    assert not any(name for name in cortadel.__all__ if "generated" in name.lower())
