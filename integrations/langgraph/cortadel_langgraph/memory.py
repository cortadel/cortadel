"""Automatic memory: recall before the model, persist after the turn.

Two graph nodes, so the agent gets long-term memory without ever deciding to call a tool.

``recall_node``
    Searches Cortadel with the user's latest message and prepends the hits as a
    ``SystemMessage``. It writes them to ``llm_input_messages`` — the ephemeral channel
    ``create_react_agent`` reads for exactly this purpose ("used directly as LLM input without
    updating state messages", ``chat_agent_executor.py``). Because it is ephemeral, recalled
    memories are *never* accumulated into the transcript: each turn injects only what is relevant
    now, and nothing is re-injected turn after turn.

``remember_node``
    After the model produces a final answer (not a tool call), hands the new turns to Cortadel's
    ``add_conversation`` pipeline, which distils durable facts from them. A per-thread cursor means
    each message is submitted at most once, even though the node runs after *every* model call in
    a tool loop.

    The write is **awaited**; there is deliberately no fire-and-forget option. A graph node has no
    lifetime of its own — once the run finishes, LangGraph or its host may tear down the event loop
    or the process, so a detached write would be silently lost. Cortadel's extraction already runs
    off the request path server-side, so awaiting costs only the round trip.

Both are plain ``(state, config) -> dict`` callables, so they work three ways:

* as nodes in a hand-built ``StateGraph`` (the current, non-deprecated LangGraph API),
* as ``pre_model_hook`` / ``post_model_hook`` of ``create_react_agent``,
* through the :attr:`~CortadelMemory.pre_model_hook` / :attr:`~CortadelMemory.post_model_hook`
  properties, which wrap the sync and async pair in a single ``RunnableLambda`` usable by both
  ``.invoke()`` and ``.ainvoke()``.
"""
from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Any, Mapping, Optional, Sequence

from cortadel import ChatMessage
from langchain_core.messages import AnyMessage, BaseMessage, SystemMessage
from langchain_core.runnables import RunnableConfig, RunnableLambda
from langgraph.store.base import BaseStore

from ._namespace import DEFAULT_NAMESPACE, NamespaceLike, resolve_namespace
from ._runtime import ambient_store

__all__ = ["DEFAULT_RECALL_HEADER", "CortadelMemory"]

logger = logging.getLogger(__name__)

DEFAULT_RECALL_HEADER = (
    "Long-term memory about this user, retrieved from Cortadel. Treat it as background you "
    "already know; use it when relevant and do not mention that it came from a memory system."
)

# Roles Cortadel's conversation-ingest endpoint accepts. Tool traffic is deliberately excluded:
# raw tool payloads are noise the extraction pipeline should not be mining for user facts.
_ROLES = {"human": "user", "ai": "assistant", "system": "system"}

_NO_THREAD = "__no_thread__"


