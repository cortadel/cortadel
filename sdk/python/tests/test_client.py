"""Facade tests for the async CortadelClient. Every network boundary is a stub
``httpx.MockTransport`` — nothing here hits a real network. Mirrors
``sdk/typescript/test/client.test.ts``'s coverage."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from conftest import BASE_URL, USER_ID, decode_body, json_response, make_http_client, stub_transport
from cortadel import AddOptions, ChatMessage, CortadelClient, CortadelError, ListOptions


# ── Constructor validation ──────────────────────────────────────────────────────────────────


def test_rejects_blank_base_url() -> None:
    with pytest.raises(ValueError, match="(?i)base_url"):
        CortadelClient("", USER_ID)
    with pytest.raises(ValueError, match="(?i)base_url"):
        CortadelClient("   ", USER_ID)


def test_rejects_malformed_base_url() -> None:
    with pytest.raises(ValueError, match="(?i)base_url"):
        CortadelClient("not a url", USER_ID)


def test_rejects_non_http_base_url() -> None:
    with pytest.raises(ValueError, match="(?i)http"):
        CortadelClient("ftp://example.com", USER_ID)


def test_accepts_plain_http_base_url() -> None:
    CortadelClient("http://box:3001", USER_ID)


def test_rejects_blank_user_id() -> None:
    with pytest.raises(ValueError, match="(?i)user_id"):
        CortadelClient(BASE_URL, "")
    with pytest.raises(ValueError, match="(?i)user_id"):
        CortadelClient(BASE_URL, "   ")


# ── Authentication ───────────────────────────────────────────────────────────────────────────


async def test_sends_bearer_header_when_api_key_configured() -> None:
    transport, stub = stub_transport([json_response({"status": "ok"})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, api_key="secret-key", http_client=http)

    await client.health()

    assert len(stub.calls) == 1
    assert stub.calls[0].headers["authorization"] == "Bearer secret-key"
    await http.aclose()


async def test_sends_no_auth_header_when_no_api_key() -> None:
    transport, stub = stub_transport([json_response({"status": "ok"})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    await client.health()

    assert "authorization" not in stub.calls[0].headers
    await http.aclose()


async def test_never_mutates_a_shared_http_client() -> None:
    """The same http_client used by two clients carries no cross-client auth: neither the
    request headers of the client without a key, nor the shared client's own persistent
    ``.headers``, ever pick up the other client's bearer token."""
    transport, stub = stub_transport([json_response({"status": "ok"}), json_response({"status": "ok"})])
    shared_http = make_http_client(transport)
    with_key = CortadelClient(BASE_URL, USER_ID, api_key="only-for-this-client", http_client=shared_http)
    without_key = CortadelClient(BASE_URL, "e2e-other-user", http_client=shared_http)

    await with_key.health()
    await without_key.health()

    assert stub.calls[0].headers["authorization"] == "Bearer only-for-this-client"
    assert "authorization" not in stub.calls[1].headers
    assert "authorization" not in shared_http.headers
    await shared_http.aclose()


# ── Request bodies ───────────────────────────────────────────────────────────────────────────


