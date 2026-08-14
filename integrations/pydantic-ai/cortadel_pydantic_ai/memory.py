"""`CortadelMemory` — Cortadel long-term memory as a pydantic-ai capability.

Capabilities are pydantic-ai's primary extension point: one object, passed as
`Agent(..., capabilities=[...])`, that can contribute tools, instructions, model settings and
lifecycle hooks at once. That makes it the right seam for memory, which needs all of those:

| What                                   | Hook                                    |
| -------------------------------------- | --------------------------------------- |
| `search_memory` / `add_memories` tools  | `get_toolset()`                         |
| Recall relevant memories before the LLM | `get_instructions()`                    |
| Persist the turn after it finishes      | `after_run()`                           |
| Isolate per-run state                   | `for_run()`                             |

Two design points worth knowing:

**Recall runs once per run, not once per model request.** `get_instructions()` returns a bound
method, and `for_run()` hands each run its own copy of the capability to cache the result on. The
agent loop re-resolves instructions on every step (each tool round-trip), so without that cache a
five-step run would hit Cortadel five times with the same query.

**Injected memories never become conversation parts.** They ride in the instructions, which
pydantic-ai rebuilds for each request from the current run's instruction parts
(`Model._get_instruction_parts` prefers `model_request_parameters.instruction_parts`; the
`ModelRequest.instructions` recorded in history is only a fallback for direct `model.request()`
callers). So feeding `result.all_messages()` back as `message_history=` sends exactly one memory
block — the freshly recalled one — instead of accumulating a copy per turn. Note that the rendered
string *is* still recorded on each historical `ModelRequest.instructions`, so it shows up in a
serialized transcript even though it is not re-sent.
"""

from __future__ import annotations

import copy
from dataclasses import KW_ONLY, dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

from pydantic_ai.capabilities import AbstractCapability

# Runtime imports: `RunContext` must be resolvable from this module's globals for pydantic-ai to
# detect that `_recall_instructions` takes a run context. See the note in `_backend.py`.
from pydantic_ai.tools import AgentDepsT, RunContext

from ._backend import (
    DEFAULT_APP_NAME,
    DEFAULT_BASE_URL,
    DEFAULT_RECALL_TOP_K,
    DEFAULT_TIMEOUT,
    ENV_API_KEY,
    ENV_BASE_URL,
    ENV_USER_ID,
    Backend,
    ClientFactory,
    UserId,
    resolve_setting,
)
from ._format import (
    DEFAULT_INSTRUCTIONS_HEADER,
    chat_messages_from,
    format_memories,
    query_from_context,
)
from .toolset import TOOLSET_ID, build_toolset

if TYPE_CHECKING:
    from collections.abc import Sequence

    from pydantic_ai._instructions import AgentInstructions
    from pydantic_ai.run import AgentRunResult
    from pydantic_ai.toolsets import AgentToolset

__all__ = ["CortadelMemory"]

SessionId = Union[str, Callable[[RunContext[Any]], Optional[str]]]


