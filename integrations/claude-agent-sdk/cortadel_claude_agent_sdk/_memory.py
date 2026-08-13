"""Cortadel long-term memory wired into the Claude Agent SDK's two native seams.

There is one object, :class:`CortadelMemory`, and it produces both halves of an integration:

* **Tools** — ``search_memory`` and ``add_memories``, defined with the SDK's ``@tool`` decorator
  and packaged by ``create_sdk_mcp_server`` into an *in-process* MCP server (no subprocess, no
  IPC). Referenced as ``mcp__<server_name>__<tool_name>``, per
  https://code.claude.com/docs/en/agent-sdk/custom-tools ("The key in ``mcpServers`` becomes the
  ``{server_name}`` segment in each tool's fully qualified name").
* **Automatic memory** — two ``HookCallback``s registered through ``ClaudeAgentOptions.hooks``:
  a ``UserPromptSubmit`` hook that searches Cortadel and injects the hits as
  ``hookSpecificOutput.additionalContext``, and a ``Stop`` hook that persists the finished turn
  through ``add_conversation``.

Design notes worth knowing before you read the code:

* **A Cortadel client is bound to one user id at construction** — no Cortadel method takes a user
  id. So per-user scoping here means *one ``CortadelMemory`` per user*, not a user id threaded
  through hooks. This also matches the SDK, whose hook inputs carry ``session_id``/``cwd`` but no
  user identity at all. Session and project scoping *are* per-call, and are taken from the hook
  input (``session_id`` → :attr:`cortadel.ConversationOptions.session_id`, ``basename(cwd)`` →
  ``project``).
* **Async all the way down.** The SDK invokes hooks and tool handlers as coroutines on its own
  event loop, so this uses the async :class:`cortadel.CortadelClient`. Do **not** substitute
  ``SyncCortadelClient`` here: its blocking ``.result()`` would stall the loop the agent is
  running on.
* **Memory degrades, it never breaks the agent.** Every hook is total — a dead Cortadel server,
  a timeout, or a malformed response yields an empty hook result and the turn proceeds untouched.
  That is ``raise_on_error=False``, the default; flip it to ``True`` and a memory failure
  propagates out of the hook instead. Either way an ``on_error`` callback, if you pass one, sees
  the exception. Tool handlers surface failures to the model as ``is_error`` results instead of
  raising. Configuration errors are the deliberate exception: a bad ``base_url`` raises at
  construction, where you can see it, rather than silently disabling memory later.
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import PurePath
from typing import TYPE_CHECKING, Any, Optional, Protocol

from anyio import fail_after, to_thread
from claude_agent_sdk import (
    ClaudeAgentOptions,
    HookMatcher,
    ToolAnnotations,
    create_sdk_mcp_server,
    tool,
)
from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    CortadelClient,
    CortadelError,
    MemoryCreated,
    SearchOptions,
    SearchResults,
)

from cortadel_claude_agent_sdk._transcript import Exchange, last_exchange

if TYPE_CHECKING:  # `HookEvent` is defined in claude_agent_sdk.types but not re-exported at the
    # package root (its `__all__` has HookEventMessage, not HookEvent), so it is imported for
    # typing only — nothing at runtime depends on it.
    from claude_agent_sdk.types import HookContext, HookEvent, HookInput, HookJSONOutput
    from claude_agent_sdk.types import McpSdkServerConfig

__all__ = ["CortadelLike", "CortadelMemory", "DEFAULT_APP_NAME", "DEFAULT_SERVER_NAME"]

_LOGGER = logging.getLogger("cortadel_claude_agent_sdk")
"""Where a swallowed memory failure goes when no ``on_error`` callback is set."""

DEFAULT_APP_NAME = "cortadel-claude-agent-sdk"
"""Recorded against searches for access logging, and stamped on tool-written memories."""

DEFAULT_SERVER_NAME = "cortadel"
"""MCP server key — it becomes the ``mcp__cortadel__*`` prefix on every tool name."""

_HOOK_TIMEOUT_MARGIN = 5.0
"""Slack added to our own budget when setting ``HookMatcher.timeout``, so the CLI-side timeout
never fires before our timeout does (the CLI's own default is 60s)."""

_MAX_HIT_CHARS = 300
"""Per-memory truncation inside the injected block. Matches the cortadel-memory plugin."""

_MAX_TRACKED_SESSIONS = 32
_MAX_SEEN_PER_SESSION = 512

_SEARCH_TOOL_SCHEMA: dict[str, Any] = {
    # Full JSON Schema rather than the `{"name": type}` shorthand: the shorthand marks every key
    # required, and `top_k` must be optional.
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": "What to recall, in natural language.",
        },
        "top_k": {
            "type": "integer",
            "minimum": 1,
            "maximum": 50,
            "description": "How many memories to return. Optional; defaults to the configured top_k.",
        },
    },
    "required": ["query"],
}

