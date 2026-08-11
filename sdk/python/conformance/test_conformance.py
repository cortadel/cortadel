"""Runs every CortadelClient / SyncCortadelClient facade method against a real Cortadel server.
Skipped unless CORTADEL_CONFORMANCE_URL is set, so `pytest` (and therefore `pytest -q` with
nothing configured) stays green with no server available — see ENABLED below. This directory is
deliberately outside `pyproject.toml`'s `testpaths = ["tests"]`, so a bare `pytest` invocation
never even collects it; CI points at it explicitly (`pytest conformance`), mirroring the
TypeScript leg's own `test/` vs `conformance/` split (sdk/typescript/conformance/conformance.test.ts).

This is the only gate in this package that can catch a stale/wrong contract: unit tests
(tests/*.py) exercise the generated transport and the hand-written DTOs against each other, and
both can agree while still both disagreeing with the real server. That is exactly the defect that
started this project — the shipped SDK spoke camelCase to a snake_case server and every POST
returned 400 — and nothing in the unit suite could have caught it, because nothing there ever
makes a real HTTP call.

Assertions below deliberately check real values, not mere presence. The historical bugs this suite
exists to catch (a property bound to the wrong wire name) produce a silent default — `0`, `""`, or
`None` — which `assert x is not None` would pass right through. Numeric timestamps are checked
against a plausible range (not just `> 0`) so a unit mixup (e.g. milliseconds silently substituted
for seconds) also fails loudly instead of accidentally satisfying a weaker bound.

Two tiers, gated by two independent environment variables — same names as the .NET and TypeScript
legs' own conformance suites (sdk/dotnet/Cortadel.Sdk.Conformance/ConformanceTests.cs,
sdk/typescript/conformance/conformance.test.ts), so one CI provisioning recipe serves all three
languages:
 - **Base tier** (ENABLED, i.e. CORTADEL_CONFORMANCE_URL alone): needs only a Memgraph-backed
   server. health, get-missing, list-paginates, delete-nonexistent.
 - **LLM tier** (LLM_TIER_ENABLED, i.e. CORTADEL_CONFORMANCE_URL *and* CORTADEL_CONFORMANCE_LLM):
   every add()/add_conversation() call routes through the server's LLM-gated write pipeline
   (intent classification runs regardless of the `infer` flag), and search() needs a working
   embedding provider for the vector arm and the query embedding. add-then-get, list-includes,
   search, add-conversation, delete-removes, plus a dedicated test documenting the known
   `metadata` generator gap (see "Known limitation" below).

**Both facades, not just the async one.** Every test below runs twice — once against
`CortadelClient` (async), once against `SyncCortadelClient` (blocking) — via the `facade` fixture
and its `_Facade` adapter (below), which offloads the sync client's blocking calls onto a thread
via `asyncio.to_thread` so the same test body drives both without duplication. The sync facade is
the riskier of the two (background event-loop thread, `run_coroutine_threadsafe`, its own
close/join/loop-close teardown — see cortadel/sync_client.py's module docstring) and the unit
suite only ever exercises it against a mock transport; this is the only place it gets live network
coverage.
"""
from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator, Iterable
from datetime import datetime
from typing import Any, Optional
from urllib.parse import quote

import httpx
import pytest

from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    CortadelClient,
    HealthResult,
    ListOptions,
    MemoryCreated,
    MemoryDetail,
    MemoryList,
    SearchOptions,
    SearchResults,
    SyncCortadelClient,
)

# Every user id in this suite is test-scoped. Never "serhii" or any other real identity — this
# suite writes real data to whatever server CORTADEL_CONFORMANCE_URL points at, and "e2e-*" is the
# project-wide convention marking data as disposable test/E2E data. "-py-" (not "-ts-"/"-dotnet-")
# so a persistent server run across all three SDKs' conformance suites can tell them apart in logs.
USER = "e2e-py-sdk-conformance"

URL = os.environ.get("CORTADEL_CONFORMANCE_URL")
BASE_URL = (URL or "").rstrip("/")
API_KEY = os.environ.get("CORTADEL_CONFORMANCE_KEY")

