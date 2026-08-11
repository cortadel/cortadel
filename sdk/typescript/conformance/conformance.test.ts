// Runs every CortadelClient facade method against a real Cortadel server. Skipped unless
// CORTADEL_CONFORMANCE_URL is set, so `vitest run` (and therefore `pnpm test`) stays green with
// no server configured — see `Enabled` below.
//
// This is the only gate in this package that can catch a stale/wrong contract: unit tests
// (test/*.test.ts) exercise the generated transport and the hand-written DTOs against each other,
// and both can agree while still both disagreeing with the real server. That is exactly the defect
// that started this project — the shipped SDK spoke camelCase to a snake_case server and every POST
// returned 400 — and nothing in the unit suite could have caught it, because nothing there ever
// makes a real HTTP call.
//
// Assertions below deliberately check real values, not mere presence. The historical bugs this
// suite exists to catch (a property bound to the wrong wire name) produce a silent default — `0`,
// `""`, or `null` — which `expect(x).not.toBeNull()` would pass right through. Numeric timestamps
// are checked against a plausible range (not just `> 0`) so a unit mixup (e.g. milliseconds
// silently substituted for seconds) also fails loudly instead of accidentally satisfying a weaker
// bound.
//
// Two tiers, gated by two independent environment variables — same names as the .NET leg's
// conformance suite (sdk/dotnet/Cortadel.Sdk.Conformance/ConformanceTests.cs), so one CI
// provisioning recipe serves every language:
//  - **Base tier** (`Enabled`, i.e. CORTADEL_CONFORMANCE_URL alone): needs only a Memgraph-backed
//    server. health, get-missing, list-paginates, delete-nonexistent.
//  - **LLM tier** (`LlmTierEnabled`, i.e. CORTADEL_CONFORMANCE_URL *and* CORTADEL_CONFORMANCE_LLM):
//    every add()/addConversation() call routes through the server's LLM-gated write pipeline
//    (intent classification runs regardless of the `infer` flag), and search() needs a working
//    embedding provider for the vector arm and the query embedding. add-then-get, list-includes,
//    search, add-conversation, delete-removes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CortadelClient } from "../src/client.js";

// Every user id in this suite is test-scoped. Never "serhii" or any other real identity — this
// suite writes real data to whatever server CORTADEL_CONFORMANCE_URL points at, and "e2e-*" is the
// project-wide convention marking data as disposable test/E2E data.
const USER = "e2e-ts-sdk-conformance";

