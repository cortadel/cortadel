"""Cortadel client plumbing shared by the capability and the toolset.

Two jobs live here:

1. **Client-per-user.** A `cortadel.CortadelClient` is bound to one `user_id` at construction —
   no method takes a user id — so per-user scoping means one client instance per user. `Backend`
   keeps a cache keyed by user id and hands out the right client for the current run.
2. **Graceful degradation.** Memory is an enhancement, never a dependency. Every call into
   Cortadel goes through a `try_*` wrapper that returns a sentinel on failure and reports the
   exception, so an unreachable memory server can never take an agent run down with it. Set
   `raise_on_error=True` to opt out of that and let failures propagate instead.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING, Any, Callable, Coroutine, Optional, Protocol, Union

from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    MemoryCreated,
    SearchHit,
    SearchOptions,
    SearchResults,
)

# Imported at runtime (not under TYPE_CHECKING): pydantic-ai decides whether a callable wants a
# `RunContext` by resolving the *runtime* type annotation of its first parameter
# (`pydantic_ai._utils.takes_run_context` -> `get_first_param_type`). With
# `from __future__ import annotations` every annotation is a string, so `RunContext` has to be
# resolvable from this module's globals or that detection raises `UserError`.
from pydantic_ai.tools import RunContext

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

__all__ = [
    "DEFAULT_APP_NAME",
    "DEFAULT_BASE_URL",
    "DEFAULT_RECALL_TOP_K",
    "DEFAULT_TIMEOUT",
    "DEFAULT_TOOL_TOP_K",
    "ENV_API_KEY",
    "ENV_BASE_URL",
    "ENV_USER_ID",
    "Backend",
    "ClientFactory",
    "MemoryClient",
    "UserId",
]

_log = logging.getLogger("cortadel_pydantic_ai")

DEFAULT_APP_NAME = "cortadel-pydantic-ai"
"""Recorded by Cortadel for access logging on searches, and used as `AddOptions.app`."""

DEFAULT_BASE_URL = "http://localhost:3001"
"""Self-hosted default (`docker compose up`). The hosted service is `https://app.cortadel.ai`."""

DEFAULT_TIMEOUT = 100.0
"""Seconds. Mirrors `cortadel.client.DEFAULT_TIMEOUT`."""

DEFAULT_RECALL_TOP_K = 5
"""`top_k` for the automatic recall injected before each run — it spends prompt tokens on every
run whether or not the model needed them, so it is deliberately tighter than the tool default."""

DEFAULT_TOOL_TOP_K = 10
"""`top_k` for the explicit `search_memory` tool, where the model asked for the results and pays
for them only on the turns it does. Matches `cortadel.SearchOptions.top_k`'s own default."""

ENV_BASE_URL = "CORTADEL_BASE_URL"
ENV_API_KEY = "CORTADEL_API_KEY"
ENV_USER_ID = "CORTADEL_USER_ID"


class MemoryClient(Protocol):
    """The exact subset of `cortadel.CortadelClient` this integration uses.

    Declared as a `Protocol` so tests (and anyone wrapping the SDK) can substitute a stand-in
    via `client_factory=` without a live server. The full SDK surface is larger — `list`, `get`,
    `delete` and `health` are simply not needed here.
    """

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        ...

    async def add_conversation(
        self,
        messages: "Iterable[ChatMessage]",
        options: Optional[ConversationOptions] = None,
    ) -> ConversationResult:
        ...

    async def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        ...

    async def aclose(self) -> None:
        ...


UserId = Union[str, Callable[[RunContext[Any]], str]]
"""A fixed user id, or a resolver that derives one from the run (typically from `ctx.deps`)."""

ClientFactory = Callable[[str], MemoryClient]
"""Builds a client for one user id. Overridable for tests and custom transports."""


def resolve_setting(explicit: Optional[str], env_var: str, fallback: Optional[str]) -> Optional[str]:
    """Explicit argument wins, then the environment variable, then the fallback."""
    if explicit is not None:
        return explicit
    from_env = os.getenv(env_var)
    if from_env:
        return from_env
    return fallback