ENABLED = bool(URL and URL.strip())
# Second, independent gate for the LLM-dependent tier. Any non-blank value turns it on — same
# convention as ENABLED/URL — the content doesn't matter, only presence, so PR CI can leave it
# entirely unset while a scheduled job sets it.
LLM_TIER_ENABLED = ENABLED and bool(os.environ.get("CORTADEL_CONFORMANCE_LLM", "").strip())

_base_tier = pytest.mark.skipif(not ENABLED, reason="CORTADEL_CONFORMANCE_URL not set")
_llm_tier = pytest.mark.skipif(not LLM_TIER_ENABLED, reason="CORTADEL_CONFORMANCE_URL and/or CORTADEL_CONFORMANCE_LLM not set")

# A single per-process tag, computed once and folded into every piece of content this suite
# writes. Two distinct goals, one value:
#  1. Uniqueness *across runs* against a persistent server (see also the teardown and
#     content-variation notes below, which handle the semantic-dedup side of this same concern).
#  2. Determinism *within* a run. Calling time.time() twice inside the same test (once to build
#     the text you add, once — by mistake — to build the query you later search for) would
#     silently produce two different values; the test then fails for a reason that has nothing to
#     do with the SDK under test. A single timestamp captured once at module load removes that
#     failure mode by construction, and reads as "when this run happened" when eyeballing server
#     logs.
RUN_TAG_VALUE = int(time.time() * 1000)
RUN_TAG = str(RUN_TAG_VALUE)


def vary(choices):
    """Deterministic pick from a small set of alternatives, keyed off the run's own timestamp —
    see "Content this suite writes" below for why this exists alongside RUN_TAG rather than
    instead of it."""
    return choices[RUN_TAG_VALUE % len(choices)]


def assert_plausible_unix_seconds(value: int, field_name: str) -> None:
    """Guards against a unit mixup (e.g. milliseconds silently substituted for seconds, which
    would produce a value ~1000x too large) in addition to the "did it bind at all" check.
    1_700_000_000 is 2023-11-14T22:13:20Z — safely in the past for any real server clock. The
    +300s upper-bound slack is deliberately generous (not tight to "just now") to tolerate
    ordinary clock skew between the machine running the tests and a containerized server — this
    check exists to catch a unit/naming bug that misses by orders of magnitude, not to pin down
    clock synchronization."""
    now = int(time.time())
    assert value > 1_700_000_000, (
        f"{field_name} = {value} is not a plausible Unix-seconds timestamp near now (naming/unit regression)"
    )
    assert value <= now + 300, (
        f"{field_name} = {value} is not a plausible Unix-seconds timestamp near now (naming/unit regression)"
    )