const URL = process.env.CORTADEL_CONFORMANCE_URL;
const BASE_URL = (URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.CORTADEL_CONFORMANCE_KEY;

const Enabled = Boolean(URL && URL.trim());
// Second, independent gate for the LLM-dependent tier. Any non-blank value turns it on — same
// convention as Enabled/Url — the content doesn't matter, only presence, so PR CI can leave it
// entirely unset while a scheduled job sets it.
const LlmTierEnabled = Enabled && Boolean(process.env.CORTADEL_CONFORMANCE_LLM && process.env.CORTADEL_CONFORMANCE_LLM.trim());

function newClient(): CortadelClient {
  return new CortadelClient({ baseUrl: BASE_URL, userId: USER, apiKey: API_KEY || undefined });
}

// A single per-process tag, computed once and folded into every piece of content this suite
// writes. Two distinct goals, one value:
//  1. Uniqueness *across runs* against a persistent server (see also the teardown and
//     content-variation notes below, which handle the semantic-dedup side of this same concern).
//  2. Determinism *within* a run. `Math.random()` would satisfy goal 1 just as well, but invites a
//     real trap for goal 2: call it twice inside the same test (once to build the text you add,
//     once — by mistake — to build the query you later search for) and you silently get two
//     different values; the test then fails for a reason that has nothing to do with the SDK under
//     test. A single timestamp captured once at module load removes that failure mode by
//     construction, and reads as "when this run happened" when eyeballing server logs.
const RUN_TAG_VALUE = Date.now();
const RUN_TAG = String(RUN_TAG_VALUE);

// Deterministic pick from a small set of alternatives, keyed off the run's own timestamp — see
// "Content this suite writes" below for why this exists alongside RUN_TAG rather than instead of
// it.
function vary<T>(choices: readonly T[]): T {
  return choices[RUN_TAG_VALUE % choices.length]!;
}

// Guards against a unit mixup (e.g. milliseconds silently substituted for seconds, which would
// produce a value ~1000x too large) in addition to the "did it bind at all" check. 1_700_000_000
// is 2023-11-14T22:13:20Z — safely in the past for any real server clock. The +300s upper-bound
// slack is deliberately generous (not tight to "just now") to tolerate ordinary clock skew between
// the machine running the tests and a containerized server — this check exists to catch a
// unit/naming bug that misses by orders of magnitude, not to pin down clock synchronization.
function assertPlausibleUnixSeconds(value: number, field: string): void {
  const now = Math.floor(Date.now() / 1000);
  expect(value, `${field} = ${value} is not a plausible Unix-seconds timestamp near now (naming/unit regression)`).toBeGreaterThan(
    1_700_000_000,
  );
  expect(value, `${field} = ${value} is not a plausible Unix-seconds timestamp near now (naming/unit regression)`).toBeLessThanOrEqual(
    now + 300,
  );
}

// ── Content this suite writes ─────────────────────────────────────────────
//
// Two independent defenses against the store's semantic dedup (cosine >= 0.85 candidate check,
// then an LLM verdict) confusing one run's assertions with another run's leftover data on a
// persistent server:
//  1. afterEach (below) deletes every memory the just-finished test created, so a run that
//     completes normally leaves nothing behind for a later run to collide with, at all.
//  2. Each fact below is chosen from a small set of genuinely different phrasings, not the same
//     sentence with a trailing numeral swapped — a numeral-only difference is exactly the shape
//     semantic dedup is built to catch, so RUN_TAG alone would not have been a real defense for the
//     window #1 can't cover (two runs racing before either's teardown completes, or a prior run
//     killed mid-suite before its own teardown ran).
//
// Neither claims to make collision impossible; #1 handles the common (non-crashed, non-concurrent)
// case completely, #2 narrows the window #1 can't cover. Query strings are paired index-for-index
// with their fact so the search test's query always matches whichever variant was actually stored.
const SEAT_FACTS = [
  "I prefer window seats on long-haul flights",
  "I always choose aisle seats near the exit row",
  "I book bulkhead seats whenever legroom matters most",
  "I avoid middle seats unless traveling with family",
] as const;

const COLOUR_FACTS = [
  { fact: "My favourite colour is a specific shade of teal", query: "favourite colour specific shade of teal" },
  { fact: "My favourite colour is burnt orange, never red", query: "favourite colour burnt orange" },
  { fact: "My favourite colour is moss green in every room", query: "favourite colour moss green" },
  { fact: "My favourite colour is dusty rose for stationery", query: "favourite colour dusty rose" },
] as const;

const ALLERGY_FACTS = [
  "I am allergic to peanuts",
  "I have a severe tree nut allergy",
  "I cannot eat shellfish because of an allergy",
  "I break out in hives around penicillin",
] as const;

const PAGINATION_FACTS = [
  "Memory written to verify the list endpoint returns it",
  "Entry stored to confirm pagination includes fresh rows",
  "Fact added to check the listing API surfaces new writes",
  "Row created to validate that list results include this run",
] as const;

const DELETION_FACTS = [
  "Temporary fact staged for deletion in this run",
  "Disposable memory created only to be deleted",
  "Scratch entry that this test immediately removes",
  "Throwaway fact this run deletes right after adding it",
] as const;

// ── Teardown ─────────────────────────────────────────────────────────────
//
// Reset before each test so this list only ever holds ids the just-run test created (mirrors the
// .NET suite's per-test-instance _createdIds, achieved there by xUnit constructing a fresh test
// class per method).
let createdIds: string[] = [];

beforeEach(() => {
  createdIds = [];
});

afterEach(async () => {
  if (createdIds.length === 0 || !Enabled) return;
  try {
    await newClient().delete(createdIds);
  } catch {
    // Best-effort cleanup: a teardown failure (transient network error, or an id the test itself
    // already deleted) must not mask the test's own pass/fail result, which has already been
    // determined by the time this runs — there is nothing more this suite can do about a cleanup
    // that didn't take.
  }
});

// ── Raw-wire cross-checks ────────────────────────────────────────────────
//
// CortadelClient's mapping (src/mapping.ts) coalesces several nullable wire fields to a default
// that happens to equal what a *correct* response looks like for the data this suite creates
// (every memory here is personal and active): `isGlobal: ... ?? false` (mapMemoryDetail,
// mapMemoryListItem, mapSearchHit) and `state: ... ?? "active"` (mapMemoryDetail). A wire-name
// regression on is_global/global/state would silently fall back to that same default —
// indistinguishable, through the facade alone, from a correct mapping. `expect(x.isGlobal).toBe
// (false)` or `expect(x.state).toBe("active")` would pass either way. These helpers issue the
// identical request through a bare `fetch`, bypassing CortadelClient's mapping entirely, and check
// the raw JSON body directly, so a missing/renamed key fails loudly instead of being absorbed by
// the coalesce.
function rawHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (API_KEY && API_KEY.trim()) headers.authorization = `Bearer ${API_KEY}`;
  return headers;
}

