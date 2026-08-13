"""Client plumbing: turning a DeepAgents run into a Cortadel client bound to the right user.

A Cortadel client is bound to **one** ``user_id`` at construction — no SDK method takes a user id.
DeepAgents (via LangGraph) instead carries per-run identity in two places: the typed
``runtime.context`` object declared through ``create_deep_agent(context_schema=...)``, and the
untyped ``config["configurable"]`` bag. `ClientProvider` bridges the two: it resolves a user id
from the run, then hands back a cached blocking client for that user, constructing one on first
use.

Everything here is defensive on purpose. Memory is an enhancement, never a dependency: a Cortadel
server that is down, slow, or misconfigured must degrade to "the agent runs without memory", not
"the agent crashes".
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any

from cortadel import SyncCortadelClient

if TYPE_CHECKING:  # pragma: no cover - typing only
    from langchain_core.runnables import RunnableConfig
    from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

DEFAULT_APP_NAME = "cortadel-deepagents"
"""Recorded on Cortadel searches for access logging, and set as `AddOptions.app` on writes."""

DEFAULT_BASE_URL = "http://localhost:3001"
"""Self-hosted default (`docker compose up`). The hosted service is `https://app.cortadel.ai`."""

ENV_BASE_URL = "CORTADEL_BASE_URL"
ENV_API_KEY = "CORTADEL_API_KEY"
ENV_USER_ID = "CORTADEL_USER_ID"

DEFAULT_USER_ID_KEY = "user_id"
"""Attribute on `runtime.context` / key in `config["configurable"]` holding the Cortadel user id."""


def resolve_user_id(
    runtime: Runtime[Any] | None,
    config: RunnableConfig | None,
    key: str = DEFAULT_USER_ID_KEY,
) -> str | None:
    """Find the Cortadel user id for the current run.

    Looks in `runtime.context` first (the LangGraph-native home for run-scoped identity — it is
    what `create_deep_agent(context_schema=...)` exists for), then falls back to
    `config["configurable"][key]`, which is where LangGraph Server / Studio and most
    hand-rolled callers put a user id.

    Args:
        runtime: The middleware/tool runtime, or `None`.
        config: The `RunnableConfig` for this run, or `None`.
        key: Attribute/key name to read.

    Returns:
        The user id, or `None` when the run carries no identity.
    """
    context = getattr(runtime, "context", None)
    if context is not None:
        value = context.get(key) if isinstance(context, Mapping) else getattr(context, key, None)
        if isinstance(value, str) and value:
            return value

    if config:
        configurable = config.get("configurable") or {}
        value = configurable.get(key)
        if isinstance(value, str) and value:
            return value

    return None


def resolve_thread_id(config: RunnableConfig | None) -> str | None:
    """Read LangGraph's `thread_id` — the natural analogue of a Cortadel session id."""
    if not config:
        return None
    thread_id = (config.get("configurable") or {}).get("thread_id")
    return thread_id if isinstance(thread_id, str) and thread_id else None