@dataclass
class CortadelMemory(AbstractCapability[AgentDepsT]):
    """Give a pydantic-ai agent long-term memory backed by Cortadel.

        agent = Agent(
            "openai:gpt-5",
            capabilities=[CortadelMemory(base_url="http://localhost:3001", user_id="e2e-alice")],
        )

    Every Cortadel call degrades gracefully: if the server is unreachable, recall injects
    nothing, persistence is skipped, the tools tell the model memory is unavailable, and the run
    continues. Failures go to `on_error` if given, otherwise to the `cortadel_pydantic_ai`
    logger. Set `raise_on_error=True` to make them fail the run instead.

    **Constructor contract.** `base_url` and `user_id` — and only those two — may be passed
    positionally, in that order; every other option is keyword-only. That mirrors
    `cortadel.CortadelClient(base_url, user_id, *, ...)`, the SDK constructor this wraps, and the
    sibling Cortadel integrations that lead with the same pair. It is also what keeps the option
    list safe to extend: an option added anywhere below can never silently claim a positional
    slot that used to mean something else. `tests/test_constructor_contract.py` pins it.
    """

    base_url: Optional[str] = None
    """Cortadel server URL. Defaults to `$CORTADEL_BASE_URL`, then `http://localhost:3001`."""

    user_id: Optional[UserId] = None
    """Who the memories belong to.

    Either a fixed string, or a callable `(ctx) -> str` that derives the id from the run —
    normally `lambda ctx: ctx.deps.user_id`. A Cortadel client is bound to one user at
    construction, so the callable form transparently keeps one cached client per user id.
    Defaults to `$CORTADEL_USER_ID`.
    """

    # Everything below is keyword-only. This is a load-bearing marker, not tidiness: these are
    # *options*, and the option list grows. Without it, inserting a field here shifts every
    # positional slot after it, so an existing positional call keeps working while binding its
    # arguments to different fields — a silent behaviour change with no error to notice. The two
    # identity fields above are excluded deliberately, so `CortadelMemory(url, user)` still reads
    # the way `CortadelClient(url, user)` does. (`AbstractCapability` uses the same marker for
    # `id`/`description`/`defer_loading`, which are therefore already keyword-only here.)
    _: KW_ONLY

    api_key: Optional[str] = None
    """Bearer token. Defaults to `$CORTADEL_API_KEY`. Omit when the server has auth disabled."""

    app_name: str = DEFAULT_APP_NAME
    """Identifies this integration to Cortadel for access logging, and labels stored memories."""

    timeout: float = DEFAULT_TIMEOUT
    """Per-client HTTP timeout, in seconds."""

    tools: bool = True
    """Expose the `search_memory` and `add_memories` tools to the model."""

    recall: bool = True
    """Search Cortadel before each run and inject the hits as instructions."""

    persist: bool = True
    """Send the finished turn to Cortadel with `add_conversation` after each run."""

    await_persist: bool = True
    """Wait for that write to land before the run returns.

    On by default, unlike most Cortadel integrations. `after_run()` is the last hook in a
    pydantic-ai run and the framework owns no background task pool, so a fire-and-forget write
    outlives nothing: the very common `asyncio.run(main())` script cancels every pending task the
    moment `main()` returns, silently dropping the turn. Set this to `False` to take the write off
    the critical path — then call `aclose()` before shutdown, which drains what is still in
    flight. A backgrounded write still reaches `on_error`, but it has no caller left to raise
    into, so `raise_on_error` does not apply to it.
    """

    top_k: int = DEFAULT_RECALL_TOP_K
    """Maximum memories to recall per run (1-50), and the default `top_k` the `search_memory`
    tool offers the model."""

    search_mode: str = "hybrid"
    """`hybrid` (BM25 + vector, the default), `text`, or `vector`."""

    rerank: bool = False
    """Rerank hits with the server's cross-encoder. More accurate, slower."""

    memory_type: Optional[str] = None
    """Restrict recall to one cognitive type: `episodic`, `semantic`, or `procedural`."""

    scope_recall_to_session: bool = False
    """Restrict recall to the current session.

    Off by default, and that default matters: scoping the search to a session would hide
    everything learned in previous conversations, which is the whole point of long-term memory.
    """

    instructions_header: str = DEFAULT_INSTRUCTIONS_HEADER
    """Preamble placed above the recalled memories in the prompt."""

    session_id: Optional[SessionId] = None
    """Groups stored facts into a session.

    Defaults to `ctx.conversation_id`, which pydantic-ai keeps stable across the runs that share
    a message history — the same span Cortadel means by a session.
    """

    project: Optional[str] = None
    """Project scope recorded on stored facts (e.g. a repo name)."""

    tags: Optional["Sequence[str]"] = None
    """Tags applied to every stored fact, for scoped retrieval later."""

    client_factory: Optional[ClientFactory] = None
    """Builds a client for a user id. Override to inject a stand-in in tests."""

    on_error: Optional[Callable[[Exception], None]] = None
    """Called with every Cortadel failure. Defaults to a warning on the package logger.

    An observer, not a policy: it fires whether or not `raise_on_error` is set, and its own
    exceptions are logged rather than propagated.
    """

    raise_on_error: bool = False
    """Let Cortadel failures propagate into the agent run instead of degrading.

    Off by default — a memory outage must never take the agent down. Turn it on when a missing
    memory is a correctness bug you would rather see fail loudly than answer without.
    """

    toolset_id: str = TOOLSET_ID
    """Id of the contributed toolset."""

    _backend: Backend = field(init=False, repr=False, compare=False)
    _toolset: Any = field(init=False, repr=False, compare=False, default=None)
    _recalled: Optional[str] = field(init=False, repr=False, compare=False, default=None)
    _recall_done: bool = field(init=False, repr=False, compare=False, default=False)

    def __post_init__(self) -> None:
        user_id = self.user_id
        if user_id is None:
            user_id = resolve_setting(None, ENV_USER_ID, None)
        if user_id is None or (isinstance(user_id, str) and not user_id.strip()):
            raise ValueError(
                'CortadelMemory needs a `user_id`: pass user_id="<your-user-id>", pass a callable '
                f"`lambda ctx: ctx.deps.user_id` to derive it per run, or set ${ENV_USER_ID}."
            )
        self._backend = Backend(
            base_url=resolve_setting(self.base_url, ENV_BASE_URL, DEFAULT_BASE_URL) or DEFAULT_BASE_URL,
            user_id=user_id,
            api_key=resolve_setting(self.api_key, ENV_API_KEY, None),
            app_name=self.app_name,
            timeout=self.timeout,
            client_factory=self.client_factory,
            on_error=self.on_error,
            raise_on_error=self.raise_on_error,
        )
        self._toolset = (
            build_toolset(
                self._backend,
                top_k=self.top_k,
                search_mode=self.search_mode,
                rerank=self.rerank,
                memory_type=self.memory_type,
                id=self.toolset_id,
            )
            if self.tools
            else None
        )

    # --- lifecycle ----------------------------------------------------------------

    async def for_run(self, ctx: RunContext[AgentDepsT]) -> CortadelMemory[AgentDepsT]:
        """Hand this run its own copy, so the recall cache is not shared between runs.

        The copy is shallow on purpose: `_backend` (and with it the per-user client cache and
        its HTTP connection pool) stays shared, while the per-run recall cache is reset.
        """
        fresh = copy.copy(self)
        fresh._recalled = None
        fresh._recall_done = False
        return fresh

    def get_description(self) -> Any:
        return self.description or "Long-term memory of this user, stored in Cortadel."

    # --- (A) tools ----------------------------------------------------------------

    def get_toolset(self) -> Optional[AgentToolset[AgentDepsT]]:
        return self._toolset

    # --- (B1) recall before the model call -----------------------------------------

    def get_instructions(self) -> Optional[AgentInstructions[AgentDepsT]]:
        if not self.recall:
            return None
        return self._recall_instructions

    async def _recall_instructions(self, ctx: RunContext[Any]) -> Optional[str]:
        """Search Cortadel once per run and render the hits as an instructions block.

        Returning `None` — no query, no hits, or the server being down — makes pydantic-ai skip
        this instruction entirely, so nothing is added to the prompt.
        """
        if self._recall_done:
            return self._recalled
        query = query_from_context(ctx)
        if not query:
            self._recall_done = True
            return None
        hits = await self._backend.try_search(
            ctx,
            query,
            top_k=self.top_k,
            mode=self.search_mode,
            rerank=self.rerank,
            memory_type=self.memory_type,
            session_id=self._resolve_session_id(ctx) if self.scope_recall_to_session else None,
        )
        self._recalled = format_memories(hits, self.instructions_header) if hits else None
        self._recall_done = True
        return self._recalled

    # --- (B2) persist after the turn ------------------------------------------------

    async def after_run(
        self,
        ctx: RunContext[AgentDepsT],
        *,
        result: AgentRunResult[Any],
    ) -> AgentRunResult[Any]:
        """Store this run's turn in Cortadel. Always returns `result` unchanged."""
        if not self.persist:
            return result
        try:
            # `new_messages()`, not `all_messages()`: only what this run added. With
            # `all_messages()` a multi-turn conversation would re-send its whole history on
            # every turn, and Cortadel would spend the dedup pipeline rejecting it.
            messages = chat_messages_from(result.new_messages())
        # Persistence must never fail the run.
        except Exception as exc:  # noqa: BLE001
            self._backend.report(exc)
            return result
        if not messages:
            return result
        write = self._backend.try_add_conversation(
            ctx,
            messages,
            session_id=self._resolve_session_id(ctx),
            project=self.project,
            tags=self.tags,
        )
        if self.await_persist:
            await write
        else:
            # Off the critical path. `aclose()` drains whatever is still in flight — without it
            # a process that exits right after the run would cancel the write mid-flight.
            self._backend.spawn(write)
        return result

    # --- helpers --------------------------------------------------------------------

    def _resolve_session_id(self, ctx: RunContext[Any]) -> Optional[str]:
        session_id = self.session_id
        if callable(session_id):
            try:
                session_id = session_id(ctx)
            except Exception as exc:  # noqa: BLE001
                self._backend.report(exc)
                return None
        if session_id:
            return str(session_id)
        return getattr(ctx, "conversation_id", None)

    async def aclose(self) -> None:
        """Drain in-flight background writes, then close every pooled Cortadel client.

        Call it on application shutdown to release HTTP connections deterministically. With
        `await_persist=False` it is not optional: it is what guarantees a backgrounded write
        finished before the loop goes away. Clients are pooled per user id and shared across
        runs, so there is no per-run teardown.
        """
        await self._backend.aclose()

    @classmethod
    def get_serialization_name(cls) -> Optional[str]:
        # Not loadable from a YAML/JSON agent spec: `user_id`, `client_factory` and `on_error`
        # can all be callables, which a spec file cannot express.
        return None
