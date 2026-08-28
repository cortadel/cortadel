"""``user_id`` is optional in both constructors.

Three behaviors, identical across the async and sync facades:

* **Omitted** — no ``user_id`` reaches the server at all: not as a body field, not as a query
  parameter. The server resolves the caller from the API key instead (which requires a server
  built from commit ``30b70ea4`` or later).
* **Explicitly blank** — still a ``ValueError``. Omission is a choice; ``""`` is a bug.
* **Explicitly provided** — sent exactly as before, unchanged.

Every test below inspects the bytes or the URL the stub transport actually received, rather than
just calling the method and asserting it did not raise. That is the whole point of the file: a
client that quietly sent ``"user_id": null`` in the body, or ``?user_id=`` in the query string,
would satisfy "the SDK no longer demands a user_id" while still failing against the server — a
present-but-empty ``user_id`` is not an absent one, and the list endpoint in particular emits
exactly that blank form unless the SDK strips it (see ``_drop_blank_user_id_query``).
"""
from __future__ import annotations

import threading

import pytest

from conftest import BASE_URL, USER_ID, decode_body, json_response, make_http_client, stub_transport
from cortadel import (
    AddOptions,
    ChatMessage,
    CortadelClient,
    ListOptions,
    SyncCortadelClient,
)

LIST_PAGE = {"items": [], "total": 0, "page": 1, "size": 20, "pages": 0}
CREATED = {"id": "m1", "content": "hello", "state": "active"}


def query_of(request) -> str:
    """The raw query string of a recorded request, decoded."""
    return request.url.query.decode("utf-8")


# ── Constructor validation ───────────────────────────────────────────────────────────────────


def test_omitting_user_id_is_legal() -> None:
    """The whole change: constructing without a user_id must not raise."""
    CortadelClient(BASE_URL)
    CortadelClient(BASE_URL, None)


def test_explicitly_blank_user_id_still_raises() -> None:
    with pytest.raises(ValueError, match="(?i)user_id"):
        CortadelClient(BASE_URL, "")
    with pytest.raises(ValueError, match="(?i)user_id"):
        CortadelClient(BASE_URL, "   ")
    with pytest.raises(ValueError, match="(?i)user_id"):
        CortadelClient(BASE_URL, "\t\n")


def test_blank_user_id_error_points_at_omitting_it() -> None:
    """A caller who hits this needs to know that omission — not ``""`` — is the supported way to
    let the server decide."""
    with pytest.raises(ValueError, match="(?i)omit"):
        CortadelClient(BASE_URL, "")


# ── Omitted: nothing on the wire (async) ─────────────────────────────────────────────────────


async def test_add_body_has_no_user_id_when_omitted() -> None:
    transport, stub = stub_transport([json_response(CREATED)])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, http_client=http)

    await client.add("hello", AddOptions(app="test-app"))

    body = decode_body(stub.calls[0])
    assert "user_id" not in body  # absent, not null and not ""
    assert body["text"] == "hello"
    assert body["app"] == "test-app"
    await http.aclose()


