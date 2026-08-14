# Copyright 2026 Cortadel
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""A small pool of Cortadel clients, one per user id.

Why this exists: a ``cortadel.CortadelClient`` is bound to **one** user id at
construction — no SDK method takes a user id. Google ADK, by contrast, hands the
user id to :meth:`~google.adk.memory.BaseMemoryService.search_memory` and friends
on *every call*. So a memory service that serves more than one user needs one
client per user, cached and reused (each client owns keep-alive HTTP
connections; building one per call would be wasteful).
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable
import logging
from typing import Callable
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_MAX_CLIENTS = 128

ClientFactory = Callable[[str], object]
"""Builds a Cortadel client for one resolved user id.

Takes the user id, returns something with the ``cortadel.CortadelClient``
surface. Swappable so tests can inject a fake without a server.
"""


class ClientPool:
    """LRU cache of one Cortadel client per user id.

    Bounded so a long-lived multi-tenant agent cannot leak a client (and its
    connection pool) per user seen. Evicted clients are closed best-effort.
    """

    def __init__(
        self,
        factory: ClientFactory,
        *,
        max_clients: int = DEFAULT_MAX_CLIENTS,
    ) -> None:
        if max_clients < 1:
            raise ValueError("max_clients must be at least 1.")
        self._factory = factory
        self._max_clients = max_clients
        self._clients: "OrderedDict[str, object]" = OrderedDict()
        self._lock = asyncio.Lock()
        self._closed = False

    async def get(self, user_id: str) -> object:
        """Returns the client for ``user_id``, building it on first use."""
        async with self._lock:
            if self._closed:
                raise RuntimeError("ClientPool is closed.")
            client = self._clients.get(user_id)
            if client is not None:
                self._clients.move_to_end(user_id)
                return client

            client = self._factory(user_id)
            self._clients[user_id] = client
            evicted: list[object] = []
            while len(self._clients) > self._max_clients:
                _, victim = self._clients.popitem(last=False)
                evicted.append(victim)

        for victim in evicted:
            await _aclose_quietly(victim)
        return client

    async def aclose(self) -> None:
        """Closes every pooled client. Safe to call more than once."""
        async with self._lock:
            self._closed = True
            clients = list(self._clients.values())
            self._clients.clear()
        for client in clients:
            await _aclose_quietly(client)

    def __len__(self) -> int:
        return len(self._clients)


async def _aclose_quietly(client: object) -> None:
    """Closes a client, swallowing anything that is not a cancellation.

    Teardown must never be the thing that takes an agent down.
    """
    aclose: Optional[Callable[[], Awaitable[None]]] = getattr(client, "aclose", None)
    if aclose is None:
        return
    try:
        await aclose()
    except asyncio.CancelledError:
        raise
    except Exception:  # pragma: no cover - defensive
        logger.warning("Failed to close a Cortadel client.", exc_info=True)
