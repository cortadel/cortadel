"""The async facade. Owns auth, base URL, user_id scoping, error translation, and (via
``cortadel.mapping``) mapping generated results into this package's own DTOs. Reproduces the
behavior of ``sdk/dotnet/Cortadel.Sdk/CortadelClient.cs`` / ``sdk/typescript/src/client.ts``
idiomatically, not their syntax — see the task report for a point-by-point mapping of the
hard-won .NET/TypeScript behaviors onto their Python equivalents.

Internally this is a facade over a Kiota-generated transport (``cortadel._generated``); the
generated types never appear on this class's public surface (enforced by ``cortadel/__init__.py``
only re-exporting ``cortadel.models`` and its own encapsulation test).
"""
from __future__ import annotations

import importlib
import warnings
from collections.abc import Iterable
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from kiota_abstractions.api_error import APIError
from kiota_abstractions.authentication import AnonymousAuthenticationProvider, AuthenticationProvider
from kiota_abstractions.base_request_configuration import RequestConfiguration
from kiota_abstractions.request_information import RequestInformation
from kiota_http.httpx_request_adapter import HttpxRequestAdapter

from cortadel import mapping


def _warm_generated_tree() -> None:
    """Imports every module under ``cortadel._generated``, once, so this happens under a scoped
    ``DeprecationWarning`` suppression instead of surfacing to a caller later.

    Several of the generated request-builder modules (``health``, ``search``,
    ``from_conversation``, ``memories``, the by-id item builder — every operation this facade
    calls) define now-superseded ``*RequestConfiguration``/``*QueryParameters`` companion classes
    that call ``warnings.warn(..., DeprecationWarning)`` directly in their class body, so the
    warning fires the moment the *module* is imported, not when that particular class is used —
    this project never constructs or references those classes at all. ``kiota_abstractions``
    itself (the pip dependency, not anything generated) has the same pattern in several of its own
    internal modules, transitively imported by those same request builders. Passing
    ``--exclude-backward-compatible`` at generation time is meant to avoid the generated half of
    this, but as of kiota 1.34.1 it has **no effect on the Python generator** — generating this
    contract with and without the flag produces byte-identical output (confirmed and reported in
    this SDK's task report). Three of the five affected request-builder modules
    (``search``/``health``/``from_conversation``) are also only *lazily* imported by the generated
    client, inside a property getter — so without this warm-up, the warning would surface
    unpredictably on whichever caller happens to make the first `search()`/`health()`/
    `add_conversation()` call, rather than at a predictable, controllable point.

    Every one of these class bodies (ours and kiota_abstractions's) executes exactly once per
    process, the first time its module is imported (Python caches modules in ``sys.modules``), so
    running every import once here — under one suppression context, at this module's own import
    time — guarantees no `DeprecationWarning` from any of them ever reaches a caller of this
    package, without touching the warnings filters after this function returns.
    """
    import cortadel._generated as generated_pkg

    root = Path(next(iter(generated_pkg.__path__)))
    for path in sorted(root.rglob("*.py")):
        if path.name == "__init__.py":
            continue
        relative_parts = path.relative_to(root).with_suffix("").parts
        importlib.import_module(f"{generated_pkg.__name__}." + ".".join(relative_parts))


with warnings.catch_warnings():
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    _warm_generated_tree()

    from cortadel._generated.api.v1.memories.memories_request_builder import MemoriesRequestBuilder
    from cortadel._generated.api.v1.memories.item.with_memory_item_request_builder import (
        WithMemoryItemRequestBuilder,
    )
    from cortadel._generated.cortadel_api_client import CortadelApiClient
    from cortadel._generated.models.add_conversation_request import AddConversationRequest
    from cortadel._generated.models.conversation_message_item import ConversationMessageItem
    from cortadel._generated.models.create_memory_request import CreateMemoryRequest
    from cortadel._generated.models.create_memory_request_metadata import CreateMemoryRequest_metadata
    from cortadel._generated.models.delete_memories_request import DeleteMemoriesRequest
    from cortadel._generated.models.error_response import ErrorResponse
    from cortadel._generated.models.health_response import HealthResponse
    from cortadel._generated.models.search_memories_request import SearchMemoriesRequest
    from cortadel._generated.models.validation_problem_details import ValidationProblemDetails

from cortadel.models import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    CortadelError,
    DEFAULT_LIST_SIZE,
    HealthResult,
    ListOptions,
    MemoryCreated,
    MemoryDetail,
    MemoryList,
    SearchOptions,
    SearchResults,
)