class Backend:
    """Owns the per-user client cache and every call into Cortadel."""

    def __init__(
        self,
        *,
        base_url: str,
        user_id: UserId,
        api_key: Optional[str] = None,
        app_name: str = DEFAULT_APP_NAME,
        timeout: float = DEFAULT_TIMEOUT,
        client_factory: Optional[ClientFactory] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        raise_on_error: bool = False,
    ) -> None:
        self.base_url = base_url
        self.user_id = user_id
        self.api_key = api_key
        self.app_name = app_name
        self.timeout = timeout
        self.client_factory = client_factory
        self.on_error = on_error
        self.raise_on_error = raise_on_error
        # Shared by every per-run copy of the capability (see `CortadelMemory.for_run`), so HTTP
        # keep-alive survives across runs instead of reconnecting on every turn.
        self._clients: dict[str, MemoryClient] = {}
        # Strong references to in-flight fire-and-forget writes (`await_persist=False`), so the
        # event loop cannot garbage-collect a pending task mid-write. Drained by `aclose()`.
        self._pending: set[asyncio.Task[Any]] = set()

    # --- identity -----------------------------------------------------------------

    def resolve_user_id(self, ctx: Optional[RunContext[Any]]) -> str:
        """Resolve the Cortadel user id for this run.

        A callable `user_id` is the multi-tenant path: it reads the id off `ctx.deps`, which is
        pydantic-ai's own dependency-injection channel.
        """
        user_id = self.user_id
        if callable(user_id):
            if ctx is None:  # pragma: no cover - only reachable via direct misuse
                raise ValueError("A callable `user_id` needs a RunContext; none was available.")
            user_id = user_id(ctx)
        if not isinstance(user_id, str) or not user_id.strip():
            raise ValueError(f"Cortadel user_id must be a non-empty string, got {user_id!r}.")
        return user_id

    # --- clients ------------------------------------------------------------------

    def client_for(self, ctx: Optional[RunContext[Any]]) -> MemoryClient:
        """Return the cached client for this run's user, building it on first use.

        No lock is needed: resolution and construction are fully synchronous, so there is no
        await point between the cache miss and the cache write.
        """
        user_id = self.resolve_user_id(ctx)
        client = self._clients.get(user_id)
        if client is None:
            factory = self.client_factory or self._build_client
            client = factory(user_id)
            self._clients[user_id] = client
        return client

    def _build_client(self, user_id: str) -> MemoryClient:
        from cortadel import CortadelClient

        return CortadelClient(
            self.base_url,
            user_id,
            api_key=self.api_key,
            app_name=self.app_name,
            timeout=self.timeout,
        )

    # --- background writes --------------------------------------------------------

    def spawn(self, coro: "Coroutine[Any, Any, Any]") -> None:
        """Run a memory write in the background (`await_persist=False`).

        The task is kept in `_pending` — `asyncio` only holds a weak reference to a running
        task, so dropping ours would let the loop collect a half-finished write. `aclose()`
        drains what is still in flight.
        """
        try:
            task = asyncio.ensure_future(coro)
        except RuntimeError as exc:  # pragma: no cover - no running loop; only via direct misuse
            coro.close()
            self.report(exc)
            return
        self._pending.add(task)
        task.add_done_callback(self._settle)

    def _settle(self, task: "asyncio.Task[Any]") -> None:
        self._pending.discard(task)
        if not task.cancelled():
            # Retrieve any exception so asyncio does not log "exception was never retrieved" at
            # GC. It was already handed to `on_error` inside the `try_*` wrapper, and a
            # backgrounded write has no caller left for `raise_on_error` to propagate to.
            task.exception()

    async def drain(self) -> None:
        """Wait for every in-flight background write. Safe to call when there are none."""
        while self._pending:
            pending, self._pending = self._pending, set()
            # `try_*` wrappers already absorb their own failures; `return_exceptions` only
            # covers cancellation, which must not turn draining into a raise.
            await asyncio.gather(*pending, return_exceptions=True)

    async def aclose(self) -> None:
        """Drain background writes, then close every cached client. Safe to call more than once."""
        await self.drain()
        clients, self._clients = self._clients, {}
        for client in clients.values():
            try:
                await client.aclose()
            # `observe`, not `report`: teardown must not raise even under `raise_on_error`, or a
            # half-closed pool would leak every client after the one that failed.
            except Exception as exc:  # noqa: BLE001
                self.observe(exc)

    # --- error boundary -----------------------------------------------------------

    def observe(self, exc: Exception) -> None:
        """Hand a failure to `on_error`, or warn on the package logger. Never raises."""
        if self.on_error is not None:
            try:
                self.on_error(exc)
            # A broken error handler must not break the run.
            except Exception:  # noqa: BLE001
                _log.exception("cortadel: on_error callback raised")
            return
        if not self.raise_on_error:
            # Nothing else would surface this one: with `raise_on_error` set the exception
            # itself is the signal, so a warning would just double-report it.
            _log.warning("cortadel: memory call failed (%s: %s)", type(exc).__name__, exc)

    def report(self, exc: Exception) -> None:
        """Observe a failure, then re-raise it if the caller asked to see failures.

        The two knobs compose in that order and are independent: `on_error` always fires (it is
        an observer), and `raise_on_error` decides whether the run also dies.
        """
        self.observe(exc)
        if self.raise_on_error:
            raise exc

    # --- calls --------------------------------------------------------------------
    #
    # `except Exception` deliberately does not catch `asyncio.CancelledError` (a `BaseException`
    # since 3.8), so cancelling a run still cancels cleanly instead of being swallowed here.
    #
    # Each `try_*` returns `None` on failure — unless `raise_on_error` is set, in which case
    # `report()` re-raises and the sentinel is never reached.

    async def try_search(
        self,
        ctx: Optional[RunContext[Any]],
        query: str,
        *,
        top_k: int,
        mode: str,
        rerank: bool = False,
        memory_type: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Optional["list[SearchHit]"]:
        """Search memories. Returns `None` when the call failed (as opposed to `[]` for no hits)."""
        options = SearchOptions(
            top_k=_clamp(top_k, 1, 50),
            mode=mode,
            session_id=session_id,
            # The server accepts exactly one value here; omitting it skips reranking.
            rerank="cross_encoder" if rerank else None,
            memory_type=memory_type,
        )
        try:
            client = self.client_for(ctx)
            results = await client.search(query, options)
        # Memory must degrade, never fail the run.
        except Exception as exc:  # noqa: BLE001
            self.report(exc)
            return None
        return list(results.results or [])

    async def try_add(
        self,
        ctx: Optional[RunContext[Any]],
        text: str,
        *,
        memory_type: Optional[str] = None,
    ) -> Optional[MemoryCreated]:
        """Store one memory. Returns `None` when the call failed."""
        # `app_name` is only recorded for access logging on *searches*; labelling the app that
        # created a memory is a separate field on AddOptions.
        options = AddOptions(app=self.app_name, memory_type=memory_type)
        try:
            client = self.client_for(ctx)
            return await client.add(text, options)
        except Exception as exc:  # noqa: BLE001
            self.report(exc)
            return None

    async def try_add_conversation(
        self,
        ctx: Optional[RunContext[Any]],
        messages: "Sequence[ChatMessage]",
        *,
        session_id: Optional[str] = None,
        project: Optional[str] = None,
        tags: Optional["Sequence[str]"] = None,
    ) -> Optional[ConversationResult]:
        """Persist a finished turn. Returns `None` when the call failed."""
        options = ConversationOptions(
            session_id=session_id,
            project=project,
            tags=list(tags) if tags else None,
        )
        try:
            client = self.client_for(ctx)
            return await client.add_conversation(list(messages), options)
        except Exception as exc:  # noqa: BLE001
            self.report(exc)
            return None


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))