_ADD_TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "text": {
            "type": "string",
            "description": "The fact to remember, written as a standalone statement.",
        },
        "memory_type": {
            "type": "string",
            "enum": ["episodic", "semantic", "procedural"],
            "description": "Optional cognitive type. Omit to let Cortadel classify it.",
        },
    },
    "required": ["text"],
}


class CortadelLike(Protocol):
    """The slice of :class:`cortadel.CortadelClient` this package actually calls.

    Declared so tests (and anyone wrapping the client for retries or metrics) can substitute an
    object of their own via :meth:`CortadelMemory.from_client` without a live server.
    """

    async def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults: ...

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated: ...

    async def add_conversation(
        self, messages: Iterable[ChatMessage], options: Optional[ConversationOptions] = None
    ) -> ConversationResult: ...

    async def aclose(self) -> None: ...


def _iso_date(value: Any) -> str:
    """Date label for a hit. ``SearchHit.created_at`` is an ISO 8601 string on this schema, but
    Unix seconds are accepted too so the formatter survives a schema that returns them."""
    if isinstance(value, bool):
        return "unknown"
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=timezone.utc).date().isoformat()
        except (OverflowError, OSError, ValueError):
            return "unknown"
    if isinstance(value, str) and len(value) >= 10:
        return value[:10]
    return "unknown"


def _truncate(text: str, limit: int) -> str:
    """Char-bounded truncation with a one-char ellipsis; the result is never longer than ``limit``."""
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _one_line(text: str) -> str:
    return " ".join(text.split())