DEFAULT_APP_NAME = "cortadel-python"
DEFAULT_TIMEOUT = 100.0
"""Request timeout in seconds. Defaults to 100s (generous for reranked search), matching the
.NET/TypeScript facades' own defaults. **No-op when you pass your own ``httpx.AsyncClient``** to
the constructor: the facade deliberately never mutates a caller-supplied client. Set the timeout
on your own client instead when you supply one."""
_DEFAULT_CONNECT_TIMEOUT = 30.0


class _BearerAuthenticationProvider(AuthenticationProvider):
    """Attaches ``Authorization: Bearer <key>`` per request.

    Kiota generates **no** authentication code for this contract's ``bearerAuth``/`apiKeyHeader``
    security schemes in any language (confirmed across the .NET, TypeScript, and this Python
    generation — see the task report). This hand-built provider stands in for it, attaching the
    header through the request adapter's authentication hook instead of on a shared HTTP client's
    default headers, so it can never leak onto a caller-supplied client's other requests.
    """

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def authenticate_request(
        self,
        request: RequestInformation,
        additional_authentication_context: Optional[dict] = None,
    ) -> None:
        request.headers.add("Authorization", f"Bearer {self._api_key}")


def _build_owned_http_client(timeout: float) -> httpx.AsyncClient:
    """A bare ``httpx.AsyncClient`` with no Kiota middleware attached.

    ``kiota_http.HttpxRequestAdapter`` only wraps a client in Kiota's default middleware chain
    (redirect / retry / user-agent / parameters-decoding / headers-inspection) when it is *not*
    given one — see ``HttpxRequestAdapter.__init__``: ``if not http_client: http_client =
    KiotaClientFactory.create_with_default_middleware()``. That default chain's ``RetryHandler``
    silently retries HTTP 429/503/504 up to 3 times, with a >=3-second floor on every retry delay
    (``kiota_http.middleware.options.RetryHandlerOption.DEFAULT_DELAY``). This server returns 503
    whenever embeddings are unconfigured — the normal self-hosted state — so an unmodified
    ``health()`` call would silently block for several seconds instead of returning immediately.

    Supplying our own client here sidesteps Kiota's default middleware pipeline entirely, the same
    way the .NET facade's bare ``HttpClient`` never enters Kiota's ``KiotaClientFactory`` pipeline
    either (see ``CortadelClient.cs``'s own comment on this).
    """
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=min(timeout, _DEFAULT_CONNECT_TIMEOUT)))


def _to_metadata_bag(metadata: Optional[dict]) -> Optional[CreateMemoryRequest_metadata]:
    if metadata is None:
        return None
    return CreateMemoryRequest_metadata(additional_data=dict(metadata))


def _flatten_field_error(value: object) -> str:
    if isinstance(value, list):
        return "; ".join("" if v is None else str(v) for v in value)
    return "" if value is None else str(value)


def _translate(e: APIError) -> CortadelError:
    """Translates a generated exception into a :class:`CortadelError` carrying real
    status/code/message. ``ValidationProblemDetails`` and ``ErrorResponse`` are both subclasses of
    ``APIError`` (every Kiota-generated error schema is, in every language), so this dispatches on
    the most specific type first rather than needing separate ``except`` clauses per schema."""
    if isinstance(e, ValidationProblemDetails):
        # A model-state 400 carries field-level errors in `errors` (an open ASP.NET Core
        # ModelState map with no declared properties — everything lands in `errors.additional_data`
        # since ValidationProblemDetails_errors is an AdditionalDataHolder). Fold them into the
        # message instead of discarding them, matching the .NET/TypeScript legs' own fix for this.
        base = e.detail or e.title or "Validation failed."
        fields = e.errors.additional_data if e.errors is not None else None
        if fields:
            parts = [f"{key}: {_flatten_field_error(value)}" for key, value in fields.items()]
            base = f"{base} ({', '.join(parts)})"
        return CortadelError(e.response_status_code or 0, "validation_error", base)
    if isinstance(e, ErrorResponse):
        return CortadelError(e.response_status_code or e.status or 0, e.code or "http_error", e.message or "The request failed.")
    return CortadelError(e.response_status_code or 0, "http_error", e.message or str(e) or "The request failed.")


