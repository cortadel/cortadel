"""Dedicated regression test for the import-time DeprecationWarning hazard the task report
documents: several of Kiota's generated request-builder modules (and several of
``kiota_abstractions``'s own internal modules) define now-superseded classes that call
``warnings.warn(..., DeprecationWarning)`` directly in their class body, so the warning fires the
moment the *module* is imported -- and three of the five affected request-builder modules are only
imported lazily, inside a property getter, the first time a caller invokes ``search()``,
``health()``, or ``add_conversation()``. ``cortadel.client._warm_generated_tree()`` forces all of
them to import once, under a scoped suppression, at ``cortadel.client``'s own import time -- this
test proves that guarantee by exercising every operation and asserting zero warnings, not just
relying on pytest's global ``filterwarnings = ["error"]`` (which would already fail this file's
other tests as a side effect, but wouldn't explain why)."""
from __future__ import annotations

import warnings

from conftest import BASE_URL, USER_ID, json_response, make_http_client, stub_transport
from cortadel import AddOptions, ChatMessage, CortadelClient, ListOptions, SearchOptions


async def test_every_operation_is_free_of_deprecation_warnings() -> None:
    responses = [
        json_response({"id": "m1", "content": "hi", "state": "active"}),  # add
        json_response({"results": []}),  # add_conversation
        json_response({"query": "q", "results": [], "total": 0}),  # search
        json_response({"items": [], "total": 0, "page": 1, "size": 20, "pages": 0}),  # list
        json_response({"id": "m1", "text": "hi", "created_at": 1, "is_global": False}),  # get
        json_response({"message": "deleted 1"}),  # delete
        json_response({"status": "ok"}),  # health
    ]
    transport, _ = stub_transport(responses)
    http = make_http_client(transport)
    client = CortadelClient(BASE_URL, USER_ID, http_client=http)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")

        await client.add("hi", AddOptions(app="test"))
        await client.add_conversation([ChatMessage(role="user", content="hi")])
        await client.search("q", SearchOptions(top_k=5))
        await client.list(ListOptions(include_superseded=True))
        await client.get("m1")
        await client.delete(["m1"])
        await client.health()

    deprecation_warnings = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert deprecation_warnings == [], [str(w.message) for w in deprecation_warnings]
    await http.aclose()
