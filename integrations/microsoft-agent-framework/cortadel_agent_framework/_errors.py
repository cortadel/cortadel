# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""One place where a Cortadel failure is turned into an observable event.

Both legs of this package -- the context provider and the function tools -- promise the same
thing: a Cortadel outage degrades the agent to "no long-term memory", never to "no agent". That
promise has exactly two knobs, and they are the same pair everywhere in the Cortadel integrations:

* ``raise_on_error`` (``bool``, default ``False``) -- propagate the failure to the caller.
* ``on_error`` (callback, default ``None``) -- *observe* the failure. Always a callback, never a
  mode string.

When a failure is swallowed and no callback is set, the failure is logged as a warning, so a
misconfigured server can never be silent.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Optional

__all__ = ["ErrorCallback", "report_failure"]

#: Signature of the ``on_error`` observer. ``asyncio.CancelledError`` never reaches it -- it is a
#: ``BaseException`` and is re-raised untouched, because cancellation is the caller's intent
#: rather than a Cortadel failure.
ErrorCallback = Callable[[Exception], None]


def report_failure(
    exc: Exception,
    message: str,
    *,
    logger: logging.Logger,
    raise_on_error: bool,
    on_error: Optional[ErrorCallback],
    propagate: bool = True,
) -> None:
    """Report one swallowed Cortadel failure, then optionally re-raise it.

    Args:
        exc: The failure. Never a ``BaseException`` that is not an ``Exception``.
        message: Warning text used only when the failure is swallowed unobserved.

    Keyword Args:
        logger: Logger of the calling module, so the record carries the real origin.
        raise_on_error: Re-raise ``exc`` after reporting it.
        on_error: Observer. When set it *replaces* the warning log -- the caller asked to be told
            in their own way. A callback that itself raises is logged and swallowed: an observer
            must not be able to take down the agent the observation was meant to protect.
        propagate: ``False`` where there is no caller left to raise into (a fire-and-forget
            background write). Such a failure is always logged or observed, never lost.

    Raises:
        Exception: ``exc`` itself, when ``raise_on_error`` and ``propagate`` are both true.
    """
    will_raise = propagate and raise_on_error

    if on_error is not None:
        try:
            on_error(exc)
        except Exception:  # noqa: BLE001 - an observer must never break the observed path
            logger.warning("Cortadel on_error callback raised; ignoring it.", exc_info=True)
    elif not will_raise:
        # Swallowed and unobserved: the standard-library warning is the last line of defence.
        logger.warning(message, exc_info=True)

    if will_raise:
        raise exc