class CortadelClient:
    """A thin, typed async client for the Cortadel REST API. Create one and reuse it (it wraps a
    single ``httpx.AsyncClient``). All calls are scoped to the ``user_id`` given at construction.
    """

    def __init__(
        self,
        base_url: str,
        user_id: str,
        *,
        api_key: Optional[str] = None,
        app_name: str = DEFAULT_APP_NAME,
        http_client: Optional[httpx.AsyncClient] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        """
        Args:
            base_url: Base URL of the Cortadel server, e.g. ``"http://localhost:3001"``.
            user_id: User identifier that owns the memories (the namespace anchor). Required by
                the REST API.
            api_key: Optional API key. Sent as ``Authorization: Bearer <key>``. Omit when the
                server runs with auth disabled.
            app_name: App name recorded for access logging on searches. Defaults to
                ``"cortadel-python"``.
            http_client: Reuse an existing ``httpx.AsyncClient`` instead of creating one. **Never
                mutated**: attaching the bearer token to a shared client's headers would leak the
                credential onto every unrelated request made through it, so auth is attached
                per-request by an authentication provider instead. This client also never closes
                a client you supply (see :meth:`aclose`) — you own its lifecycle.
            timeout: Request timeout in seconds. Defaults to :data:`DEFAULT_TIMEOUT` (100s). No-op
                when ``http_client`` is supplied — set the timeout on your own client instead.
        """
        if not base_url or not base_url.strip():
            raise ValueError("base_url is required.")
        parsed = urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f'base_url must be an absolute http(s) URL, got: "{base_url}"')
        if not user_id or not user_id.strip():
            raise ValueError("user_id is required.")

        self._user_id = user_id
        self._app_name = app_name.strip() or DEFAULT_APP_NAME

        # Never mutate a caller-supplied http_client — see the docstring above and
        # `_build_owned_http_client`'s note on why we only own (and only close) a client we built.
        self._owns_http = http_client is None
        http = http_client if http_client is not None else _build_owned_http_client(timeout)
        self._http = http

        auth_provider: AuthenticationProvider = (
            _BearerAuthenticationProvider(api_key) if api_key else AnonymousAuthenticationProvider()
        )

        # No `servers` block in the contract, so the request adapter's base_url must be set
        # explicitly before the generated client is constructed.
        self._adapter = HttpxRequestAdapter(auth_provider, http_client=http)
        self._adapter.base_url = base_url.rstrip("/")
        self._generated = CortadelApiClient(self._adapter)

    # ── Public API ───────────────────────────────────────────────────────────────────────────

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        """Store a memory. By default the server extracts entities/categories in the background;
        set ``options.infer = False`` to store verbatim."""
        body = CreateMemoryRequest(
            user_id=self._user_id,
            text=text,
            app=options.app if options else None,
            infer=True if options is None or options.infer is None else options.infer,
            memory_type=options.memory_type if options else None,
            metadata=_to_metadata_bag(options.metadata if options else None),
        )
        res = await self._execute(lambda: self._generated.api.v1.memories.post(body))
        return mapping.map_memory_created(res)

    async def add_conversation(
        self, messages: Iterable[ChatMessage], options: Optional[ConversationOptions] = None
    ) -> ConversationResult:
        """Distill a multi-turn conversation into atomic facts and store each one."""
        body = AddConversationRequest(
            user_id=self._user_id,
            messages=[ConversationMessageItem(role=m.role, content=m.content, uuid=m.uuid) for m in messages],
            is_agent_memory=options.is_agent_memory if options else False,
            tags=list(options.tags) if options and options.tags else None,
            project=options.project if options else None,
            session_id=options.session_id if options else None,
            transcript_path=options.transcript_path if options else None,
        )
        res = await self._execute(lambda: self._generated.api.v1.memories.from_conversation.post(body))
        return mapping.map_conversation_result(res)

    async def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        """Hybrid search (BM25 + vector + RRF, optional cross-encoder rerank)."""
        body = SearchMemoriesRequest(
            query=query,
            user_id=self._user_id,
            app_name=self._app_name,
            top_k=options.top_k if options else 10,
            mode=options.mode if options else "hybrid",
            session_id=options.session_id if options else None,
            rerank=options.rerank if options else None,
            memory_type=options.memory_type if options else None,
        )
        res = await self._execute(lambda: self._generated.api.v1.memories.search.post(body))
        return mapping.map_search_results(res)

    async def list(self, options: Optional[ListOptions] = None) -> MemoryList:
        """List memories for the user, newest-first, with pagination and optional filters."""
        params = MemoriesRequestBuilder.MemoriesRequestBuilderGetQueryParameters(
            user_id=self._user_id,
            page=options.page if options else 1,
            size=options.size if options else DEFAULT_LIST_SIZE,
            app_id=(options.app_id or None) if options else None,
            categories=(options.categories or None) if options else None,
            search_query=(options.search_query or None) if options else None,
            # Trap: include_superseded is a *string*-typed query param on the generated builder
            # ("true"), not a bool — ListOptions.include_superseded is a bool and must be
            # stringified, mirroring the .NET/TypeScript facades' own note on this same trap.
            include_superseded="true" if (options and options.include_superseded) else None,
            memory_type=(options.memory_type or None) if options else None,
        )
        config = RequestConfiguration(query_parameters=params)
        res = await self._execute(lambda: self._generated.api.v1.memories.get(request_configuration=config))
        return mapping.map_memory_list(res)

    async def get(self, memory_id: str) -> Optional[MemoryDetail]:
        """Fetch a single memory by id. Returns ``None`` if it does not exist — including a 404
        with an empty body and no ``Content-Type`` (what a server returns for an unmatched route,
        or a proxy 404 page)."""
        params = WithMemoryItemRequestBuilder.WithMemoryItemRequestBuilderGetQueryParameters(user_id=self._user_id)
        config = RequestConfiguration(query_parameters=params)
        try:
            res = await self._generated.api.v1.memories.by_memory_id(memory_id).get(request_configuration=config)
        except APIError as e:
            # Kiota's HttpxRequestAdapter always raises an APIError-derived exception with
            # response_status_code populated for a mapped error status — even when the body is
            # empty/unparseable and no typed ErrorResponse could be built (throw_failed_responses
            # falls back to a bare APIError in that case). So unlike the .NET/TypeScript legs
            # (which need a separate fallback path for exactly that empty-body 404 case), a single
            # status check here already covers both a JSON ErrorResponse 404 and an empty one.
            if e.response_status_code == 404:
                return None
            raise _translate(e) from e
        except Exception as e:  # noqa: BLE001 - see module docstring: asyncio.CancelledError is a
            # BaseException since Python 3.8 and is never caught by `except Exception`, so it
            # always propagates untouched here with no extra effort needed.
            raise CortadelError(0, "transport_error", str(e) or "The request failed.") from e
        return mapping.map_memory_detail(res) if res is not None else None

    async def delete(self, memory_ids: Iterable[str]) -> str:
        """Delete one or more memories. Returns the server's confirmation message."""
        body = DeleteMemoriesRequest(user_id=self._user_id, memory_ids=list(memory_ids))
        res = await self._execute(lambda: self._generated.api.v1.memories.delete(body))
        return res.message or ""

    async def health(self) -> HealthResult:
        """Server health (database + embedding provider reachability). Does **not** raise when
        the server reports itself degraded — see the ``except HealthResponse`` note below."""
        try:
            res = await self._generated.api.health.get()
        except HealthResponse as e:
            # Trap: the contract $refs HealthResponse for both the 200 and the 503 body, so Kiota
            # error-maps the 503 and a degraded server raises its own success-shaped type (every
            # generated model in the error_mapping subclasses APIError, HealthResponse included)
            # rather than returning it. The documented surface never raises on "degraded" — only
            # on transport/unexpected-status failures — so this catches it and maps it exactly
            # like a normal 200 body. Must be caught before `except APIError` below, since
            # HealthResponse *is* an APIError subclass and a broader clause would shadow this one.
            return mapping.map_health_result(e)
        except APIError as e:
            raise _translate(e) from e
        except Exception as e:  # noqa: BLE001 - see `get`'s equivalent comment.
            raise CortadelError(0, "transport_error", str(e) or "The request failed.") from e
        if res is None:
            raise CortadelError(502, "empty_response", "The server returned an empty response.")
        return mapping.map_health_result(res)

    async def aclose(self) -> None:
        """Closes the underlying HTTP client — but only if this client created it. A caller-
        supplied ``http_client`` is never closed here; you own its lifecycle."""
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> "CortadelClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # ── Generated call execution ────────────────────────────────────────────────────────────

    async def _execute(self, call):
        """Awaits a generated operation and translates whatever it raises into a
        :class:`CortadelError` — except ``asyncio.CancelledError``, which is never caught here
        (it is a ``BaseException`` subclass since Python 3.8, so a bare ``except Exception`` — the
        only catch-all this method uses — already excludes it; no narrower catch is needed the way
        the .NET/TypeScript legs need one for their own cancellation tokens/AbortSignals)."""
        try:
            result = await call()
        except APIError as e:
            raise _translate(e) from e
        except Exception as e:  # noqa: BLE001 - deliberate: see method docstring.
            # Kiota's ParseNodeFactoryRegistry raises a bare `Exception` (not an APIError) for a
            # response content type it has no parser registered for (e.g. `text/html` from a
            # reverse proxy or WAF error page) — there is no status code to recover from it, so 0
            # is used as an explicit "unknown" sentinel, matching the .NET/TypeScript legs' own
            # transport_error fallback for this same failure mode.
            raise CortadelError(0, "transport_error", str(e) or "The request failed.") from e
        if result is None:
            raise CortadelError(502, "empty_response", "The server returned an empty response.")
        return result


__all__ = ["CortadelClient", "DEFAULT_APP_NAME", "DEFAULT_TIMEOUT"]