def _parse_iso8601(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


# ── Content this suite writes ─────────────────────────────────────────────
#
# Two independent defenses against the store's semantic dedup (cosine >= 0.85 candidate check,
# then an LLM verdict) confusing one run's assertions with another run's leftover data on a
# persistent server:
#  1. The `facade` fixture's teardown (below) deletes every memory the just-finished test created,
#     so a run that completes normally leaves nothing behind for a later run to collide with, at
#     all.
#  2. Each fact below is chosen from a small set of genuinely different phrasings, not the same
#     sentence with a trailing numeral swapped — a numeral-only difference is exactly the shape
#     semantic dedup is built to catch, so RUN_TAG alone would not have been a real defense for the
#     window #1 can't cover (two runs racing before either's teardown completes, or a prior run
#     killed mid-suite before its own teardown ran).
#
# Neither claims to make collision impossible; #1 handles the common (non-crashed, non-concurrent)
# case completely, #2 narrows the window #1 can't cover. Query strings are paired index-for-index
# with their fact so the search test's query always matches whichever variant was actually stored.
SEAT_FACTS = (
    "I prefer window seats on long-haul flights",
    "I always choose aisle seats near the exit row",
    "I book bulkhead seats whenever legroom matters most",
    "I avoid middle seats unless traveling with family",
)

COLOUR_FACTS = (
    ("My favourite colour is a specific shade of teal", "favourite colour specific shade of teal"),
    ("My favourite colour is burnt orange, never red", "favourite colour burnt orange"),
    ("My favourite colour is moss green in every room", "favourite colour moss green"),
    ("My favourite colour is dusty rose for stationery", "favourite colour dusty rose"),
)

ALLERGY_FACTS = (
    "I am allergic to peanuts",
    "I have a severe tree nut allergy",
    "I cannot eat shellfish because of an allergy",
    "I break out in hives around penicillin",
)

PAGINATION_FACTS = (
    "Memory written to verify the list endpoint returns it",
    "Entry stored to confirm pagination includes fresh rows",
    "Fact added to check the listing API surfaces new writes",
    "Row created to validate that list results include this run",
)

DELETION_FACTS = (
    "Temporary fact staged for deletion in this run",
    "Disposable memory created only to be deleted",
    "Scratch entry that this test immediately removes",
    "Throwaway fact this run deletes right after adding it",
)


# ── Raw-wire cross-checks ────────────────────────────────────────────────
#
# cortadel.mapping coalesces several nullable wire fields to a default that happens to equal what
# a *correct* response looks like for the data this suite creates (every memory here is personal
# and active): `is_global=... or False` (map_memory_detail, map_memory_list_item, map_search_hit)
# and `state=... or "active"` (map_memory_detail, map_memory_list_item). A wire-name regression on
# is_global/global/state would silently fall back to that same default — indistinguishable,
# through the facade alone, from a correct mapping. `assert x.is_global is False` or
# `assert x.state == "active"` would pass either way. These helpers issue the identical request
# through an independent, bare `httpx` call, bypassing cortadel's mapping entirely, and check the
# raw JSON body directly, so a missing/renamed key fails loudly instead of being absorbed by the
# coalesce.
def _raw_headers() -> dict[str, str]:
    headers: dict[str, str] = {}
    if API_KEY and API_KEY.strip():
        headers["authorization"] = f"Bearer {API_KEY}"
    return headers


async def get_raw(path_and_query: str) -> dict[str, Any]:
    async with httpx.AsyncClient() as client:
        res = await client.get(f"{BASE_URL}{path_and_query}", headers=_raw_headers())
        if res.status_code >= 400:
            raise RuntimeError(f"raw GET {path_and_query} failed: HTTP {res.status_code}")
        return res.json()


async def post_raw(path: str, body: Any) -> dict[str, Any]:
    async with httpx.AsyncClient() as client:
        res = await client.post(f"{BASE_URL}{path}", json=body, headers=_raw_headers())
        if res.status_code >= 400:
            raise RuntimeError(f"raw POST {path} failed: HTTP {res.status_code}")
        return res.json()


def assert_wire_bool_field(obj: dict[str, Any], key: str, expected: bool, context: str) -> None:
    assert key in obj, f"{context}: wire body has no '{key}' key at all"
    assert obj[key] is expected


# ── Both facades ─────────────────────────────────────────────────────────


class _Facade:
    """Uniform async interface over either CortadelClient (already async) or SyncCortadelClient
    (blocking, offloaded to a thread via asyncio.to_thread) so every test body below runs
    unmodified against both — see the module docstring's "Both facades" section."""

    def __init__(self, client: Any, *, is_sync: bool) -> None:
        self._client = client
        self._is_sync = is_sync
        self.created_ids: list[str] = []

    def remember(self, memory_id: Optional[str]) -> None:
        if memory_id and memory_id.strip():
            self.created_ids.append(memory_id)

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        if self._is_sync:
            return await asyncio.to_thread(self._client.add, text, options)
        return await self._client.add(text, options)

    async def add_conversation(
        self, messages: Iterable[ChatMessage], options: Optional[ConversationOptions] = None
    ) -> ConversationResult:
        if self._is_sync:
            return await asyncio.to_thread(self._client.add_conversation, list(messages), options)
        return await self._client.add_conversation(messages, options)

    async def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        if self._is_sync:
            return await asyncio.to_thread(self._client.search, query, options)
        return await self._client.search(query, options)

    async def list(self, options: Optional[ListOptions] = None) -> MemoryList:
        if self._is_sync:
            return await asyncio.to_thread(self._client.list, options)
        return await self._client.list(options)

    async def get(self, memory_id: str) -> Optional[MemoryDetail]:
        if self._is_sync:
            return await asyncio.to_thread(self._client.get, memory_id)
        return await self._client.get(memory_id)

    async def delete(self, memory_ids: Iterable[str]) -> str:
        ids = list(memory_ids)
        if self._is_sync:
            return await asyncio.to_thread(self._client.delete, ids)
        return await self._client.delete(ids)

    async def health(self) -> HealthResult:
        if self._is_sync:
            return await asyncio.to_thread(self._client.health)
        return await self._client.health()

    async def aclose(self) -> None:
        if self._is_sync:
            await asyncio.to_thread(self._client.close)
        else:
            await self._client.aclose()


@pytest.fixture(params=["async", "sync"], ids=["async", "sync"])
async def facade(request) -> AsyncIterator[_Facade]:
    # Guards fixture setup itself, not just the tests that request it — belt-and-suspenders with
    # the per-test `_base_tier`/`_llm_tier` skip markers below, so no client is ever constructed
    # (and no connection attempted) when nothing is configured, regardless of pytest hook
    # ordering. This is what makes `pytest conformance` skip cleanly and exit 0 with nothing set.
    if not ENABLED:
        pytest.skip("CORTADEL_CONFORMANCE_URL not set")

    if request.param == "sync":
        client: Any = SyncCortadelClient(BASE_URL, USER, api_key=API_KEY or None)
        f = _Facade(client, is_sync=True)
    else:
        client = CortadelClient(BASE_URL, USER, api_key=API_KEY or None)
        f = _Facade(client, is_sync=False)

    try:
        yield f
    finally:
        if f.created_ids:
            try:
                await f.delete(f.created_ids)
            except Exception:
                # Best-effort cleanup: a teardown failure (transient network error, or an id the
                # test itself already deleted) must not mask the test's own pass/fail result,
                # which has already been determined by the time this runs — there is nothing more
                # this suite can do about a cleanup that didn't take.
                pass
        await f.aclose()


# ═══════════════════════════════════════════════════════════════════════════
# Base tier — needs only CORTADEL_CONFORMANCE_URL (a Memgraph-backed server; no LLM or embedding
# provider required).
# ═══════════════════════════════════════════════════════════════════════════


@_base_tier
async def test_health_reports_a_status(facade: _Facade) -> None:
    h = await facade.health()
    assert h.status in ("ok", "degraded")


@_base_tier
async def test_get_returns_none_for_a_missing_memory(facade: _Facade) -> None:
    result = await facade.get(f"does-not-exist-{RUN_TAG}")
    assert result is None


@_base_tier
async def test_list_paginates(facade: _Facade) -> None:
    # Deliberately does not seed data — that would need add(), which is LLM-tier (see
    # test_list_includes_a_just_added_memory for the content-level check). page/size are checked
    # as an exact echo of the request (37 chosen specifically to not collide with a plausible
    # server-side default like 10/20/50, so this is load-bearing even if the param were silently
    # ignored), which holds whether the store is empty or not.
    page = await facade.list(ListOptions(page=1, size=37))

    assert page.page == 1
    assert page.size == 37
    assert page.total >= 0
    assert len(page.items) <= page.size


@_base_tier
async def test_delete_tolerates_a_nonexistent_id(facade: _Facade) -> None:
    # No add() involved — deleting an id that was never created needs only a store query matching
    # zero rows, not the LLM-gated write pipeline. Exercises delete()'s request/response mapping
    # without requiring the LLM tier.
    msg = await facade.delete([f"does-not-exist-{RUN_TAG}"])

    assert len(msg.strip()) > 0


# ═══════════════════════════════════════════════════════════════════════════
# LLM tier — needs CORTADEL_CONFORMANCE_URL *and* CORTADEL_CONFORMANCE_LLM, and the server itself
# configured with a working LLM provider (intent classification, conversation distillation) and
# embedding provider (vector search, dedup).
# ═══════════════════════════════════════════════════════════════════════════


@_llm_tier
async def test_add_then_get_round_trips_every_field(facade: _Facade) -> None:
    text = f"[conformance {RUN_TAG}] {vary(SEAT_FACTS)}"

    created = await facade.add(text, AddOptions(app="conformance-suite", infer=False))
    facade.remember(created.id)
    assert len(created.id.strip()) > 0
    # MemoryCreated.created_at is an ISO 8601 *string* on this endpoint (unlike list/detail, which
    # return Unix seconds — see cortadel/models.py) — assert it is both present and actually
    # parses, not just non-blank.
    assert created.created_at, "MemoryCreated.created_at did not bind to a real value"
    assert _parse_iso8601(created.created_at) is not None, (
        f"MemoryCreated.created_at '{created.created_at}' is not a parseable ISO 8601 timestamp"
    )
    # app_name is one of the fields called out as historically mis-bound; assert it on the create
    # response directly, not only on the later get(). No `or default` collision here —
    # map_memory_created passes app_name through unmodified, so None would fail this outright.
    assert created.app_name == "conformance-suite"

    got = await facade.get(created.id)
    assert got is not None
    assert got.text == text
    # created_at here is Unix seconds (MemoryDetailResponse) — the field the shipped SDK silently
    # read as 0 because of a wire-name/casing mismatch. `assert x is not None` would pass right
    # through that regression; a plausible real value would not, and map_memory_detail's own
    # `or 0` fallback can't collide with "plausible" the way it can with is_global/state below,
    # since 0 always fails the range check.
    assert_plausible_unix_seconds(got.created_at, "MemoryDetail.created_at")
    assert got.app_name == "conformance-suite"

    # Facade-level observations: what a caller of get() actually sees. On their own these two
    # cannot distinguish a correct mapping from a silently-broken one for this suite's data —
    # map_memory_detail's `is_global=... or False` / `state=... or "active"` defaults happen to
    # equal what a genuinely personal, active memory looks like. The raw-wire cross-check right
    # after this is the actual regression detector for these two fields; see "Raw-wire
    # cross-checks" above.
    assert got.is_global is False
    assert got.state == "active"

    raw = await get_raw(f"/api/v1/memories/{quote(created.id, safe='')}?user_id={quote(USER, safe='')}")
    assert_wire_bool_field(raw, "is_global", False, "MemoryDetailResponse")
    assert "state" in raw, "MemoryDetailResponse: wire body has no 'state' key at all"
    assert raw["state"] == "active"


@_llm_tier
async def test_list_includes_a_just_added_memory(facade: _Facade) -> None:
    text = f"[conformance {RUN_TAG}] {vary(PAGINATION_FACTS)}"
    created = await facade.add(text, AddOptions(app="conformance-suite", infer=False))
    facade.remember(created.id)

    # Size at the documented max (100) so the item we just added (newest-first sort) is guaranteed
    # to land on page 1 regardless of how much history a persistent store has.
    page = await facade.list(ListOptions(page=1, size=100))

    matches = [i for i in page.items if i.id == created.id]
    assert len(matches) == 1, f"expected exactly one item with id {created.id}"
    item = matches[0]
    assert item.content == text
    assert_plausible_unix_seconds(item.created_at, "MemoryListItem.created_at")
    # Facade-level observation only — see "Raw-wire cross-checks" above for why this alone cannot
    # catch a wire-name regression on is_global, and the real check right after it.
    assert item.is_global is False

    raw = await get_raw(f"/api/v1/memories?user_id={quote(USER, safe='')}&page=1&size=100")
    raw_items = raw.get("items") or []
    raw_matches = [e for e in raw_items if e.get("id") == created.id]
    assert len(raw_matches) == 1
    assert_wire_bool_field(raw_matches[0], "is_global", False, "MemoryListItemResponse")


@_llm_tier
async def test_search_returns_scored_hits(facade: _Facade) -> None:
    fact, query = vary(COLOUR_FACTS)
    text = f"[conformance {RUN_TAG}] {fact}"
    created = await facade.add(text, AddOptions(app="conformance-suite", infer=False))
    facade.remember(created.id)

    # top_k at the documented max (50) so this doesn't flake against a busy persistent store where
    # our fresh memory might not land in a smaller top-K window.
    r = await facade.search(query, SearchOptions(top_k=50))

    assert len(r.results) > 0
    matches = [h for h in r.results if h.content == text]
    assert len(matches) == 1, f'expected exactly one hit with content "{text}"'
    hit = matches[0]
    # rrf_score is the field the shipped SDK pinned to the wrong wire name and always read as
    # null. The contract declares it a required, non-nullable number — a real hit must carry a
    # real, plausible score. No `or default` here (map_search_hit passes rrf_score through
    # unmodified), so this genuinely can't be satisfied by a coalesced fallback.
    assert hit.rrf_score is not None, "rrf_score did not bind — naming regression"
    assert hit.rrf_score > 0, f"rrf_score = {hit.rrf_score} is not a plausible fused score"
    assert hit.app_name == "conformance-suite"
    # Facade-level observation only — see "Raw-wire cross-checks" above.
    assert hit.is_global is False

    raw = await post_raw("/api/v1/memories/search", {"query": query, "user_id": USER, "top_k": 50})
    raw_results = raw.get("results") or []
    raw_matches = [e for e in raw_results if e.get("content") == text]
    assert len(raw_matches) == 1
    # Trap: this schema's flag is `global`, not `is_global` (MemoryListItem/MemoryDetail use
    # `is_global` instead) — mirrors the same asymmetry the .NET and TypeScript legs' conformance
    # suites caught, and cortadel/mapping.py's own note on HybridSearchResult.global_.
    assert_wire_bool_field(raw_matches[0], "global", False, "HybridSearchResult")


@_llm_tier
async def test_add_conversation_returns_results(facade: _Facade) -> None:
    r = await facade.add_conversation(
        [
            ChatMessage(role="user", content=f"[conformance {RUN_TAG}] {vary(ALLERGY_FACTS)}"),
            ChatMessage(role="assistant", content="Noted."),
        ],
        ConversationOptions(session_id=f"conformance-{RUN_TAG}"),
    )

    if r.results:
        for item in r.results:
            if item.id and item.id.strip():
                facade.remember(item.id)

    # The shipped SDK invented a stored/skipped/ids shape that never existed on the wire. The real
    # contract is `results` XOR `no_facts_extracted` (one entry per distilled fact, or a flag that
    # nothing was extracted) — never both, per ConversationResult's documented invariant. Exactly
    # how many facts a conversation distills into depends on the conformance server's own LLM
    # extraction, which this suite does not control — so this checks the *shape* is the real one,
    # not an exact fact count.
    if r.no_facts_extracted is True:
        assert not r.results
    else:
        assert r.results
        assert len(r.results) > 0
        for item in r.results:
            assert (item.event or "").strip() != ""
            # memory (the distilled fact text) is only guaranteed populated on a non-ERROR event;
            # an ERROR item instead carries `error`, per ConversationIngestItem's docs.
            if item.event != "ERROR":
                assert (item.memory or "").strip() != ""
                assert (item.id or "").strip() != "", "id did not bind to a real value — naming regression"


@_llm_tier
async def test_delete_removes_a_memory(facade: _Facade) -> None:
    text = f"[conformance {RUN_TAG}] {vary(DELETION_FACTS)}"
    created = await facade.add(text, AddOptions(app="conformance-suite", infer=False))
    facade.remember(created.id)  # redundant safety net; the explicit delete below already removes it

    msg = await facade.delete([created.id])

    assert len(msg.strip()) > 0
    # The real behavioral proof, not just trusting the confirmation string: the memory must
    # actually be gone.
    assert await facade.get(created.id) is None


# ═══════════════════════════════════════════════════════════════════════════
# Known limitation: the metadata generator gap
# ═══════════════════════════════════════════════════════════════════════════


@_llm_tier
async def test_known_limitation_metadata_is_dropped_by_the_generated_model(facade: _Facade) -> None:
    """Documents, rather than silently accepts, the generator gap noted in cortadel/mapping.py
    and cortadel/models.py: MemoryDetailResponse.metadata_ / MemoryListItemResponse.metadata_
    declare no `type` in spec/openapi.json (just `"nullable": true`), and Kiota's Python generator
    (1.34.1) drops properties with no declared type **entirely** — unlike the .NET and TypeScript
    generators, which fall back to an untyped/"any" node for the same schema. There is no
    `metadata`/`metadata_` attribute on the generated dataclass to read a value from, so
    cortadel.mapping's map_memory_detail/map_memory_list_item always set `metadata=None`,
    regardless of what the server actually stored.

    This deliberately does NOT just assert `got.metadata is None` — that alone would pass whether
    the gap is real or the field was simply never populated, and would keep silently "passing"
    forever even after a kiota upgrade fixes the generator (see the .NET/TypeScript legs' own
    "Extra/AdditionalData" quirks for the same failure-to-notice-a-fix shape). Instead: store a
    memory WITH real metadata, confirm via an independent raw `httpx` request that the wire
    response actually carries `metadata_` with the value sent (proving the *server* round-trips
    it, so a `None` on the typed side really is the SDK's own gap and not the server dropping it
    first), and confirm the SDK's typed model does NOT surface it. The day a kiota upgrade starts
    emitting a `metadata`/`metadata_` attribute, this test's typed-model assertions fail — a
    signal to update mapping.py and delete the workaround, instead of leaving stale documentation
    to rot.
    """
    metadata = {"conformance_run": RUN_TAG, "source": "python-sdk-conformance"}
    text = f"[conformance {RUN_TAG}] Fact stored with metadata to probe the generator gap"
    created = await facade.add(text, AddOptions(app="conformance-suite", infer=False, metadata=metadata))
    facade.remember(created.id)

    # Raw wire (MemoryDetailResponse): the server DOES echo metadata_ back — independent of the
    # SDK's mapping entirely, a bare httpx GET.
    raw_detail = await get_raw(f"/api/v1/memories/{quote(created.id, safe='')}?user_id={quote(USER, safe='')}")
    assert raw_detail.get("metadata_") is not None, (
        "MemoryDetailResponse: wire body has no non-null 'metadata_' — if this starts failing, "
        "the server stopped echoing metadata and the typed-model half of this test below is no "
        "longer a meaningful comparison either."
    )
    assert raw_detail["metadata_"].get("conformance_run") == RUN_TAG, (
        f"wire metadata_ = {raw_detail['metadata_']!r} does not contain the value this test sent"
    )

    # Typed model (MemoryDetail): the SDK facade never surfaces it — known generator gap, not a
    # mapping bug.
    got = await facade.get(created.id)
    assert got is not None
    assert got.metadata is None, (
        "MemoryDetail.metadata is no longer None -- the Python kiota generator apparently started "
        "emitting the metadata_/metadata property. Update cortadel/mapping.py's "
        "map_memory_detail/map_memory_list_item to read it (see the known-limitation comments "
        "there), then update or remove this test."
    )

    # Same probe against the list endpoint's item shape (MemoryListItemResponse carries the
    # identical gap — see mapping.py's map_memory_list_item).
    page = await facade.list(ListOptions(page=1, size=100))
    list_matches = [i for i in page.items if i.id == created.id]
    assert len(list_matches) == 1
    assert list_matches[0].metadata is None

    raw_list = await get_raw(f"/api/v1/memories?user_id={quote(USER, safe='')}&page=1&size=100")
    raw_list_items = raw_list.get("items") or []
    raw_list_matches = [e for e in raw_list_items if e.get("id") == created.id]
    assert len(raw_list_matches) == 1
    assert raw_list_matches[0].get("metadata_") is not None, "MemoryListItemResponse: wire body has no non-null 'metadata_'"
    assert raw_list_matches[0]["metadata_"].get("conformance_run") == RUN_TAG
