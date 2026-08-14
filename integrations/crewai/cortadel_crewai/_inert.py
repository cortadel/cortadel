"""An inert :class:`~crewai.memory.storage.backend.StorageBackend`.

:class:`~cortadel_crewai.CortadelMemory` overrides every text-level method of
CrewAI's ``Memory`` (``remember``/``recall``/``forget``/...) and routes them at
Cortadel over HTTP, so it never needs a local vector store.

It still needs *something* in the ``storage`` slot, for two reasons:

1. ``Memory.model_post_init`` builds a **LanceDB** store whenever ``storage`` is
   a ``str``. Handing it a non-``str`` object short-circuits that branch, so
   importing this package never pulls in LanceDB, never writes ``./.crewai``,
   and never needs an embedder or an ``OPENAI_API_KEY``.
2. Any inherited scope-introspection helper we deliberately do not override
   (``list_scopes``, ``info``, ``tree``, ``list_categories``) still calls
   through to ``_storage``. Returning empty results keeps those degrading to
   "nothing here" instead of raising ``AttributeError``.

Cortadel is a flat per-user namespace with its own server-side organisation
(entity graph, categories, bi-temporal versioning), so CrewAI's local scope
hierarchy genuinely has no counterpart to report.
"""

from __future__ import annotations

from typing import Any

from crewai.memory.types import MemoryRecord, ScopeInfo


class InertStorage:
    """A no-op ``StorageBackend``: accepts writes, reports nothing stored locally.

    Structurally compatible with CrewAI's ``runtime_checkable`` ``StorageBackend``
    protocol. Deliberately not a subclass — the protocol is duck-typed, and
    inheriting it would drag ``crewai.memory.storage.backend`` into import time
    for no benefit.

    **About the signatures.** Every method here answers "nothing stored locally"
    however it is asked, so restating the protocol's filter/paging/threshold
    parameters would name arguments the body can never honour. They are declared
    variadic instead, which is both honest and *more* permissive than the real
    signature: ``crewai.memory.unified_memory`` calls these by keyword
    (``scope_prefix=``, ``limit=``, ``record_ids=``, ``min_score=``, ...) and a
    variadic accepts every one of those call shapes — including any keyword a
    future CrewAI release adds, which a restated signature would reject with
    ``TypeError``. The authoritative parameter lists live in
    ``crewai.memory.storage.backend``; mirroring them here would be a second copy
    to keep in sync for no behavioural gain.

    ``get_scope_info`` is the one exception: its argument is the only one that
    changes an answer, so it keeps a real parameter.
    """

    def save(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def search(self, *_args: Any, **_kwargs: Any) -> list[tuple[MemoryRecord, float]]:
        # Cortadel searches by *text*, not by a caller-supplied embedding, so
        # this vector-only entry point can never be served faithfully.
        # CortadelMemory.recall() overrides the text path instead.
        return []

    def delete(self, *_args: Any, **_kwargs: Any) -> int:
        return 0

    def update(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def get_record(self, *_args: Any, **_kwargs: Any) -> MemoryRecord | None:
        return None

    def list_records(self, *_args: Any, **_kwargs: Any) -> list[MemoryRecord]:
        return []

    def get_scope_info(self, scope: str) -> ScopeInfo:
        return ScopeInfo(path=scope)

    def list_scopes(self, *_args: Any, **_kwargs: Any) -> list[str]:
        return []

    def list_categories(self, *_args: Any, **_kwargs: Any) -> dict[str, int]:
        return {}

    def count(self, *_args: Any, **_kwargs: Any) -> int:
        return 0

    def reset(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    # The async trio below is `async` because ``StorageBackend`` declares it so
    # and callers await it; each one delegates to its sync twin rather than
    # repeating the empty value. This is exactly the shape of CrewAI's own
    # reference backend (``LanceDBStorage.asave``/``asearch``/``adelete`` are
    # likewise `async` with nothing to await) — there is no asynchrony to have
    # in a no-op, and dropping the keyword would break `await`.

    async def asave(self, *args: Any, **kwargs: Any) -> None:
        return self.save(*args, **kwargs)

    async def asearch(
        self, *args: Any, **kwargs: Any
    ) -> list[tuple[MemoryRecord, float]]:
        return self.search(*args, **kwargs)

    async def adelete(self, *args: Any, **kwargs: Any) -> int:
        return self.delete(*args, **kwargs)

    def close(self) -> None:
        return None