async def test_add_conversation_body_has_no_user_id_when_omitted() -> None:
    transport, stub = stub_transport([json_response({"results": []})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, http_client=http)

    await client.add_conversation([ChatMessage(role="user", content="hi")])

    body = decode_body(stub.calls[0])
    assert "user_id" not in body
    assert body["messages"] == [{"content": "hi", "role": "user"}]
    await http.aclose()


async def test_search_body_has_no_user_id_when_omitted() -> None:
    transport, stub = stub_transport([json_response({"results": []})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, http_client=http)

    await client.search("what do you know")

    body = decode_body(stub.calls[0])
    assert "user_id" not in body
    assert body["query"] == "what do you know"
    await http.aclose()


async def test_delete_body_has_no_user_id_when_omitted() -> None:
    transport, stub = stub_transport([json_response({"message": "deleted"})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, http_client=http)

    await client.delete(["m1", "m2"])

    body = decode_body(stub.calls[0])
    assert "user_id" not in body
    assert body["memory_ids"] == ["m1", "m2"]
    await http.aclose()


async def test_get_query_has_no_user_id_when_omitted() -> None:
    transport, stub = stub_transport([json_response({"id": "m1", "text": "hello", "state": "active"})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, http_client=http)

    await client.get("m1")

    assert "user_id" not in query_of(stub.calls[0])
    assert stub.calls[0].url.path == "/api/v1/memories/m1"
    await http.aclose()


async def test_list_query_has_no_user_id_when_omitted() -> None:
    """The regression this file exists for. The generated template for this operation hard-codes
    ``?user_id={user_id}``, so an undefined value leaves a literal ``user_id=`` behind unless the
    client strips it."""
    transport, stub = stub_transport([json_response(LIST_PAGE)])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, http_client=http)

    await client.list()

    query = query_of(stub.calls[0])
    assert "user_id" not in query, f"expected no user_id at all, got: {query!r}"
    assert "user_id" not in stub.calls[0].url.params
    # ...and the rest of the query survived the surgery.
    assert stub.calls[0].url.params["page"] == "1"
    assert stub.calls[0].url.params["size"] == "20"
    assert stub.calls[0].url.path == "/api/v1/memories"
    await http.aclose()


async def test_list_query_keeps_every_other_filter_when_user_id_is_omitted() -> None:
    transport, stub = stub_transport([json_response(LIST_PAGE)])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, http_client=http)

    await client.list(
        ListOptions(
            page=3,
            size=7,
            app_id="claude code",
            categories="work,personal",
            search_query="dark mode",
            include_superseded=True,
            memory_type="semantic",
        )
    )

    params = stub.calls[0].url.params
    assert "user_id" not in query_of(stub.calls[0])
    assert params["page"] == "3"
    assert params["size"] == "7"
    assert params["app_id"] == "claude code"
    assert params["categories"] == "work,personal"
    assert params["search_query"] == "dark mode"
    assert params["include_superseded"] == "true"
    assert params["memory_type"] == "semantic"
    await http.aclose()


async def test_omitted_user_id_never_sends_a_blank_one_on_any_call() -> None:
    """Belt and braces across all six request-issuing methods at once: no request may carry the
    substring ``user_id`` in its URL, nor a ``user_id`` key in its body."""
    responses = [
        json_response(CREATED),
        json_response({"results": []}),
        json_response({"results": []}),
        json_response(LIST_PAGE),
        json_response({"id": "m1", "text": "hello", "state": "active"}),
        json_response({"message": "deleted"}),
    ]
    transport, stub = stub_transport(responses)
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, api_key="a-key", http_client=http)

    await client.add("hello")
    await client.add_conversation([ChatMessage(role="user", content="hi")])
    await client.search("q")
    await client.list()
    await client.get("m1")
    await client.delete(["m1"])

    assert len(stub.calls) == 6
    for call in stub.calls:
        assert "user_id" not in query_of(call), f"{call.method} {call.url} leaked a user_id"
        if call.content:
            assert "user_id" not in decode_body(call), f"{call.method} {call.url} leaked a user_id"
    await http.aclose()


# ── Provided: unchanged (async) ──────────────────────────────────────────────────────────────


async def test_provided_user_id_is_still_sent_in_bodies() -> None:
    responses = [json_response(CREATED), json_response({"results": []}), json_response({"message": "deleted"})]
    transport, stub = stub_transport(responses)
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    await client.add("hello")
    await client.search("q")
    await client.delete(["m1"])

    assert decode_body(stub.calls[0])["user_id"] == USER_ID
    assert decode_body(stub.calls[1])["user_id"] == USER_ID
    assert decode_body(stub.calls[2])["user_id"] == USER_ID
    await http.aclose()


async def test_provided_user_id_is_still_sent_in_queries() -> None:
    transport, stub = stub_transport([json_response(LIST_PAGE), json_response({"id": "m1", "text": "x", "state": "active"})])
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    await client.list(ListOptions(page=2))
    await client.get("m1")

    assert stub.calls[0].url.params["user_id"] == USER_ID
    assert stub.calls[0].url.params["page"] == "2"
    assert stub.calls[1].url.params["user_id"] == USER_ID
    await http.aclose()


# ── Sync facade: same three behaviors ────────────────────────────────────────────────────────


def test_sync_omitting_user_id_is_legal_and_leaks_no_thread() -> None:
    baseline = threading.active_count()
    transport, _ = stub_transport([json_response({"status": "ok"})])
    client = SyncCortadelClient(BASE_URL, http_client=make_http_client(transport))
    client.close()
    assert threading.active_count() == baseline


def test_sync_explicitly_blank_user_id_still_raises() -> None:
    baseline = threading.active_count()

    with pytest.raises(ValueError, match="(?i)user_id"):
        SyncCortadelClient(BASE_URL, "")
    with pytest.raises(ValueError, match="(?i)user_id"):
        SyncCortadelClient(BASE_URL, "   ")

    # The async constructor now raises from a different branch than before; the sync facade's
    # teardown-on-failed-construction must still run for it.
    assert threading.active_count() == baseline


def test_sync_sends_no_user_id_when_omitted() -> None:
    transport, stub = stub_transport([json_response(CREATED), json_response(LIST_PAGE)])
    client = SyncCortadelClient(BASE_URL, http_client=make_http_client(transport))
    try:
        client.add("hello")
        client.list()
    finally:
        client.close()

    assert "user_id" not in decode_body(stub.calls[0])
    assert "user_id" not in query_of(stub.calls[1])
    assert stub.calls[1].url.params["size"] == "20"


def test_sync_still_sends_a_provided_user_id() -> None:
    transport, stub = stub_transport([json_response(CREATED), json_response(LIST_PAGE)])
    client = SyncCortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport))
    try:
        client.add("hello")
        client.list()
    finally:
        client.close()

    assert decode_body(stub.calls[0])["user_id"] == USER_ID
    assert stub.calls[1].url.params["user_id"] == USER_ID
