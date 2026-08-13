"""Internal helpers shared by the memory, tools, and listener modules.

Nothing in here is part of the public API — import from ``cortadel_crewai``.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Callable, Optional, TypeVar

from cortadel import SearchHit, SyncCortadelClient

logger = logging.getLogger("cortadel_crewai")

#: Recorded on every request for access logging (see ``CortadelClient.app_name``).
DEFAULT_APP_NAME = "cortadel-crewai"

#: Self-hosted default from the Cortadel docs; hosted is ``https://app.cortadel.ai``.
DEFAULT_BASE_URL = "http://localhost:3001"

#: Cortadel's server-side cap on ``SearchOptions.top_k``.
MAX_TOP_K = 50

T = TypeVar("T")


def env_base_url() -> str:
    """Return ``CORTADEL_BASE_URL`` or the self-hosted default."""
    return os.environ.get("CORTADEL_BASE_URL") or DEFAULT_BASE_URL


def env_user_id() -> Optional[str]:
    """Return ``CORTADEL_USER_ID`` if set."""
    return os.environ.get("CORTADEL_USER_ID") or None


def env_api_key() -> Optional[str]:
    """Return ``CORTADEL_API_KEY`` if set (self-hosted servers may run without auth)."""
    return os.environ.get("CORTADEL_API_KEY") or None


def build_client(
    base_url: Optional[str] = None,
    user_id: Optional[str] = None,
    api_key: Optional[str] = None,
    app_name: str = DEFAULT_APP_NAME,
) -> SyncCortadelClient:
    """Construct a blocking Cortadel client, falling back to ``CORTADEL_*`` env vars.

    CrewAI calls memory synchronously from agent/task threads, so this uses
    :class:`cortadel.SyncCortadelClient` (one background event loop for its
    lifetime) rather than the async facade.

    Raises:
        ValueError: If no user id is available from the argument or the environment.
    """
    resolved_user = user_id or env_user_id()
    if not resolved_user:
        raise ValueError(
            "A Cortadel user_id is required: pass user_id=... or set CORTADEL_USER_ID. "
            "Every Cortadel client is scoped to one user id at construction."
        )
    return SyncCortadelClient(
        base_url or env_base_url(),
        resolved_user,
        api_key=api_key if api_key is not None else env_api_key(),
        app_name=app_name,
    )


def clamp_top_k(limit: int) -> int:
    """Clamp a CrewAI ``limit`` into Cortadel's accepted ``top_k`` range (1–50)."""
    if limit < 1:
        return 1
    return min(limit, MAX_TOP_K)


def guard(
    action: str,
    fn: Callable[[], T],
    fallback: T,
    *,
    raise_on_error: bool = False,
    on_error: Optional[Callable[[BaseException], None]] = None,
) -> T:
    """Run ``fn``; on failure notify/log and return ``fallback``.

    Memory is an enhancement, never a dependency: an unreachable Cortadel server
    must degrade an agent to "no memories", not crash the crew.

    Args:
        action: The Cortadel call being made, used in the log line.
        fn: The zero-argument thunk to run.
        fallback: Returned when ``fn`` fails and the error is swallowed.
        raise_on_error: When True, re-raise instead of returning ``fallback``.
        on_error: Called with the exception on **every** failure, whether or not
            it is re-raised — it is an observer, not a handler. When it is set,
            the default warning is not logged (you are already being told). A
            callback that itself raises is swallowed and logged, so a broken
            observer cannot mask the original failure.
    """
    try:
        return fn()
    except Exception as exc:
        if on_error is not None:
            try:
                on_error(exc)
            except Exception:
                logger.warning(
                    "Cortadel on_error callback raised while reporting a failed %s.",
                    action,
                    exc_info=True,
                )
        if raise_on_error:
            raise
        if on_error is None:
            logger.warning(
                "Cortadel %s failed; continuing without memory.", action, exc_info=True
            )
        return fallback


def parse_timestamp(value: Any) -> datetime:
    """Parse Cortadel's ISO-8601 ``created_at`` into an aware ``datetime``.

    ``SearchHit.created_at`` and ``MemoryCreated.created_at`` are ISO strings
    (``MemoryListItem``/``MemoryDetail`` use Unix seconds instead). A trailing
    ``Z`` is normalised to ``+00:00`` explicitly: ``fromisoformat`` only learned
    to accept ``Z`` in 3.11, and doing it here keeps the parse independent of
    the interpreter version rather than of this package's floor.
    """
    now = datetime.now(timezone.utc)
    if value is None:
        return now
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return now
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return now
    return now


def hit_reasons(hit: SearchHit) -> list[str]:
    """Build human-readable provenance strings for a Cortadel search hit."""
    reasons: list[str] = []
    if hit.text_rank is not None:
        reasons.append(f"cortadel:bm25_rank={hit.text_rank}")
    if hit.vector_rank is not None:
        reasons.append(f"cortadel:vector_rank={hit.vector_rank}")
    if hit.memory_type:
        reasons.append(f"cortadel:memory_type={hit.memory_type}")
    if hit.is_global:
        reasons.append("cortadel:global")
    if not reasons:
        reasons.append("cortadel:hybrid")
    return reasons
