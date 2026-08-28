"""The blocking facade over :class:`cortadel.client.CortadelClient`.

The generated transport is async-only: Kiota's Python runtime ships exactly one HTTP adapter
(``kiota_http.HttpxRequestAdapter``) and it is ``httpx.AsyncClient``-typed, so every generated
operation is ``async def``. The repo owner decided the package ships both an async client and a
*real* sync facade — not ``asyncio.run(...)`` called once per method.

Why not ``asyncio.run`` per call: it creates and tears down a brand new event loop on every
invocation. Doing that here would tear down the underlying ``httpx.AsyncClient``'s connection pool
with it, so every call would pay a fresh TCP/TLS handshake instead of reusing a keep-alive
connection — and it raises outright (``RuntimeError: asyncio.run() cannot be called from a running
event loop``) if a :class:`SyncCortadelClient` method is ever called from a thread that already
has a running loop (e.g. from inside an async application, or from a callback).

The design used instead: a single dedicated background thread runs one persistent asyncio event
loop for the client's entire lifetime. The underlying :class:`~cortadel.client.CortadelClient`
(and therefore its ``httpx.AsyncClient`` connection pool) is constructed *on that loop* and lives
there for as long as the sync client is open. Every public method packages its call as a coroutine
and submits it to that same loop via ``asyncio.run_coroutine_threadsafe(...).result()``, which
blocks the calling thread until the coroutine finishes and re-raises whatever it raised (including
:class:`~cortadel.models.CortadelError`). Because every call runs on the same loop against the
same connection pool, keep-alive connections are reused across calls exactly like the async
facade — this is not meaningfully slower than the async client for sequential use.

:meth:`close` (or exiting the ``with`` block) closes the ``httpx.AsyncClient`` on its own loop
first (required — closing an async HTTP client from a different thread/loop than the one it made
requests on is undefined behavior for httpx), then stops the loop and joins the background thread,
so nothing outlives the client: no dangling thread, no running loop, no open sockets. If
construction itself fails (e.g. a bad ``base_url``), the background thread and loop are torn down
before the exception propagates, so a failed constructor call never leaks a thread either.
"""
from __future__ import annotations

import asyncio
import threading
from collections.abc import Iterable
from concurrent.futures import Future
from typing import Any, Optional

import httpx

from cortadel.client import DEFAULT_APP_NAME, DEFAULT_TIMEOUT, CortadelClient
from cortadel.models import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    HealthResult,
    ListOptions,
    MemoryCreated,
    MemoryDetail,
    MemoryList,
    SearchOptions,
    SearchResults,
)


class SyncCortadelClient:
    """A blocking, typed client for the Cortadel REST API with the same seven methods and types
    as :class:`~cortadel.client.CortadelClient`. Create one and reuse it; close it (or use it as a
    context manager) when done — see the module docstring for the background-event-loop design
    that makes this a real synchronous client rather than ``asyncio.run`` per call.

    ``user_id`` is optional here for exactly the same reason and with exactly the same behavior as
    on the async client: omit it and no ``user_id`` is sent at all (the server resolves identity
    from the API key, which needs a server built from commit ``30b70ea4`` or later); pass it and
    it is sent unchanged, which an auth-disabled server still requires.
    """

    def __init__(
        self,
        base_url: str,
        user_id: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        app_name: str = DEFAULT_APP_NAME,
        http_client: Optional[httpx.AsyncClient] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        """Same parameters, defaults and validation as
        :class:`~cortadel.client.CortadelClient.__init__` — including an optional ``user_id``
        (omitted entirely from every request when not given, rejected when explicitly given but
        blank, and still required in practice on an auth-disabled server). Raises whatever the async
        constructor raises (e.g. ``ValueError`` for a blank/malformed ``base_url``, or for a
        ``user_id`` that was passed but is blank) synchronously, from this call, before
        returning."""
        self._closed = False
        self._loop = asyncio.new_event_loop()
        started = threading.Event()

        def _run_loop() -> None:
            asyncio.set_event_loop(self._loop)
            started.set()
            self._loop.run_forever()

        self._thread = threading.Thread(target=_run_loop, name="cortadel-sync-loop", daemon=True)
        self._thread.start()
        started.wait()

        async def _construct() -> CortadelClient:
            return CortadelClient(
                base_url,
                user_id,
                api_key=api_key,
                app_name=app_name,
                http_client=http_client,
                timeout=timeout,
            )

        try:
            self._client: CortadelClient = self._submit(_construct()).result()
        except BaseException:
            # Construction failed (e.g. an invalid base_url): the background thread would
            # otherwise leak, running forever with nothing referencing it.
            self._shutdown_loop()
            raise

    # ── Public API — same seven methods as CortadelClient, blocking ────────────────────────────
    #
    # Every method below hands `_run` a zero-argument thunk, not an already-constructed
    # coroutine — `_run` checks `self._closed` *before* calling the thunk. Constructing a
    # coroutine object (e.g. `self._client.health()`) and then discovering the client is closed
    # would leak that coroutine unawaited, which Python's coroutine machinery reports as a
    # `RuntimeWarning: coroutine '...' was never awaited` (and, on some interpreters, a noisy
    # unraisable-exception report at garbage-collection time) — not a clean `RuntimeError`.

    def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        return self._run(lambda: self._client.add(text, options))

    def add_conversation(
        self, messages: Iterable[ChatMessage], options: Optional[ConversationOptions] = None
    ) -> ConversationResult:
        return self._run(lambda: self._client.add_conversation(messages, options))

    def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        return self._run(lambda: self._client.search(query, options))

    def list(self, options: Optional[ListOptions] = None) -> MemoryList:
        return self._run(lambda: self._client.list(options))

    def get(self, memory_id: str) -> Optional[MemoryDetail]:
        return self._run(lambda: self._client.get(memory_id))

    def delete(self, memory_ids: Iterable[str]) -> str:
        return self._run(lambda: self._client.delete(memory_ids))

    def health(self) -> HealthResult:
        return self._run(lambda: self._client.health())

    def close(self) -> None:
        """Closes the underlying HTTP client on its own loop, then stops the loop and joins the
        background thread. Safe to call more than once."""
        if self._closed:
            return
        self._closed = True
        try:
            asyncio.run_coroutine_threadsafe(self._client.aclose(), self._loop).result(timeout=10)
        finally:
            self._shutdown_loop()

    def __enter__(self) -> "SyncCortadelClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # ── Loop plumbing ───────────────────────────────────────────────────────────────────────

    def _submit(self, coro: Any) -> Future:
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def _run(self, make_coro: Any) -> Any:
        if self._closed:
            raise RuntimeError("SyncCortadelClient is closed.")
        return self._submit(make_coro()).result()

    def _shutdown_loop(self) -> None:
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=10)
        # `stop()` only breaks out of `run_forever()`; the loop object itself (and, notably on
        # Windows, the ProactorEventLoop's internal self-pipe socket pair used to wake the loop)
        # stays open until `close()` is called explicitly. Skipping this leaked a real socket and
        # the loop itself on every `close()` — caught by this SDK's own test suite via
        # ResourceWarning-turned-test-failure (pytest's `filterwarnings = ["error"]"`), not by
        # inspection. Safe to call here: `join()` above guarantees the loop is no longer running.
        self._loop.close()


__all__ = ["SyncCortadelClient"]
