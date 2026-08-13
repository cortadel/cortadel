"""Persist finished CrewAI tasks to Cortadel via ``add_conversation``.

:class:`~cortadel_crewai.CortadelMemory` covers the *retrieve-before, remember-
after* loop for anything the agent explicitly saves. This listener covers the
other half of automatic memory: after each task completes, hand the whole
exchange to Cortadel's extraction pipeline so the durable facts are distilled
out of it without the agent having to decide anything.

It hooks CrewAI's event bus — ``crewai.events.BaseEventListener`` with an
``@crewai_event_bus.on(TaskCompletedEvent)`` handler, which is the framework's
documented extension point for observing a run.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from cortadel import ChatMessage
from crewai.events import BaseEventListener
from crewai.events.event_bus import CrewAIEventsBus
from crewai.events.types.task_events import TaskCompletedEvent

from cortadel_crewai._compat import DEFAULT_APP_NAME, build_client, guard, logger


class CortadelConversationListener(BaseEventListener):
    """Write each completed task to Cortadel as a two-turn conversation.

    The task description becomes the ``user`` message and the task output the
    ``assistant`` message, which is the shape Cortadel's extraction pipeline
    expects.

    Registering it is enough — ``BaseEventListener.__init__`` subscribes to the
    global bus::

        listener = CortadelConversationListener(user_id="alice")
        Crew(agents=[...], tasks=[...]).kickoff()

    Keep a reference to the instance for as long as you want it active; the bus
    holds the handler, but letting the listener be garbage collected loses the
    client it owns.

    Args:
        base_url: Cortadel server URL. Defaults to ``$CORTADEL_BASE_URL``.
        user_id: User id owning the memories. Defaults to ``$CORTADEL_USER_ID``.
        api_key: Bearer token. Defaults to ``$CORTADEL_API_KEY``.
        app_name: App name recorded for access logging.
        client: A pre-built ``cortadel.SyncCortadelClient`` (skips construction).
        session_id: Groups every fact extracted during this run.
        project: Project scope, e.g. a repository name.
        tags: Tags applied to every extracted fact.
        is_agent_memory: When True, extract facts about the assistant rather
            than about the user — usually what you want for a crew that is
            learning how to do its own job better.
        min_output_chars: Skip tasks whose output is shorter than this; trivial
            outputs are not worth an extraction round-trip.
        raise_on_error: When True, Cortadel errors propagate instead of being
            swallowed. Note where they propagate *to*: this handler runs on
            CrewAI's event-bus thread pool, so a raised error surfaces on the
            bus Future, not in the task that produced it.
        on_error: Called with the exception on every Cortadel failure, whether or
            not it is re-raised. Setting it replaces the default warning log.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        user_id: Optional[str] = None,
        api_key: Optional[str] = None,
        app_name: str = DEFAULT_APP_NAME,
        client: Any = None,
        session_id: Optional[str] = None,
        project: Optional[str] = None,
        tags: Optional[list[str]] = None,
        is_agent_memory: bool = False,
        min_output_chars: int = 1,
        raise_on_error: bool = False,
        on_error: Optional[Callable[[BaseException], None]] = None,
    ) -> None:
        self.client = client if client is not None else build_client(
            base_url=base_url, user_id=user_id, api_key=api_key, app_name=app_name
        )
        self.session_id = session_id
        self.project = project
        self.tags = tags
        self.is_agent_memory = is_agent_memory
        self.min_output_chars = min_output_chars
        self.raise_on_error = raise_on_error
        self.on_error = on_error
        super().__init__()

    def setup_listeners(self, crewai_event_bus: CrewAIEventsBus) -> None:
        """Subscribe to task completion on the shared bus."""

        @crewai_event_bus.on(TaskCompletedEvent)
        def _on_task_completed(source: Any, event: TaskCompletedEvent) -> None:
            self.record_task(event)

    def record_task(self, event: TaskCompletedEvent) -> bool:
        """Persist one completed task. Returns True when something was sent.

        Separated from the handler so it can be called (and tested) directly.
        """
        output = getattr(event, "output", None)
        if output is None:
            return False

        answer = (getattr(output, "raw", "") or "").strip()
        if len(answer) < self.min_output_chars:
            return False

        prompt = (getattr(output, "description", "") or "").strip()
        messages = []
        if prompt:
            messages.append(ChatMessage(role="user", content=prompt))
        messages.append(ChatMessage(role="assistant", content=answer))

        from cortadel import ConversationOptions

        options = ConversationOptions(
            is_agent_memory=self.is_agent_memory,
            tags=self.tags,
            project=self.project,
            session_id=self.session_id,
        )
        result = guard(
            "add_conversation",
            lambda: self.client.add_conversation(messages, options),
            None,
            raise_on_error=self.raise_on_error,
            on_error=self.on_error,
        )
        if result is None:
            return False
        if result.no_facts_extracted:
            logger.debug("Cortadel extracted no durable facts from this task.")
            return False
        return bool(result.results)
