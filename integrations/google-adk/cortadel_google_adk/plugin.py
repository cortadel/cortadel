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

"""Automatic memory for ADK, as a ``BasePlugin``.

ADK wires a memory service into the runner but **never writes to it on its own**
— nothing in ``google/adk/runners.py`` calls ``add_session_to_memory``. Reading
is automatic (``preload_memory`` injects before every model call); writing is
not. This plugin closes that half: it persists each completed invocation through
``after_run_callback``, the last hook in the ADK lifecycle.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional
from typing import TYPE_CHECKING

from google.adk.plugins.base_plugin import BasePlugin
from google.genai import types
from typing_extensions import override

from ._convert import memory_entry_text
from .memory_service import CortadelMemoryService

if TYPE_CHECKING:  # pragma: no cover - import cycle avoidance only
    from google.adk.agents.callback_context import CallbackContext
    from google.adk.agents.invocation_context import InvocationContext
    from google.adk.models.llm_request import LlmRequest
    from google.adk.models.llm_response import LlmResponse

logger = logging.getLogger(__name__)

DEFAULT_PLUGIN_NAME = "cortadel_memory"

DEFAULT_INJECT_TEMPLATE = """The following facts come from your long-term memory of this user.
They may be useful for answering the current request. Do not mention this block.
<CORTADEL_MEMORY>
{memories}
</CORTADEL_MEMORY>
"""


class CortadelMemoryPlugin(BasePlugin):
    """Persists every completed invocation to Cortadel, and optionally injects.

    Register it once on the app and the whole agent tree is covered::

        App(name="assistant", root_agent=agent, plugins=[CortadelMemoryPlugin(memory)])

    **Persist** (``after_run_callback``, on by default). Only the events of the
    invocation that just finished are shipped — they are selected by
    ``Event.invocation_id``, not by re-reading the session — so a long
    conversation costs one small write per turn instead of re-sending the whole
    transcript. The service's own dedup ledger is a second guard, so it is safe
    to also call ``ctx.add_session_to_memory()`` by hand.

    **Inject** (``before_model_callback``, off by default). ADK's own
    ``preload_memory`` tool already does retrieval-and-inject through whatever
    memory service is configured, and it is the recommended route — add it to
    ``LlmAgent(tools=[preload_memory])``. Set ``inject=True`` only when you want
    memory without touching the agent's tool list; enabling both would inject
    twice.

    Args:
      service: The Cortadel memory service. When ``None``, the plugin uses the
        runner's ``memory_service`` if it is a
        :class:`~cortadel_google_adk.memory_service.CortadelMemoryService`, and
        otherwise does nothing (logging once).
      name: Plugin name, as ADK reports it.
      persist: Write each finished invocation to memory.
      inject: Search memory before each model call and append the hits to the
        system instruction.
      inject_template: Format string for the injected block. Receives
        ``{memories}``.
      close_service: Close the service (and its pooled HTTP clients) when the
        runner closes the plugin. Defaults to ``True`` when the plugin was given
        a service, ``False`` when it borrows the runner's.
    """

    def __init__(
        self,
        service: Optional[CortadelMemoryService] = None,
        *,
        name: str = DEFAULT_PLUGIN_NAME,
        persist: bool = True,
        inject: bool = False,
        inject_template: str = DEFAULT_INJECT_TEMPLATE,
        close_service: Optional[bool] = None,
    ) -> None:
        super().__init__(name=name)
        self._service = service
        self._persist = persist
        self._inject = inject
        self._inject_template = inject_template
        self._close_service = service is not None if close_service is None else close_service
        self._warned_no_service = False

    # ------------------------------------------------------------------
    # Persist
    # ------------------------------------------------------------------

    @override
    async def after_run_callback(
        self, *, invocation_context: "InvocationContext"
    ) -> None:
        if not self._persist:
            return
        service = self._resolve_service(getattr(invocation_context, "memory_service", None))
        if service is None:
            return

        session = invocation_context.session
        invocation_id = invocation_context.invocation_id
        # Only this turn's events. Session events accumulate across the whole
        # conversation, and re-shipping them every turn would re-run Cortadel's
        # LLM extraction over text it has already digested.
        events = [
            event
            for event in session.events
            if getattr(event, "invocation_id", None) == invocation_id
        ]
        if not events:
            return

        try:
            await service.add_events_to_memory(
                app_name=session.app_name,
                user_id=session.user_id,
                events=events,
                session_id=session.id,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # The service already applied its failure policy (and already told
            # any on_error observer); this is the backstop for what it re-raises
            # under raise_on_error=True. A memory write must never be the reason
            # a finished agent run fails.
            logger.warning(
                "Cortadel: failed to persist invocation %s to memory.",
                invocation_id,
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Inject
    # ------------------------------------------------------------------

    @override
    async def before_model_callback(
        self, *, callback_context: "CallbackContext", llm_request: "LlmRequest"
    ) -> Optional["LlmResponse"]:
        if not self._inject:
            return None

        invocation_context = callback_context.get_invocation_context()
        service = self._resolve_service(getattr(invocation_context, "memory_service", None))
        if service is None:
            return None

        query = _first_text(callback_context.user_content)
        if not query:
            return None

        session = callback_context.session
        try:
            response = await service.search_memory(
                app_name=session.app_name,
                user_id=session.user_id,
                query=query,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Cortadel: memory injection failed.", exc_info=True)
            return None

        lines = [text for text in (memory_entry_text(m) for m in response.memories) if text]
        if not lines:
            return None

        # append_instructions is LlmRequest's public API (ADK's own
        # LoadMemoryTool uses it). The request is rebuilt for every model call,
        # so the block never accumulates across turns.
        llm_request.append_instructions(
            [self._inject_template.format(memories="\n".join(f"- {line}" for line in lines))]
        )
        return None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    @override
    async def close(self) -> None:
        if self._close_service and self._service is not None:
            await self._service.aclose()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _resolve_service(self, runner_service: object) -> Optional[CortadelMemoryService]:
        if self._service is not None:
            return self._service
        if isinstance(runner_service, CortadelMemoryService):
            return runner_service
        if not self._warned_no_service:
            self._warned_no_service = True
            logger.warning(
                "CortadelMemoryPlugin has no CortadelMemoryService: pass one to the plugin,"
                " or set Runner(memory_service=CortadelMemoryService(...)). Memory is off."
            )
        return None


def _first_text(content: Optional[types.Content]) -> str:
    """Returns the first text part of a Content, or ``""``."""
    if content is None or not content.parts:
        return ""
    for part in content.parts:
        if part.text and part.text.strip():
            return part.text.strip()
    return ""
