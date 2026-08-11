"""Tests for SyncCortadelClient, focused on its background-event-loop lifecycle: the property
this facade exists for (see ``cortadel/sync_client.py``'s module docstring) is that it is a real
blocking client, not ``asyncio.run`` per call — so these tests specifically exercise thread/loop
survival across many calls and clean teardown, in addition to basic method parity."""
from __future__ import annotations

import threading

import httpx
import pytest

from conftest import BASE_URL, USER_ID, json_response, make_http_client, stub_transport
from cortadel import CortadelError, SyncCortadelClient


def test_constructor_validation_raises_synchronously() -> None:
    with pytest.raises(ValueError, match="(?i)base_url"):
        SyncCortadelClient("", USER_ID)


def test_failed_construction_does_not_leak_the_background_thread() -> None:
    baseline = threading.active_count()

    with pytest.raises(ValueError):
        SyncCortadelClient("not a url", USER_ID)

    # The background thread started during __init__ must be torn down before the ValueError
    # propagates -- otherwise every failed construction leaks one daemon thread forever.
    assert threading.active_count() == baseline


def test_basic_call_roundtrip() -> None:
    transport, stub = stub_transport([json_response({"status": "ok"})])
    client = SyncCortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport))
    try:
        health = client.health()
        assert health.status == "ok"
        assert len(stub.calls) == 1
    finally:
        client.close()


def test_raises_cortadel_error_synchronously() -> None:
    transport, _ = stub_transport([json_response({"code": "internal_error", "message": "boom", "status": 500}, 500)])
    client = SyncCortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport))
    try:
        with pytest.raises(CortadelError) as exc_info:
            client.search("q")
        assert exc_info.value.status == 500
    finally:
        client.close()


def test_survives_many_sequential_calls_without_leaking_threads_or_loops() -> None:
    n_calls = 50
    transport, stub = stub_transport([json_response({"status": "ok"})] * n_calls)
    baseline = threading.active_count()

    client = SyncCortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport))
    try:
        # Exactly one extra thread (the background loop) for the whole client lifetime --
        # calling health() 50 times must not spawn a new thread or loop per call.
        assert threading.active_count() == baseline + 1
        thread_ident_before = client._thread.ident

        for _ in range(n_calls):
            client.health()

        assert len(stub.calls) == n_calls
        assert threading.active_count() == baseline + 1
        assert client._thread.ident == thread_ident_before
        assert client._thread.is_alive()
        assert not client._loop.is_closed()
    finally:
        client.close()

    assert threading.active_count() == baseline


def test_close_stops_the_thread_and_is_idempotent() -> None:
    transport, _ = stub_transport([json_response({"status": "ok"})])
    client = SyncCortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport))
    thread = client._thread

    client.close()

    assert not thread.is_alive()
    # Safe to call more than once.
    client.close()
    assert not thread.is_alive()


def test_context_manager_exit_stops_the_thread() -> None:
    transport, _ = stub_transport([json_response({"status": "ok"})])
    with SyncCortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport)) as client:
        thread = client._thread
        client.health()
        assert thread.is_alive()

    assert not thread.is_alive()


def test_calls_after_close_raise_runtime_error() -> None:
    transport, _ = stub_transport([json_response({"status": "ok"})])
    client = SyncCortadelClient(BASE_URL, USER_ID, http_client=make_http_client(transport))
    client.close()

    with pytest.raises(RuntimeError, match="(?i)closed"):
        client.health()


def test_does_not_close_a_caller_supplied_http_client() -> None:
    transport, _ = stub_transport([json_response({"status": "ok"})])
    http = make_http_client(transport)
    client = SyncCortadelClient(BASE_URL, USER_ID, http_client=http)
    client.health()
    client.close()

    assert http.is_closed is False