class ClientProvider:
    """Resolves and caches one `SyncCortadelClient` per user id.

    Three construction modes, checked in this order:

    1. `client=` — a caller-owned client. Single-user mode: that client's user id wins for every
       run, and runtime user ids are ignored (we cannot re-bind an existing client to another
       user, and the SDK exposes no way to read the id back off it).
    2. `client_factory=` — a callable `user_id -> SyncCortadelClient`. Full multi-user mode with
       caller-controlled construction (custom `httpx` client, timeouts, …).
    3. `base_url` / `api_key` / `app_name` — the default factory, which builds a
       `SyncCortadelClient` per user id.

    The blocking client is used deliberately: DeepAgents middleware hooks and tools have both sync
    and async entry points, and `SyncCortadelClient` owns one persistent background event loop for
    its lifetime (so it is safe to call from a thread that already has a running loop, and
    keep-alives are reused). Async paths offload it with `asyncio.to_thread` rather than blocking
    the agent's loop.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        user_id: str | None = None,
        api_key: str | None = None,
        app_name: str = DEFAULT_APP_NAME,
        client: SyncCortadelClient | None = None,
        client_factory: Callable[[str], SyncCortadelClient] | None = None,
        user_id_key: str = DEFAULT_USER_ID_KEY,
    ) -> None:
        self._base_url = base_url or os.environ.get(ENV_BASE_URL) or DEFAULT_BASE_URL
        self._api_key = api_key if api_key is not None else os.environ.get(ENV_API_KEY)
        self._app_name = app_name
        self._static_user_id = user_id or os.environ.get(ENV_USER_ID)
        self._client = client
        self._client_factory = client_factory
        self.user_id_key = user_id_key

        self._owned: dict[str, SyncCortadelClient] = {}
        self._lock = threading.Lock()
        self._warned: set[str] = set()

    @property
    def app_name(self) -> str:
        return self._app_name

    @property
    def is_single_user(self) -> bool:
        """`True` when a caller-supplied client pins every run to one user."""
        return self._client is not None

    def _warn_once(self, key: str, message: str, *args: Any) -> None:
        if key in self._warned:
            return
        self._warned.add(key)
        logger.warning(message, *args)

    def for_run(
        self,
        runtime: Runtime[Any] | None,
        config: RunnableConfig | None,
    ) -> SyncCortadelClient | None:
        """Return the client for this run, or `None` when no user id can be resolved.

        Returning `None` (rather than raising) is what makes an unconfigured or partially
        configured deployment degrade into "no memory this run" instead of a hard failure.
        """
        runtime_user_id = resolve_user_id(runtime, config, self.user_id_key)

        if self._client is not None:
            if runtime_user_id and self._static_user_id and runtime_user_id != self._static_user_id:
                self._warn_once(
                    "pinned-client",
                    "cortadel-deepagents: a client= was supplied, so the run's %s=%r is ignored and "
                    "memories stay scoped to %r. Pass client_factory= for multi-user agents.",
                    self.user_id_key,
                    runtime_user_id,
                    self._static_user_id,
                )
            return self._client

        user_id = runtime_user_id or self._static_user_id
        if not user_id:
            self._warn_once(
                "no-user-id",
                "cortadel-deepagents: no Cortadel user id for this run (looked at "
                "runtime.context.%s, config['configurable']['%s'], the user_id= argument and $%s). "
                "Memory is disabled for this run.",
                self.user_id_key,
                self.user_id_key,
                ENV_USER_ID,
            )
            return None

        return self.for_user(user_id)

    def for_user(self, user_id: str) -> SyncCortadelClient | None:
        """Return (constructing and caching on first use) the client for `user_id`."""
        if self._client is not None:
            return self._client

        with self._lock:
            existing = self._owned.get(user_id)
            if existing is not None:
                return existing

            try:
                built = (
                    self._client_factory(user_id)
                    if self._client_factory is not None
                    else SyncCortadelClient(
                        self._base_url,
                        user_id,
                        api_key=self._api_key,
                        app_name=self._app_name,
                    )
                )
            except Exception:  # noqa: BLE001 - a bad base_url must not kill the agent
                self._warn_once(
                    f"construct:{user_id}",
                    "cortadel-deepagents: could not construct a Cortadel client for user %r "
                    "(base_url=%r). Memory is disabled for this user.",
                    user_id,
                    self._base_url,
                )
                logger.debug("Cortadel client construction failed", exc_info=True)
                return None

            self._owned[user_id] = built
            return built

    def close(self) -> None:
        """Close every client this provider constructed.

        Caller-supplied `client=` instances are never closed here — you own their lifecycle,
        exactly as the SDK's own `aclose()` contract does for a caller-supplied `http_client`.
        """
        with self._lock:
            clients = list(self._owned.values())
            self._owned.clear()
        for client in clients:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                logger.debug("Cortadel client close failed", exc_info=True)