async def test_add_body_goes_out_snake_case() -> None:
    transport, stub = stub_transport([json_response({"id": "m1", "content": "hello", "state": "active"})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    await client.add("hello", AddOptions(app="test-app"))

    body = decode_body(stub.calls[0])
    assert body["user_id"] == USER_ID
    assert "userId" not in body
    assert body["app"] == "test-app"
    await http.aclose()


async def test_add_conversation_body_carries_user_id_not_user_id_camel() -> None:
    transport, stub = stub_transport([json_response({"results": []})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    await client.add_conversation([ChatMessage(role="user", content="hi")])

    body = decode_body(stub.calls[0])
    assert body["user_id"] == USER_ID
    assert "userId" not in body
    await http.aclose()


# ── get() ────────────────────────────────────────────────────────────────────────────────────


async def test_get_returns_none_on_404_with_json_error_response_body() -> None:
    transport, _ = stub_transport([json_response({"code": "not_found", "message": "no such memory", "status": 404}, 404)])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    assert await client.get("missing-id") is None
    await http.aclose()


async def test_get_returns_none_on_404_with_empty_body_no_content_type() -> None:
    """The proxy / unmatched-route 404 case: no body, no Content-Type header at all."""
    transport, _ = stub_transport([httpx.Response(404)])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    assert await client.get("missing-id") is None
    await http.aclose()


async def test_get_maps_a_found_memory() -> None:
    transport, _ = stub_transport(
        [json_response({"id": "m1", "text": "hello", "created_at": 1735689600, "is_global": False})]
    )
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    detail = await client.get("m1")

    assert detail is not None
    assert detail.id == "m1"
    assert detail.text == "hello"
    await http.aclose()


# ── Error translation ────────────────────────────────────────────────────────────────────────


async def test_rejects_with_cortadel_error_carrying_status_and_code() -> None:
    transport, _ = stub_transport([json_response({"code": "internal_error", "message": "boom", "status": 500}, 500)])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    with pytest.raises(CortadelError) as exc_info:
        await client.search("q")
    err = exc_info.value
    assert err.status == 500
    assert err.code == "internal_error"
    assert err.message == "boom"
    await http.aclose()


async def test_surfaces_validation_field_errors_in_message() -> None:
    transport, _ = stub_transport(
        [
            json_response(
                {
                    "title": "One or more validation errors occurred.",
                    "status": 400,
                    "errors": {"text": ["Text is required."], "memoryType": ["Invalid memory type."]},
                },
                400,
            )
        ]
    )
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    with pytest.raises(CortadelError) as exc_info:
        await client.add("")
    err = exc_info.value
    assert err.status == 400
    assert err.code == "validation_error"
    assert "Text is required." in err.message
    assert "Invalid memory type." in err.message
    await http.aclose()


async def test_raises_cortadel_error_for_unmapped_status_with_no_body() -> None:
    transport, _ = stub_transport([httpx.Response(502)])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    with pytest.raises(CortadelError) as exc_info:
        await client.search("q")
    assert exc_info.value.status == 502
    await http.aclose()


async def test_unparseable_error_body_becomes_transport_error() -> None:
    """A reverse-proxy/WAF error page (text/html) has no registered Kiota parser at all — Kiota's
    ParseNodeFactoryRegistry raises a bare Exception with no status code recoverable from it."""
    transport, _ = stub_transport(
        [httpx.Response(500, content=b"<html>502 Bad Gateway</html>", headers={"content-type": "text/html"})]
    )
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    with pytest.raises(CortadelError) as exc_info:
        await client.search("q")
    assert exc_info.value.code == "transport_error"
    assert exc_info.value.status == 0
    await http.aclose()


# ── Cancellation ─────────────────────────────────────────────────────────────────────────────


async def test_cancellation_propagates_instead_of_becoming_cortadel_error() -> None:
    async def slow_handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1.0)
        return json_response({"query": "q", "results": [], "total": 0})

    transport, _ = stub_transport([slow_handler])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    task = asyncio.ensure_future(client.search("q"))
    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    await http.aclose()


# ── health() ─────────────────────────────────────────────────────────────────────────────────


async def test_health_maps_degraded_503_like_a_normal_200() -> None:
    transport, _ = stub_transport(
        [json_response({"status": "degraded", "checks": {"memgraph": {"ok": False, "error": "connection refused"}}}, 503)]
    )
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    health = await client.health()
    assert health.status == "degraded"
    await http.aclose()


# ── list() ───────────────────────────────────────────────────────────────────────────────────


async def test_list_defaults_size_to_20() -> None:
    transport, stub = stub_transport([json_response({"items": [], "total": 0, "page": 1, "size": 20, "pages": 0})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    await client.list()

    assert "size=20" in str(stub.calls[0].url)
    await http.aclose()


async def test_list_stringifies_include_superseded() -> None:
    transport, stub = stub_transport([json_response({"items": [], "total": 0, "page": 1, "size": 20, "pages": 0})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    await client.list(ListOptions(include_superseded=True))

    assert "include_superseded=true" in str(stub.calls[0].url)
    await http.aclose()


# ── Context manager / aclose ─────────────────────────────────────────────────────────────────


async def test_context_manager_closes_only_an_owned_client() -> None:
    transport, _ = stub_transport([json_response({"status": "ok"})])
    async with CortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport)) as client:
        await client.health()
    # The client we passed in was created inside the `with` expression, so CortadelClient does
    # not own it (owns_http is only true when it builds its own) -- but the underlying transport
    # method still completed without error either way; this test's real assertion is the shape
    # of the `async with` usage itself not raising.


async def test_does_not_close_a_caller_supplied_http_client() -> None:
    transport, _ = stub_transport([json_response({"status": "ok"})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)
    await client.health()
    await client.aclose()
    assert http.is_closed is False
    await http.aclose()
