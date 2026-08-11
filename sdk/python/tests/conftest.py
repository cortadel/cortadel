"""Shared test helpers. Every network boundary is a stub ``httpx.MockTransport`` — nothing here
hits a real network. Mirrors ``sdk/typescript/test/client.test.ts``'s ``stubFetch`` helper."""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Union

import httpx

BASE_URL = "http://localhost:3001"
USER_ID = "e2e-client-test-user"

Responder = Union[httpx.Response, Callable[[httpx.Request], httpx.Response]]


@dataclass
class StubTransport:
    """Records every request it receives and returns pre-programmed responses in order (the last
    one repeats once exhausted, matching stubFetch's behavior)."""

    responses: list[Responder]
    calls: list[httpx.Request] = field(default_factory=list)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        index = min(len(self.calls) - 1, len(self.responses) - 1)
        responder = self.responses[index]
        return responder(request) if callable(responder) else responder


def stub_transport(responses: list[Responder]) -> tuple[httpx.MockTransport, StubTransport]:
    stub = StubTransport(responses=responses)
    return httpx.MockTransport(stub), stub


def json_response(body: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, content=json.dumps(body).encode("utf-8"), headers={"content-type": "application/json"})


def decode_body(request: httpx.Request) -> dict[str, Any]:
    """Decodes the JSON body Kiota's serializer set on a request."""
    return json.loads(request.content)


def make_http_client(transport: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport)
