"""Uniform failure reporting for every Cortadel call this package makes.

Two knobs, and they are orthogonal on purpose:

- `raise_on_error` (`bool`, default `False`) — propagate the failure to the caller.
- `on_error` (callback, default `None`) — *observe* the failure. Always a callback, never a mode
  string.

Fail-open is the default: a memory outage must never take the agent down. When a failure is
swallowed and no `on_error` callback is set, it is logged as a warning through the standard
`logging` module instead — an observer and a log line are the same mechanism at different volumes,
so there is no separate "warn" / "ignore" mode.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from cortadel import CortadelError

logger = logging.getLogger(__name__)

OnError = Callable[[Exception], None]
"""Observer invoked with the exception a Cortadel call raised."""


def describe(error: Exception) -> str:
    """`code: message` for a `CortadelError`, `TypeName: message` for anything else."""
    if isinstance(error, CortadelError):
        return f"{error.code}: {error.message}"
    return f"{type(error).__name__}: {error}"


def notify(on_error: OnError | None, action: str, error: Exception) -> bool:
    """Hand `error` to `on_error`. Returns whether an observer actually saw it.

    A callback that raises is itself swallowed and logged: an observer must not be able to take
    the agent down through the very path that exists to keep it running.
    """
    if on_error is None:
        return False
    try:
        on_error(error)
    except Exception:  # noqa: BLE001 - an observer's own bug is not the agent's problem
        logger.warning(
            "cortadel-deepagents: the on_error callback raised while reporting a %s failure.",
            action,
            exc_info=True,
        )
    return True