async function getRaw(pathAndQuery: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, { headers: rawHeaders() });
  if (!res.ok) throw new Error(`raw GET ${pathAndQuery} failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function postRaw(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { ...rawHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`raw POST ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function assertWireBoolField(obj: Record<string, unknown>, key: string, expected: boolean, context: string): void {
  expect(Object.prototype.hasOwnProperty.call(obj, key), `${context}: wire body has no '${key}' key at all`).toBe(true);
  expect(obj[key]).toBe(expected);
}

// ═══════════════════════════════════════════════════════════════════════════
// Base tier — needs only CORTADEL_CONFORMANCE_URL (a Memgraph-backed server; no LLM or embedding
// provider required).
// ═══════════════════════════════════════════════════════════════════════════

describe("conformance (base tier)", () => {
  it.skipIf(!Enabled)("health() reports a status", async () => {
    const c = newClient();

    const h = await c.health();

    expect(["ok", "degraded"]).toContain(h.status);
  });

  it.skipIf(!Enabled)("get() returns null for a missing memory", async () => {
    const c = newClient();

    await expect(c.get(`does-not-exist-${RUN_TAG}`)).resolves.toBeNull();
  });

  it.skipIf(!Enabled)("list() paginates", async () => {
    const c = newClient();

    // Deliberately does not seed data — that would need add(), which is LLM-tier (see the
    // "list() includes a just-added memory" test for the content-level check). page/size are
    // checked as an exact echo of the request (37 chosen specifically to not collide with a
    // plausible server-side default like 10/20/50, so this is load-bearing even if the param were
    // silently ignored), which holds whether the store is empty or not.
    const page = await c.list({ page: 1, size: 37 });

    expect(page.page).toBe(1);
    expect(page.size).toBe(37);
    expect(page.total).toBeGreaterThanOrEqual(0);
    expect(page.items.length).toBeLessThanOrEqual(page.size);
  });

  it.skipIf(!Enabled)("delete() tolerates a nonexistent id", async () => {
    const c = newClient();

    // No add() involved — deleting an id that was never created needs only a store query matching
    // zero rows, not the LLM-gated write pipeline. Exercises delete()'s request/response mapping
    // without requiring the LLM tier.
    const msg = await c.delete([`does-not-exist-${RUN_TAG}`]);

    expect(msg.trim().length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM tier — needs CORTADEL_CONFORMANCE_URL *and* CORTADEL_CONFORMANCE_LLM, and the server itself
// configured with a working LLM provider (intent classification, conversation distillation) and
// embedding provider (vector search, dedup).
// ═══════════════════════════════════════════════════════════════════════════

describe("conformance (LLM tier)", () => {
  it.skipIf(!LlmTierEnabled)("add() then get() round-trips every field", async () => {
    const c = newClient();
    const text = `[conformance ${RUN_TAG}] ${vary(SEAT_FACTS)}`;

    const created = await c.add(text, { app: "conformance-suite", infer: false });
    createdIds.push(created.id);
    expect(created.id.trim().length).toBeGreaterThan(0);
    // MemoryCreated.createdAt is an ISO 8601 *string* on this endpoint (unlike list/detail, which
    // return Unix seconds — see src/models.ts) — assert it is both present and actually parses,
    // not just non-blank.
    expect(created.createdAt, "MemoryCreated.createdAt did not bind to a real value").toBeTruthy();
    expect(Number.isNaN(Date.parse(created.createdAt ?? "")), `MemoryCreated.createdAt '${created.createdAt}' is not a parseable ISO 8601 timestamp`).toBe(
      false,
    );
    // appName is one of the fields called out as historically mis-bound; assert it on the create
    // response directly, not only on the later get(). No `?? default` collision here —
    // mapMemoryCreated passes appName through unmodified, so null would fail this outright.
    expect(created.appName).toBe("conformance-suite");

    const got = await c.get(created.id);
    expect(got).not.toBeNull();
    expect(got!.text).toBe(text);
    // createdAt here is Unix seconds (MemoryDetailResponse) — the field the shipped SDK silently
    // read as 0 because of a wire-name/casing mismatch. `expect(x).not.toBeNull()` would pass right
    // through that regression; a plausible real value would not, and mapMemoryDetail's own `?? 0`
    // fallback can't collide with "plausible" the way it can with isGlobal/state below, since 0
    // always fails the range check.
    assertPlausibleUnixSeconds(got!.createdAt, "MemoryDetail.createdAt");
    expect(got!.appName).toBe("conformance-suite");

    // Facade-level observations: what a caller of get() actually sees. On their own these two
    // cannot distinguish a correct mapping from a silently-broken one for this suite's data —
    // mapMemoryDetail's `isGlobal: d.isGlobal ?? false` / `state: d.state ?? "active"` defaults
    // happen to equal what a genuinely personal, active memory looks like. The raw-wire cross-check
    // right after this is the actual regression detector for these two fields; see "Raw-wire
    // cross-checks" above.
    expect(got!.isGlobal).toBe(false);
    expect(got!.state).toBe("active");

    const raw = await getRaw(`/api/v1/memories/${encodeURIComponent(created.id)}?user_id=${encodeURIComponent(USER)}`);
    assertWireBoolField(raw, "is_global", false, "MemoryDetailResponse");
    expect(Object.prototype.hasOwnProperty.call(raw, "state"), "MemoryDetailResponse: wire body has no 'state' key at all").toBe(true);
    expect(raw.state).toBe("active");
  });

  it.skipIf(!LlmTierEnabled)("list() includes a just-added memory", async () => {
    const c = newClient();
    const text = `[conformance ${RUN_TAG}] ${vary(PAGINATION_FACTS)}`;
    const created = await c.add(text, { app: "conformance-suite", infer: false });
    createdIds.push(created.id);

    // Size at the documented max (100) so the item we just added (newest-first sort) is guaranteed
    // to land on page 1 regardless of how much history a persistent store has.
    const page = await c.list({ page: 1, size: 100 });

    const matches = page.items.filter((i) => i.id === created.id);
    expect(matches, `expected exactly one item with id ${created.id}`).toHaveLength(1);
    const item = matches[0]!;
    expect(item.content).toBe(text);
    assertPlausibleUnixSeconds(item.createdAt, "MemoryListItem.createdAt");
    // Facade-level observation only — see "Raw-wire cross-checks" above for why this alone cannot
    // catch a wire-name regression on is_global, and the real check right after it.
    expect(item.isGlobal).toBe(false);

    const raw = await getRaw(`/api/v1/memories?user_id=${encodeURIComponent(USER)}&page=1&size=100`);
    const rawItems = raw.items as Array<Record<string, unknown>>;
    const rawMatches = rawItems.filter((e) => e.id === created.id);
    expect(rawMatches).toHaveLength(1);
    assertWireBoolField(rawMatches[0]!, "is_global", false, "MemoryListItemResponse");
  });

  it.skipIf(!LlmTierEnabled)("search() returns scored hits", async () => {
    const c = newClient();
    const { fact, query } = vary(COLOUR_FACTS);
    const text = `[conformance ${RUN_TAG}] ${fact}`;
    const created = await c.add(text, { app: "conformance-suite", infer: false });
    createdIds.push(created.id);

    // topK at the documented max (50) so this doesn't flake against a busy persistent store where
    // our fresh memory might not land in a smaller top-K window.
    const r = await c.search(query, { topK: 50 });

    expect(r.results.length).toBeGreaterThan(0);
    const matches = r.results.filter((h) => h.content === text);
    expect(matches, `expected exactly one hit with content "${text}"`).toHaveLength(1);
    const hit = matches[0]!;
    // rrfScore is the field the shipped SDK pinned to the wrong wire name and always read as null.
    // The contract declares it a required, non-nullable number — a real hit must carry a real,
    // plausible score. No `?? default` here (mapSearchHit passes rrfScore through unmodified), so
    // this genuinely can't be satisfied by a coalesced fallback.
    expect(hit.rrfScore, "rrf_score did not bind — naming regression").not.toBeNull();
    expect(hit.rrfScore, "rrf_score did not bind — naming regression").not.toBeUndefined();
    expect(hit.rrfScore!, `rrf_score = ${hit.rrfScore} is not a plausible fused score`).toBeGreaterThan(0);
    expect(hit.appName).toBe("conformance-suite");
    // Facade-level observation only — see "Raw-wire cross-checks" above.
    expect(hit.isGlobal).toBe(false);

    const raw = await postRaw("/api/v1/memories/search", { query, user_id: USER, top_k: 50 });
    const rawResults = raw.results as Array<Record<string, unknown>>;
    const rawMatches = rawResults.filter((e) => e.content === text);
    expect(rawMatches).toHaveLength(1);
    // Trap: this schema's flag is `global`, not `is_global` (MemoryListItem/MemoryDetail use
    // `is_global` instead) — mirrors the same asymmetry the .NET leg's conformance suite caught.
    assertWireBoolField(rawMatches[0]!, "global", false, "HybridSearchResult");
  });

  it.skipIf(!LlmTierEnabled)("addConversation() returns results", async () => {
    const c = newClient();

    const r = await c.addConversation(
      [
        { role: "user", content: `[conformance ${RUN_TAG}] ${vary(ALLERGY_FACTS)}` },
        { role: "assistant", content: "Noted." },
      ],
      { sessionId: `conformance-${RUN_TAG}` },
    );

    if (r.results) {
      for (const item of r.results) {
        if (item.id && item.id.trim().length > 0) createdIds.push(item.id);
      }
    }

    // The shipped SDK invented a stored/skipped/ids shape that never existed on the wire. The real
    // contract is `results` XOR `noFactsExtracted` (one entry per distilled fact, or a flag that
    // nothing was extracted) — never both, per ConversationResult's documented invariant. Exactly
    // how many facts a conversation distills into depends on the conformance server's own LLM
    // extraction, which this suite does not control — so this checks the *shape* is the real one,
    // not an exact fact count.
    if (r.noFactsExtracted === true) {
      expect(r.results).toBeFalsy();
    } else {
      expect(r.results).toBeTruthy();
      expect(r.results!.length).toBeGreaterThan(0);
      for (const item of r.results!) {
        expect(item.event?.trim().length ?? 0).toBeGreaterThan(0);
        // memory (the distilled fact text) is only guaranteed populated on a non-ERROR event; an
        // ERROR item instead carries `error`, per ConversationIngestItem's docs.
        if (item.event !== "ERROR") {
          expect(item.memory?.trim().length ?? 0).toBeGreaterThan(0);
          expect(item.id?.trim().length ?? 0, "id did not bind to a real value — naming regression").toBeGreaterThan(0);
        }
      }
    }
  });

  it.skipIf(!LlmTierEnabled)("delete() removes a memory", async () => {
    const c = newClient();
    const text = `[conformance ${RUN_TAG}] ${vary(DELETION_FACTS)}`;
    const created = await c.add(text, { app: "conformance-suite", infer: false });
    createdIds.push(created.id); // redundant safety net; the explicit delete below already removes it

    const msg = await c.delete([created.id]);

    expect(msg.trim().length).toBeGreaterThan(0);
    // The real behavioral proof, not just trusting the confirmation string: the memory must
    // actually be gone.
    await expect(c.get(created.id)).resolves.toBeNull();
  });
});