class CortadelMemory:
    """Cortadel memory for one user, exposed as Claude Agent SDK tools and hooks.

    Typical use is one line of wiring::

        memory = CortadelMemory("http://localhost:3001", "e2e-alice")
        options = memory.apply(ClaudeAgentOptions(model="claude-sonnet-4-5"))

    :meth:`apply` merges the MCP server, the allowed-tool names and both hooks into an existing
    :class:`~claude_agent_sdk.ClaudeAgentOptions` (it never mutates the one you pass — it returns
    a copy). :attr:`mcp_server`, :attr:`allowed_tools` and :meth:`hooks` are public if you would
    rather wire them yourself.

    Args:
        base_url: Cortadel server, e.g. ``"http://localhost:3001"`` or ``"https://app.cortadel.ai"``.
        user_id: The namespace anchor. Every memory read or written by this object belongs to it.
        api_key: Bearer token. Omit when the server runs with auth disabled.
        app_name: Recorded for access logging on searches, and set as the creating app on memories
            written by the ``add_memories`` tool.
        server_name: MCP server key; sets the ``mcp__<server_name>__*`` tool-name prefix.
        project: Project scope for captured conversations. Defaults to the basename of the
            session's ``cwd``, which is what you usually want for a coding agent.
        tags: Tags applied to every fact extracted from a captured conversation.
        top_k: Memories fetched per recall. Also the default for the ``search_memory`` tool when
            the model does not pass its own ``top_k``.
        rerank: Pass ``"cross_encoder"`` to rerank recall hits. Left off by default — CPU
            reranking is far too slow to sit in front of a prompt.
        scope_recall_to_session: When ``True``, automatic recall only returns memories from the
            current SDK session (the hook's ``session_id``). Off by default: recalling across
            sessions is the entire point of long-term memory. Has no effect on the
            ``search_memory`` tool, whose handler is given tool arguments and no session id.
        min_prompt_chars: Prompts shorter than this skip recall entirely.
        max_context_chars: Ceiling on the injected memory block.
        capture_max_chars: Ceiling on the conversation text sent to ``add_conversation``.
        recall_timeout: Seconds the ``UserPromptSubmit`` hook may spend before giving up.
        capture_timeout: Seconds the ``Stop`` hook may spend before giving up.
        await_persist: Whether the ``Stop`` hook waits for ``add_conversation`` to land before
            returning. **Defaults to ``True``**, against the usual fire-and-forget default,
            because ``Stop`` fires at session end: hand the write to a background task and the
            event loop the agent was running on can be torn down before it completes, silently
            losing the turn. Set it to ``False`` only when you keep the loop alive yourself, and
            call :meth:`aclose` to drain what is still in flight.
        dedupe_injections: When true, a memory already injected in this session is not injected
            again, so a long session does not keep re-spending context on the same facts.
        is_agent_memory: Pass ``True`` to extract facts about the *assistant* rather than the user.
        raise_on_error: When ``False`` (the default) a memory failure inside a hook is swallowed
            and the turn proceeds — a Cortadel outage must never take the agent down. Set it to
            ``True`` to have the hook re-raise instead, which is what you want in tests and CI.
            It does not change tool behaviour: a tool failure is always reported to the model as
            an ``is_error`` result, which surfaces it rather than swallowing it. It also cannot
            apply to a background write (``await_persist=False``) — there is no caller left to
            raise into, so those failures only reach ``on_error``/the log.
        on_error: Called with the exception on every memory failure, whichever path it came from.
            Use it for metrics or your own logging. When it is ``None`` and the failure is
            swallowed, a warning goes to the ``cortadel_claude_agent_sdk`` logger instead. A
            callback that itself raises is caught and logged — it can never break a turn.
    """

    def __init__(
        self,
        base_url: str,
        user_id: str,
        *,
        api_key: str | None = None,
        app_name: str = DEFAULT_APP_NAME,
        server_name: str = DEFAULT_SERVER_NAME,
        project: str | None = None,
        tags: Sequence[str] = ("claude-agent-sdk",),
        top_k: int = 5,
        rerank: str | None = None,
        scope_recall_to_session: bool = False,
        min_prompt_chars: int = 10,
        max_context_chars: int = 4000,
        capture_max_chars: int = 16000,
        recall_timeout: float = 10.0,
        capture_timeout: float = 60.0,
        await_persist: bool = True,
        dedupe_injections: bool = True,
        is_agent_memory: bool = False,
        raise_on_error: bool = False,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        # Built eagerly and not lazily: CortadelClient validates base_url/user_id in its
        # constructor and raises ValueError. Because every hook below fails open, deferring that
        # validation would turn a typo'd URL into memory that silently never works.
        client = CortadelClient(base_url, user_id, api_key=api_key, app_name=app_name)
        self._init(
            client=client,
            owns_client=True,
            app_name=app_name,
            server_name=server_name,
            project=project,
            tags=tags,
            top_k=top_k,
            rerank=rerank,
            scope_recall_to_session=scope_recall_to_session,
            min_prompt_chars=min_prompt_chars,
            max_context_chars=max_context_chars,
            capture_max_chars=capture_max_chars,
            recall_timeout=recall_timeout,
            capture_timeout=capture_timeout,
            await_persist=await_persist,
            dedupe_injections=dedupe_injections,
            is_agent_memory=is_agent_memory,
            raise_on_error=raise_on_error,
            on_error=on_error,
        )

    @classmethod
    def from_client(cls, client: CortadelLike, **options: Any) -> CortadelMemory:
        """Build on a Cortadel client you already own.

        Use this to share one client with the rest of your application, to wrap it, or to inject a
        fake in tests. ``options`` accepts every keyword argument of ``__init__`` except
        ``base_url``/``user_id``/``api_key``, which belong to the client you are supplying.
        :meth:`aclose` will **not** close a client passed in here — you own its lifecycle, matching
        the Cortadel SDK's own convention for a caller-supplied ``http_client``.
        """
        memory = cls.__new__(cls)
        memory._init(client=client, owns_client=False, **options)
        return memory

    @classmethod
    def from_env(cls, **options: Any) -> CortadelMemory:
        """Build from the same environment variables the ``cortadel-memory`` plugin reads.

        ``CORTADEL_URL`` and ``CORTADEL_USER_ID`` are required; ``CORTADEL_API_KEY`` and
        ``CORTADEL_CLIENT_NAME`` (which becomes ``app_name``) are optional. Explicit keyword
        arguments win over the environment.
        """
        base_url = os.environ.get("CORTADEL_URL", "").strip()
        user_id = os.environ.get("CORTADEL_USER_ID", "").strip()
        missing = [
            name
            for name, value in (("CORTADEL_URL", base_url), ("CORTADEL_USER_ID", user_id))
            if not value
        ]
        if missing:
            raise ValueError(
                "CortadelMemory.from_env() needs " + " and ".join(missing) + " to be set."
            )
        client_name = os.environ.get("CORTADEL_CLIENT_NAME", "").strip()
        defaults: dict[str, Any] = {"api_key": os.environ.get("CORTADEL_API_KEY") or None}
        if client_name:
            defaults["app_name"] = client_name
        defaults.update(options)
        return cls(base_url, user_id, **defaults)

    def _init(
        self,
        *,
        client: CortadelLike,
        owns_client: bool,
        app_name: str = DEFAULT_APP_NAME,
        server_name: str = DEFAULT_SERVER_NAME,
        project: str | None = None,
        tags: Sequence[str] = ("claude-agent-sdk",),
        top_k: int = 5,
        rerank: str | None = None,
        scope_recall_to_session: bool = False,
        min_prompt_chars: int = 10,
        max_context_chars: int = 4000,
        capture_max_chars: int = 16000,
        recall_timeout: float = 10.0,
        capture_timeout: float = 60.0,
        await_persist: bool = True,
        dedupe_injections: bool = True,
        is_agent_memory: bool = False,
        raise_on_error: bool = False,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        self._client = client
        self._owns_client = owns_client
        self._app_name = app_name
        self._server_name = server_name
        self._project = project
        self._tags = list(tags)
        self._top_k = top_k
        self._rerank = rerank
        self._scope_recall_to_session = scope_recall_to_session
        self._min_prompt_chars = min_prompt_chars
        self._max_context_chars = max_context_chars
        self._capture_max_chars = capture_max_chars
        self._recall_timeout = recall_timeout
        self._capture_timeout = capture_timeout
        self._await_persist = await_persist
        self._dedupe_injections = dedupe_injections
        self._is_agent_memory = is_agent_memory
        self._raise_on_error = raise_on_error
        self._on_error = on_error
        self._seen: OrderedDict[str, OrderedDict[str, None]] = OrderedDict()
        self._server: McpSdkServerConfig | None = None
        # Strong references to in-flight fire-and-forget writes. asyncio only holds a weak
        # reference to a running task, so without this set a background write can be garbage
        # collected mid-flight.
        self._pending: set[asyncio.Task[None]] = set()

    # ── Wiring ──────────────────────────────────────────────────────────────────────────────

    @property
    def client(self) -> CortadelLike:
        """The underlying Cortadel client, for anything this package does not wrap."""
        return self._client

    @property
    def server_name(self) -> str:
        return self._server_name

    @property
    def mcp_server(self) -> McpSdkServerConfig:
        """The in-process MCP server carrying the memory tools. Built once, then cached."""
        if self._server is None:
            self._server = self._build_server()
        return self._server

    @property
    def allowed_tools(self) -> list[str]:
        """Fully qualified tool names to pre-approve, e.g. ``["mcp__cortadel__search_memory", …]``."""
        return [
            f"mcp__{self._server_name}__search_memory",
            f"mcp__{self._server_name}__add_memories",
        ]

    def hooks(self) -> dict[HookEvent, list[HookMatcher]]:
        """The automatic-memory hooks, shaped for ``ClaudeAgentOptions.hooks``.

        ``matcher`` is left ``None`` on both: it filters by *tool name*, which is meaningless for
        ``UserPromptSubmit``/``Stop``. Each matcher's ``timeout`` is set a little above our own
        budget so the CLI-side timeout never pre-empts our own graceful give-up.
        """
        return {
            "UserPromptSubmit": [
                HookMatcher(
                    hooks=[self.on_user_prompt_submit],
                    timeout=self._recall_timeout + _HOOK_TIMEOUT_MARGIN,
                )
            ],
            "Stop": [
                HookMatcher(
                    hooks=[self.on_stop],
                    timeout=self._capture_timeout + _HOOK_TIMEOUT_MARGIN,
                )
            ],
        }

    def apply(
        self,
        options: ClaudeAgentOptions | None = None,
        *,
        tools: bool = True,
        auto_memory: bool = True,
    ) -> ClaudeAgentOptions:
        """Return a copy of ``options`` with Cortadel wired in.

        Merges rather than overwrites: your own MCP servers, allowed tools and hooks are all kept.
        Pass ``tools=False`` for hooks-only (memory the agent never has to think about) or
        ``auto_memory=False`` for tools-only (the agent decides when to remember).
        """
        base = options if options is not None else ClaudeAgentOptions()
        changes: dict[str, Any] = {}

        if tools:
            existing_servers = base.mcp_servers
            if not isinstance(existing_servers, dict):
                raise ValueError(
                    "CortadelMemory.apply() cannot merge into ClaudeAgentOptions.mcp_servers when it "
                    f"is a config-file path ({existing_servers!r}). Pass a dict of servers, or wire "
                    "`memory.mcp_server` in yourself."
                )
            changes["mcp_servers"] = {**existing_servers, self._server_name: self.mcp_server}
            allowed = list(base.allowed_tools)
            allowed.extend(name for name in self.allowed_tools if name not in allowed)
            changes["allowed_tools"] = allowed

        if auto_memory:
            merged: dict[Any, list[HookMatcher]] = {
                event: list(matchers) for event, matchers in (base.hooks or {}).items()
            }
            for event, matchers in self.hooks().items():
                merged.setdefault(event, []).extend(matchers)
            changes["hooks"] = merged

        return replace(base, **changes)

    async def aclose(self) -> None:
        """Drain any fire-and-forget writes, then close the client if this object created it.

        The drain is what makes ``await_persist=False`` safe to use: it is the one point where a
        background ``add_conversation`` is guaranteed to have finished. A client passed to
        :meth:`from_client` is left open — you own its lifecycle.
        """
        if self._pending:
            await asyncio.gather(*tuple(self._pending), return_exceptions=True)
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> CortadelMemory:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.aclose()

    # ── Tools ───────────────────────────────────────────────────────────────────────────────

    def _build_server(self) -> McpSdkServerConfig:
        @tool(
            "search_memory",
            "Search this user's long-term Cortadel memory for facts relevant to a question. "
            "Use it whenever the answer might depend on something established earlier, in this "
            "session or a previous one.",
            _SEARCH_TOOL_SCHEMA,
            annotations=ToolAnnotations(readOnlyHint=True),
        )
        async def search_memory(args: dict[str, Any]) -> dict[str, Any]:
            return await self._tool_search(args)

        @tool(
            "add_memories",
            "Store a durable fact about this user in Cortadel so it is available in future "
            "sessions. Store preferences, decisions and stable context — not transient chatter.",
            _ADD_TOOL_SCHEMA,
        )
        async def add_memories(args: dict[str, Any]) -> dict[str, Any]:
            return await self._tool_add(args)

        return create_sdk_mcp_server(
            name=self._server_name,
            version="0.1.0",
            tools=[search_memory, add_memories],
        )

    async def _tool_search(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args.get("query") or "").strip()
        if not query:
            return _tool_error("search_memory needs a non-empty 'query'.")
        top_k = args.get("top_k")
        try:
            results = await self._search(query, top_k if isinstance(top_k, int) else self._top_k)
        except Exception as exc:  # noqa: BLE001 - the model reads this, the agent loop continues
            self._notify(exc)
            return _tool_error(f"Cortadel search failed: {_describe(exc)}")

        hits = list(results.results or [])
        if not hits:
            return _tool_text(f"No memories found for {query!r}.")
        return _tool_text(self._format_hits(hits, budget=self._max_context_chars))

    async def _tool_add(self, args: dict[str, Any]) -> dict[str, Any]:
        text = str(args.get("text") or "").strip()
        if not text:
            return _tool_error("add_memories needs non-empty 'text'.")
        memory_type = args.get("memory_type")
        options = AddOptions(
            app=self._app_name,
            memory_type=memory_type if isinstance(memory_type, str) else None,
        )
        try:
            created = await self._client.add(text, options)
        except Exception as exc:  # noqa: BLE001
            self._notify(exc)
            return _tool_error(f"Cortadel write failed: {_describe(exc)}")

        # A 2xx does not mean a new memory was written — `event` says what the store pipeline
        # actually did (ADD, SKIP_DUPLICATE, SUPERSEDE, …), and the model should see that.
        event = created.event or "ADD"
        return _tool_text(f"Stored memory {created.id} (event: {event}).")

    # ── Hooks ───────────────────────────────────────────────────────────────────────────────

    async def on_user_prompt_submit(
        self,
        input_data: HookInput,
        tool_use_id: str | None,
        context: HookContext,
    ) -> HookJSONOutput:
        """``UserPromptSubmit`` hook: recall relevant memories and inject them into the turn.

        Returns ``{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
        "additionalContext": …}}``. ``additionalContext`` **must** be nested under
        ``hookSpecificOutput`` — a top-level key is silently ignored.

        Fails open: a recall failure yields ``{}`` and the prompt goes through untouched, unless
        ``raise_on_error=True``.
        """
        try:
            prompt = str(input_data.get("prompt") or "")
            stripped = prompt.strip()
            if len(stripped) < self._min_prompt_chars:
                return {}
            if stripped.startswith("/") or stripped.startswith("!"):
                return {}  # slash commands and shell passthrough are not memory-worthy queries

            session_id = str(input_data.get("session_id") or "")
            with fail_after(self._recall_timeout):
                results = await self._search(
                    stripped[:4000],
                    self._top_k,
                    session_id=session_id if self._scope_recall_to_session else None,
                )

            hits = [hit for hit in (results.results or []) if not self._already_injected(session_id, hit.id)]
            if not hits:
                return {}

            block = self._format_hits(hits, budget=self._max_context_chars)
            self._mark_injected(session_id, (hit.id for hit in hits))
            return {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": f"## Relevant Cortadel memories\n{block}",
                },
                "suppressOutput": True,
            }
        except Exception as exc:  # noqa: BLE001 - memory degrades; it never blocks a prompt
            self._fail(exc, "recall")
            return {}

    async def on_stop(
        self,
        input_data: HookInput,
        tool_use_id: str | None,
        context: HookContext,
    ) -> HookJSONOutput:
        """``Stop`` hook: persist the finished turn through ``add_conversation``.

        Cortadel distils durable facts from the exchange server-side, so the whole turn is handed
        over rather than something pre-summarised here. Returns an empty result in every case —
        this hook exists for its side effect and must never block session end.

        The write is awaited by default (``await_persist=True``); see the class docstring for why
        fire-and-forget is not the default at ``Stop``.
        """
        try:
            # Recursion guard: we are only here because a Stop hook already ran.
            if input_data.get("stop_hook_active"):
                return {}

            session_id = str(input_data.get("session_id") or "")
            cwd = input_data.get("cwd")
            transcript_path = input_data.get("transcript_path")

            exchange = await to_thread.run_sync(
                lambda: last_exchange(
                    session_id=session_id,
                    cwd=str(cwd) if cwd else None,
                    transcript_path=str(transcript_path) if transcript_path else None,
                )
            )
            if exchange is None:
                return {}

            messages = self._to_chat_messages(exchange)
            if messages is None:
                return {}

            options = ConversationOptions(
                is_agent_memory=self._is_agent_memory,
                tags=list(self._tags) or None,
                project=self._project or (PurePath(str(cwd)).name if cwd else None),
                session_id=session_id or None,
                transcript_path=str(transcript_path) if transcript_path else None,
            )
            if self._await_persist:
                await self._persist(messages, options)
            else:
                self._spawn(self._persist(messages, options))
        except Exception as exc:  # noqa: BLE001 - a failed capture must not break session end
            self._fail(exc, "capture")
            return {}
        return {}

    # ── Internals ───────────────────────────────────────────────────────────────────────────

    async def _search(
        self, query: str, top_k: int, *, session_id: str | None = None
    ) -> SearchResults:
        return await self._client.search(
            query,
            SearchOptions(
                top_k=max(1, min(50, top_k)),
                mode="hybrid",
                rerank=self._rerank,
                session_id=session_id or None,
            ),
        )

    async def _persist(
        self, messages: list[ChatMessage], options: ConversationOptions
    ) -> None:
        with fail_after(self._capture_timeout):
            await self._client.add_conversation(messages, options)

    def _spawn(self, coro: Awaitable[None]) -> None:
        """Run a write in the background, holding a strong reference until it settles."""
        task = asyncio.ensure_future(coro)
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)
        task.add_done_callback(self._background_settled)

    def _background_settled(self, task: asyncio.Task[None]) -> None:
        """Route a background write's failure. It can only be observed, never re-raised: the hook
        that started it returned long ago, so ``raise_on_error`` has nowhere to raise into."""
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            self._report(exc, "background capture")

    def _fail(self, exc: BaseException, what: str) -> None:
        """Route a hook failure: observe it, then swallow or re-raise per ``raise_on_error``."""
        if not self._raise_on_error:
            self._report(exc, what)
            return
        self._notify(exc)
        raise exc

    def _notify(self, exc: BaseException) -> None:
        """Hand the exception to ``on_error``, if there is one. Never raises."""
        if self._on_error is None:
            return
        try:
            self._on_error(exc)
        except Exception:  # noqa: BLE001 - an observer must not break what it observes
            _LOGGER.warning("Cortadel on_error callback raised.", exc_info=True)

    def _report(self, exc: BaseException, what: str) -> None:
        """A swallowed failure: the callback sees it, or the logger does."""
        if self._on_error is not None:
            self._notify(exc)
        else:
            _LOGGER.warning("Cortadel %s failed: %s", what, _describe(exc))

    def _to_chat_messages(self, exchange: Exchange) -> list[ChatMessage] | None:
        """The exchange as Cortadel chat messages, or ``None`` if it is too thin to be worth storing."""
        user_budget = min(4000, self._capture_max_chars)
        user_text = _truncate(exchange.user.text, user_budget)
        assistant_text = _truncate(exchange.assistant.text, max(0, self._capture_max_chars - user_budget))
        if not user_text or not assistant_text or len(user_text) + len(assistant_text) < 80:
            return None  # tool-only or one-word exchanges yield no durable facts
        return [
            ChatMessage(role="user", content=user_text, uuid=exchange.user.uuid),
            ChatMessage(role="assistant", content=assistant_text, uuid=exchange.assistant.uuid),
        ]

    def _format_hits(self, hits: Sequence[Any], *, budget: int) -> str:
        """One markdown bullet per hit, in relevance order, stopping at ``budget`` characters."""
        lines: list[str] = []
        used = 0
        for hit in hits:
            content = _truncate(_one_line(hit.content or ""), _MAX_HIT_CHARS)
            if not content:
                continue
            score = getattr(hit, "rrf_score", None)
            score_part = f", score {score:.2f}" if isinstance(score, (int, float)) else ""
            line = f"- ({_iso_date(getattr(hit, 'created_at', None))}{score_part}) [id {hit.id}] {content}"
            if used + len(line) + 1 > budget:
                break
            lines.append(line)
            used += len(line) + 1
        return "\n".join(lines)

    def _already_injected(self, session_id: str, memory_id: str) -> bool:
        if not self._dedupe_injections:
            return False
        seen = self._seen.get(session_id)
        return seen is not None and memory_id in seen

    def _mark_injected(self, session_id: str, memory_ids: Iterable[str]) -> None:
        """Record what this session has already been shown, under a bounded budget.

        Both the session table and each session's id set are capped and evict oldest-first, so a
        long-lived process cannot grow this without limit.
        """
        if not self._dedupe_injections:
            return
        seen = self._seen.get(session_id)
        if seen is None:
            seen = OrderedDict()
            self._seen[session_id] = seen
        self._seen.move_to_end(session_id)
        for memory_id in memory_ids:
            seen.pop(memory_id, None)
            seen[memory_id] = None
        while len(seen) > _MAX_SEEN_PER_SESSION:
            seen.popitem(last=False)
        while len(self._seen) > _MAX_TRACKED_SESSIONS:
            self._seen.popitem(last=False)


def _tool_text(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _tool_error(text: str) -> dict[str, Any]:
    # `is_error` (snake_case) is what the Python SDK reads off a handler result — see
    # `create_sdk_mcp_server`'s call handler: `isError=result.get("is_error", False)`.
    return {"content": [{"type": "text", "text": text}], "is_error": True}


def _describe(exc: BaseException) -> str:
    """A message the model can act on. ``CortadelError`` carries a status and a machine code."""
    if isinstance(exc, CortadelError):
        return f"{exc.code} (HTTP {exc.status}): {exc.message}"
    if isinstance(exc, TimeoutError):
        return "the request timed out"
    return f"{type(exc).__name__}: {exc}"