class CortadelMemory:
    """Automatic Cortadel recall and persistence for a LangGraph agent.

    Args:
        store: The store to use. ``None`` resolves the ambient store via
            ``langgraph.config.get_store()`` at call time. Recall works against any
            ``BaseStore``; persistence additionally needs a
            :class:`~cortadel_langgraph.store.CortadelStore` (only it has ``add_conversation``).
        namespace: Namespace to recall from and persist to, possibly templated
            (``("memories", "{user_id}")``); placeholders come from ``config["configurable"]``.
        top_k: Maximum memories injected per turn.
        header: Sentence introducing the injected memories.
        messages_key: State key holding the conversation.
        output_key: State key the recalled-plus-original message list is written to. The default,
            ``"llm_input_messages"``, is ephemeral in ``create_react_agent``. Point it at
            ``"messages"`` only if you understand that the memory block then becomes a permanent
            part of the transcript and will accumulate.
        persist: Set ``False`` for a read-only agent.
        recall: Set ``False`` to persist only.
        session_from_thread: Record the LangGraph ``thread_id`` as the Cortadel session id, which
            groups the extracted facts.
        project: Optional Cortadel project scope recorded on persisted facts.
        tags: Optional Cortadel tags applied to every persisted fact.
        max_tracked_threads: Cap on the per-thread recall cache and persistence cursors.
        logger: Logger to use.
    """

    def __init__(
        self,
        store: Optional[BaseStore] = None,
        *,
        namespace: NamespaceLike = DEFAULT_NAMESPACE,
        top_k: int = 5,
        header: str = DEFAULT_RECALL_HEADER,
        messages_key: str = "messages",
        output_key: str = "llm_input_messages",
        persist: bool = True,
        recall: bool = True,
        session_from_thread: bool = True,
        project: Optional[str] = None,
        tags: Optional[list[str]] = None,
        max_tracked_threads: int = 256,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._store = store
        self._namespace = namespace
        self._top_k = top_k
        self._header = header
        self._messages_key = messages_key
        self._output_key = output_key
        self._persist = persist
        self._recall = recall
        self._session_from_thread = session_from_thread
        self._project = project
        self._tags = tags
        self._max_tracked = max_tracked_threads
        self._log = logger if logger is not None else globals()["logger"]

        # thread -> (anchor message id, rendered memory block). One Cortadel search per user turn:
        # the model is called repeatedly inside a tool loop, but the anchor human message does not
        # change, so the block is reused instead of re-searched.
        self._recall_cache: "OrderedDict[str, tuple[str, str]]" = OrderedDict()
        # thread -> id of the last message already handed to add_conversation.
        self._cursors: "OrderedDict[str, str]" = OrderedDict()
        self._warned_no_conversation = False
        self._warned_no_store = False

    # ── Recall ──────────────────────────────────────────────────────────────────────────────

    def recall_node(
        self, state: Any, config: Optional[RunnableConfig] = None
    ) -> dict[str, Any]:
        """Search Cortadel and prepend the results. Use as a node or as ``pre_model_hook``."""
        messages = _messages_of(state, self._messages_key)
        if not self._recall or not messages:
            return {self._output_key: list(messages)}
        anchor = _last_user_message(messages)
        if anchor is None:
            return {self._output_key: list(messages)}

        thread = _thread_id(config)
        cached = self._cached_block(thread, anchor)
        if cached is not None:
            return self._inject(cached, messages)

        query = _text_of(anchor)
        if not query:
            return {self._output_key: list(messages)}
        store = self._resolve_store()
        if store is None:
            return {self._output_key: list(messages)}
        # `limit=` is BaseStore's own keyword, not ours — it stays spelled LangGraph's way.
        items = store.search(
            resolve_namespace(self._namespace, config), query=query, limit=self._top_k
        )
        block = self._render(items)
        self._cache_block(thread, anchor, block)
        return self._inject(block, messages)

    async def arecall_node(
        self, state: Any, config: Optional[RunnableConfig] = None
    ) -> dict[str, Any]:
        """Async twin of :meth:`recall_node`."""
        messages = _messages_of(state, self._messages_key)
        if not self._recall or not messages:
            return {self._output_key: list(messages)}
        anchor = _last_user_message(messages)
        if anchor is None:
            return {self._output_key: list(messages)}

        thread = _thread_id(config)
        cached = self._cached_block(thread, anchor)
        if cached is not None:
            return self._inject(cached, messages)

        query = _text_of(anchor)
        if not query:
            return {self._output_key: list(messages)}
        store = self._resolve_store()
        if store is None:
            return {self._output_key: list(messages)}
        items = await store.asearch(
            resolve_namespace(self._namespace, config), query=query, limit=self._top_k
        )
        block = self._render(items)
        self._cache_block(thread, anchor, block)
        return self._inject(block, messages)

    # ── Persistence ─────────────────────────────────────────────────────────────────────────

    def remember_node(
        self, state: Any, config: Optional[RunnableConfig] = None
    ) -> dict[str, Any]:
        """Persist the completed turn. Use as a node or as ``post_model_hook``.

        Returns an empty state update — persistence is a side effect, not graph state.
        """
        plan = self._plan_persist(state, config)
        if plan is None:
            return {}
        store, namespace, turns, cursor, thread = plan
        store.add_conversation(
            namespace,
            turns,
            session_id=thread if self._session_from_thread and thread != _NO_THREAD else None,
            project=self._project,
            tags=self._tags,
        )
        self._advance_cursor(thread, cursor)
        return {}

    async def aremember_node(
        self, state: Any, config: Optional[RunnableConfig] = None
    ) -> dict[str, Any]:
        """Async twin of :meth:`remember_node`."""
        plan = self._plan_persist(state, config)
        if plan is None:
            return {}
        store, namespace, turns, cursor, thread = plan
        await store.aadd_conversation(
            namespace,
            turns,
            session_id=thread if self._session_from_thread and thread != _NO_THREAD else None,
            project=self._project,
            tags=self._tags,
        )
        self._advance_cursor(thread, cursor)
        return {}

    # ── create_react_agent hooks ────────────────────────────────────────────────────────────

    @property
    def pre_model_hook(self) -> RunnableLambda:
        """The recall node as one Runnable that works in sync *and* async graphs."""
        return RunnableLambda(
            self.recall_node, afunc=self.arecall_node, name="cortadel_recall"
        )

    @property
    def post_model_hook(self) -> RunnableLambda:
        """The persistence node as one Runnable that works in sync *and* async graphs."""
        return RunnableLambda(
            self.remember_node, afunc=self.aremember_node, name="cortadel_remember"
        )

    # ── Internals ───────────────────────────────────────────────────────────────────────────

    def _plan_persist(
        self, state: Any, config: Optional[RunnableConfig]
    ) -> Optional[tuple[Any, tuple[str, ...], list[ChatMessage], str, str]]:
        """Decide whether this model call ends a turn, and what is new since the last persist."""
        if not self._persist:
            return None
        messages = _messages_of(state, self._messages_key)
        if not messages:
            return None
        last = messages[-1]
        # Mid tool loop: the model asked for a tool, or we are looking at the tool's reply. The
        # turn is not over, so persisting now would submit half a turn and then submit it again.
        if getattr(last, "tool_calls", None) or getattr(last, "type", None) == "tool":
            return None

        store = self._resolve_store()
        if store is None:
            return None
        if not hasattr(store, "add_conversation"):
            self._warn_no_conversation(store)
            return None

        thread = _thread_id(config)
        fresh = self._new_messages(thread, messages)
        turns = _to_chat_messages(fresh)
        if not turns:
            return None
        cursor = getattr(last, "id", None) or ""
        return store, resolve_namespace(self._namespace, config), turns, cursor, thread

    def _new_messages(self, thread: str, messages: Sequence[AnyMessage]) -> list[AnyMessage]:
        """Messages added since the last persist for this thread."""
        cursor = self._cursors.get(thread)
        if cursor:
            for index in range(len(messages) - 1, -1, -1):
                if getattr(messages[index], "id", None) == cursor:
                    return list(messages[index + 1 :])
            # The cursor is gone — the transcript was trimmed or summarised. Fall back to the
            # current turn only (from the last user message on) rather than re-submitting
            # everything, which would spam Cortadel's dedup with an entire replayed history.
            anchor = _last_user_index(messages)
            return list(messages[anchor:]) if anchor is not None else list(messages)
        return list(messages)

    def _advance_cursor(self, thread: str, cursor: str) -> None:
        if not cursor:
            return
        self._cursors[thread] = cursor
        self._cursors.move_to_end(thread)
        while len(self._cursors) > self._max_tracked:
            self._cursors.popitem(last=False)

    def _cached_block(self, thread: str, anchor: BaseMessage) -> Optional[str]:
        entry = self._recall_cache.get(thread)
        if entry is None:
            return None
        anchor_id, block = entry
        return block if anchor_id == _anchor_id(anchor) else None

    def _cache_block(self, thread: str, anchor: BaseMessage, block: str) -> None:
        self._recall_cache[thread] = (_anchor_id(anchor), block)
        self._recall_cache.move_to_end(thread)
        while len(self._recall_cache) > self._max_tracked:
            self._recall_cache.popitem(last=False)

    def _inject(self, block: str, messages: Sequence[AnyMessage]) -> dict[str, Any]:
        if not block:
            return {self._output_key: list(messages)}
        return {self._output_key: [SystemMessage(content=block), *messages]}

    def _render(self, items: Sequence[Any]) -> str:
        if not items:
            return ""
        lines = []
        for item in items:
            text = _value_text(getattr(item, "value", None))
            if text:
                lines.append(f"- {text}")
        if not lines:
            return ""
        return self._header + "\n" + "\n".join(lines)

    def _resolve_store(self) -> Optional[BaseStore]:
        if self._store is not None:
            return self._store
        resolved = ambient_store()
        if resolved is None and not self._warned_no_store:
            # Outside a graph context, or the graph was compiled without a store. Memory is an
            # enhancement — log once and let the agent run without it.
            self._warned_no_store = True
            self._log.warning(
                "CortadelMemory found no store: pass store=CortadelStore(...) to CortadelMemory, "
                "or compile the graph with it. Running without memory."
            )
        return resolved

    def _warn_no_conversation(self, store: BaseStore) -> None:
        if self._warned_no_conversation:
            return
        self._warned_no_conversation = True
        self._log.warning(
            "CortadelMemory cannot persist turns: %s is not a CortadelStore, so it has no "
            "add_conversation(). Recall still works; persistence is disabled.",
            type(store).__name__,
        )


# ── Message helpers ──────────────────────────────────────────────────────────────────────────


def _thread_id(config: Optional[RunnableConfig]) -> str:
    """The LangGraph thread this turn belongs to — the key for both per-turn caches.

    Falls back to a shared sentinel when the graph runs without a checkpointer (no ``thread_id``),
    which is correct: a graph with no thread has exactly one implicit conversation.
    """
    if not config:
        return _NO_THREAD
    configurable = config.get("configurable") or {}
    return str(configurable.get("thread_id") or _NO_THREAD)


def _messages_of(state: Any, key: str) -> list[AnyMessage]:
    """Read the message list out of a dict state or a pydantic/dataclass state object."""
    if isinstance(state, Mapping):
        messages = state.get(key)
    else:
        messages = getattr(state, key, None)
    if not messages:
        return []
    return list(messages)


def _last_user_message(messages: Sequence[AnyMessage]) -> Optional[BaseMessage]:
    index = _last_user_index(messages)
    return messages[index] if index is not None else None


def _last_user_index(messages: Sequence[AnyMessage]) -> Optional[int]:
    for index in range(len(messages) - 1, -1, -1):
        if getattr(messages[index], "type", None) == "human":
            return index
    return None


def _anchor_id(message: BaseMessage) -> str:
    """A stable identity for the turn's anchor message, even when LangChain assigned no id."""
    return getattr(message, "id", None) or f"text:{_text_of(message)[:256]}"


def _text_of(message: Any) -> str:
    """Flatten a message's content to plain text, tolerating content-block lists."""
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, Mapping) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts).strip()
    return ""


def _value_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, Mapping):
        for key in ("content", "text", "memory", "data"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    return ""


def _to_chat_messages(messages: Sequence[AnyMessage]) -> list[ChatMessage]:
    """Convert LangChain messages to Cortadel ``ChatMessage``s, dropping tool traffic."""
    turns: list[ChatMessage] = []
    for message in messages:
        if getattr(message, "tool_calls", None):
            continue
        role = _ROLES.get(getattr(message, "type", ""))
        if role is None:
            continue
        text = _text_of(message)
        if not text:
            continue
        turns.append(ChatMessage(role=role, content=text, uuid=getattr(message, "id", None)))
    return turns
