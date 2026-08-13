"""Shared plumbing: client construction, fail-soft call wrapping, and memory formatting.

Two rules govern everything in this module.

1. **Memory must never take down the agent.** Every Cortadel call goes through
   :func:`call_safely`, which reports and degrades instead of raising. Callers opt into strictness
   with ``raise_on_error=True``, and observe failures with an ``on_error`` callback.
2. **A Cortadel client is bound to one user id at construction** — no method takes a user id. So
   "scope memory to a user" means "build one client per user", which is what
   :func:`build_client` exists to make explicit.
"""

from __future__ import annotations

import inspect
import logging
import os
from collections.abc import Awaitable, Callable, Iterable, Sequence
from typing import Any, TypeVar

from cortadel import CortadelClient, CortadelError, SearchHit

__all__ = [
    "DEFAULT_APP_NAME",
    "DEFAULT_BASE_URL",
    "DEFAULT_MEMORY_HEADER",
    "OnError",
    "build_client",
    "call_safely",
    "filter_hits",
    "format_memory_block",
    "header_already_present",
    "logger",
    "resolve_api_key",
    "resolve_base_url",
]

logger = logging.getLogger("cortadel_openai_agents")

#: Recorded by the server for access logging on searches. Identifies this integration.
DEFAULT_APP_NAME = "cortadel-openai-agents"

#: Self-hosted default (``docker compose up``). The hosted service is ``https://app.cortadel.ai``.
DEFAULT_BASE_URL = "http://localhost:3001"

DEFAULT_MEMORY_HEADER = "# Long-term memory (Cortadel)"

_MEMORY_PREAMBLE = (
    "Facts recalled from earlier conversations with this user. Treat them as background "
    "knowledge you already have. Use what is relevant, ignore what is not, and prefer what the "
    "user says now if it contradicts a recalled fact. Do not mention this block to the user."
)

T = TypeVar("T")

#: Observer for a Cortadel failure. Receives the exception; its return value is ignored, and a
#: coroutine is awaited. It is called for *every* memory failure — observing a failure is
#: independent of whether ``raise_on_error`` then propagates it.
OnError = Callable[[Exception], Any]


def resolve_base_url(base_url: str | None) -> str:
    """Explicit argument wins, then ``CORTADEL_BASE_URL``, then the self-hosted default."""
    return base_url or os.environ.get("CORTADEL_BASE_URL") or DEFAULT_BASE_URL


def resolve_api_key(api_key: str | None) -> str | None:
    """Explicit argument wins, then ``CORTADEL_API_KEY``.

    ``None`` is valid: a self-hosted server with an empty ``Auth:Secret`` accepts unauthenticated
    requests.
    """
    return api_key or os.environ.get("CORTADEL_API_KEY") or None


def build_client(
    user_id: str,
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    app_name: str = DEFAULT_APP_NAME,
) -> CortadelClient:
    """Construct a Cortadel client scoped to ``user_id``.

    The async client is the right one here: every seam we plug into (``Session.get_items`` /
    ``add_items``, ``RunConfig.call_model_input_filter``, and ``@function_tool`` bodies) is
    awaited by the runner, so a blocking client would stall the event loop for no benefit.
    """
    return CortadelClient(
        resolve_base_url(base_url),
        user_id,
        api_key=resolve_api_key(api_key),
        app_name=app_name,
    )


async def notify_error(
    on_error: OnError | None, exc: Exception, *, description: str
) -> bool:
    """Hand ``exc`` to ``on_error``. Returns whether a callback was actually invoked.

    A callback that raises must not replace the failure it was told about, so its own exception is
    logged and dropped.
    """
    if on_error is None:
        return False
    try:
        result = on_error(exc)
        if inspect.isawaitable(result):
            await result
    except Exception as callback_error:  # noqa: BLE001 - an observer must not become the failure
        logger.warning(
            "Cortadel on_error callback raised while reporting a %s failure: %s",
            description,
            callback_error,
        )
    return True


def log_failure(description: str, exc: Exception) -> None:
    """Warn through the stdlib logger — the fallback when no ``on_error`` callback is set."""
    if isinstance(exc, CortadelError):
        logger.warning(
            "Cortadel %s failed (status=%s code=%s): %s",
            description,
            exc.status,
            exc.code,
            exc.message,
        )
    else:
        logger.warning("Cortadel %s failed: %s", description, exc)


async def call_safely(
    factory: Callable[[], Awaitable[T]],
    *,
    description: str,
    raise_on_error: bool,
    default: T,
    on_error: OnError | None = None,
) -> T:
    """Await ``factory()``, degrading to ``default`` when Cortadel is unavailable.

    ``on_error`` observes the failure either way; ``raise_on_error`` decides whether it then
    propagates. When a failure is swallowed and no ``on_error`` is set, it is logged as a warning
    instead — a callback replaces the log, it does not add to it.

    ``asyncio.CancelledError`` derives from ``BaseException``, not ``Exception``, so cancellation
    propagates untouched — a cancelled run is not a memory failure.
    """
    try:
        return await factory()
    except Exception as exc:  # noqa: BLE001 - deliberate: memory degrades, the agent continues
        reported = await notify_error(on_error, exc, description=description)
        if raise_on_error:
            raise
        if not reported:
            log_failure(description, exc)
        return default


def filter_hits(hits: Sequence[SearchHit], min_score: float | None) -> list[SearchHit]:
    """Drop hits below ``min_score``.

    ``SearchHit.rrf_score`` is optional; a hit without one is kept, because the alternative is
    silently discarding results the server did rank.
    """
    if min_score is None:
        return list(hits)
    return [hit for hit in hits if hit.rrf_score is None or hit.rrf_score >= min_score]


def format_memory_block(hits: Sequence[SearchHit], header: str = DEFAULT_MEMORY_HEADER) -> str:
    """Render search hits as the block injected into the model's context.

    Returns an empty string for no hits, which callers treat as "inject nothing".
    """
    lines = [hit.content.strip() for hit in hits if hit.content and hit.content.strip()]
    if not lines:
        return ""

    numbered = "\n".join(f"{index}. {line}" for index, line in enumerate(lines, start=1))
    return f"{header}\n{_MEMORY_PREAMBLE}\n\n{numbered}"


def header_already_present(header: str, haystacks: Iterable[Any]) -> bool:
    """Whether ``header`` already appears in any of ``haystacks``.

    Guards against double-injection when this filter is chained with another one — or with a
    second Cortadel session — that already added the block.
    """
    return any(isinstance(text, str) and header in text for text in haystacks)
