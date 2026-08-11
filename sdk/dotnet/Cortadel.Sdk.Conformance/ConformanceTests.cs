using System.Linq;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Cortadel.Sdk;

namespace Cortadel.Sdk.Conformance;

/// <summary>
/// Runs every <see cref="CortadelClient"/> facade method against a real Cortadel server.
/// Skipped unless <c>CORTADEL_CONFORMANCE_URL</c> is set, so <c>dotnet test</c> stays green with
/// no server configured (see <see cref="Enabled"/>).
///
/// This is the only gate in the repo that can catch a stale/wrong contract: unit tests exercise
/// the generated transport and the hand-written DTOs against each other, and both can agree while
/// still both disagreeing with the real server. That is exactly the defect that started this
/// project - the shipped SDK spoke camelCase to a snake_case server and every POST returned 400 -
/// and nothing in the unit suite could have caught it, because nothing there ever makes a real
/// HTTP call.
///
/// Assertions below deliberately check real values, not mere presence. The historical bugs this
/// suite exists to catch (a property bound to the wrong wire name) produce a silent default -
/// <c>0</c>, <c>""</c>, or <c>null</c> - which <c>Assert.NotNull</c>/<c>Assert.True(x != null)</c>
/// would pass right through. Numeric timestamps are checked against a plausible range (not just
/// <c>&gt; 0</c>) so a unit mixup (e.g. milliseconds silently substituted for seconds) would also
/// fail loudly instead of accidentally satisfying a weaker bound.
///
/// Two tiers, gated by two independent environment variables:
///  - **No-LLM tier** (<see cref="Enabled"/>, i.e. <c>CORTADEL_CONFORMANCE_URL</c> alone): needs
///    only a Memgraph-backed server. <see cref="Health_ReportsAStatus"/>,
///    <see cref="Get_ReturnsNullForAMissingMemory"/>, <see cref="List_Paginates"/>,
///    <see cref="Delete_ToleratesANonexistentId"/>.
///  - **LLM tier** (<see cref="LlmTierEnabled"/>, i.e. <c>CORTADEL_CONFORMANCE_URL</c> *and*
///    <c>CORTADEL_CONFORMANCE_LLM</c>): every <c>AddAsync</c>/<c>AddConversationAsync</c> call
///    routes through the server's LLM-gated write pipeline (intent classification runs
///    regardless of the <c>Infer</c> flag - see <see cref="AddOptions.Infer"/>'s doc comment),
///    and <c>SearchAsync</c> needs a working embedding provider for the vector arm and the query
///    embedding. <see cref="Add_Then_Get_RoundTripsEveryField"/>,
///    <see cref="List_IncludesAJustAddedMemory"/>, <see cref="Search_ReturnsScoredHits"/>,
///    <see cref="AddConversation_ReturnsResults"/>, <see cref="Delete_RemovesAMemory"/>.
/// See the task report's "Provisioning requirements" section for exactly what each tier needs.
/// </summary>
public class ConformanceTests : IAsyncLifetime
{
    private static string? Url => Environment.GetEnvironmentVariable("CORTADEL_CONFORMANCE_URL");
    private static bool Enabled => !string.IsNullOrWhiteSpace(Url);

    // Second, independent gate for the LLM-dependent tier (see the class doc comment). Any
    // non-blank value turns it on - same convention as Enabled/Url - the content doesn't matter,
    // only presence, so PR CI can leave it entirely unset while a nightly job sets it.
    private static bool LlmTierEnabled =>
        Enabled && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CORTADEL_CONFORMANCE_LLM"));

    // Every user id in this suite is test-scoped. Never "serhii" or any other real identity -
    // this suite writes real data to whatever server CORTADEL_CONFORMANCE_URL points at, and
    // "e2e-*" is the project-wide convention marking data as disposable test/E2E data.
    private const string User = "e2e-dotnet-sdk-conformance";

    // A single per-process tag, computed once and folded into every piece of content this suite
    // writes. Two distinct goals, one value:
    //
    //  1. Uniqueness *across runs* against a persistent server (see also the teardown and
    //     content-variation notes below, which handle the semantic-dedup side of this same
    //     concern).
    //  2. Determinism *within* a run. Guid.NewGuid() would satisfy goal 1 just as well, but
    //     invites a real trap for goal 2: call it twice inside the same test (once to build the
    //     text you Add, once - by mistake - to build the query you later Search for) and you
    //     silently get two different values; the test then fails for a reason that has nothing
    //     to do with the SDK under test. A single timestamp captured once into a
    //     `static readonly` field removes that failure mode by construction, and is more useful
    //     than an opaque Guid when eyeballing server-side logs or rows while debugging a real
    //     conformance failure - it sorts and reads as "when this run happened".
    private static readonly long RunTagValue = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static readonly string RunTag = RunTagValue.ToString();

    private static CortadelClient NewClient() =>
        new(Url!, User, Environment.GetEnvironmentVariable("CORTADEL_CONFORMANCE_KEY"));

    // Deterministic pick from a small set of alternatives, keyed off the run's own timestamp -
    // see "Content this suite writes" below for why this exists alongside RunTag rather than
    // instead of it.
    private static T Vary<T>(T[] choices) => choices[(int)(RunTagValue % choices.Length)];

    // Guards against a unit mixup (e.g. milliseconds silently substituted for seconds, which
    // would produce a value ~1000x too large) in addition to the "did it bind at all" check.
    // 1700000000 is 2023-11-14T22:13:20Z - safely in the past for any real server clock. The
    // +300s upper-bound slack is deliberately generous (not tight to "just now") to tolerate
    // ordinary clock skew between the machine running the tests and a containerized server -
    // this check exists to catch a unit/naming bug that misses by orders of magnitude, not to
    // pin down clock synchronization.
    private static void AssertPlausibleUnixSeconds(long value, string field)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.True(value > 1_700_000_000 && value <= now + 300,
            $"{field} = {value} is not a plausible Unix-seconds timestamp near now (naming/unit regression)");
    }

    // ── Content this suite writes ───────────────────────────────────────────────────────────
    //
    // Two independent defenses against the store's semantic dedup (cosine >= 0.85 candidate
    // check, then an LLM verdict - see CLAUDE.md's Write pipeline notes) confusing one run's
    // assertions with another run's leftover data on a persistent server:
    //
    //  1. DisposeAsync (below) deletes every memory this suite creates, so a run that completes
    //     normally leaves nothing behind for a later run to collide with, at all.
    //  2. Each fact below is chosen from a small set of genuinely different phrasings, not the
    //     same sentence with a trailing numeral swapped - a numeral-only difference is exactly
    //     the shape semantic dedup is built to catch, so RunTag alone would not have been a real
    //     defense for the window #1 can't cover (two runs racing before either's teardown
    //     completes, or a prior run killed mid-suite before its own teardown ran).
    //
    // Neither claims to make collision impossible; #1 handles the common (non-crashed,
    // non-concurrent) case completely, #2 narrows the window #1 can't cover. Query strings are
    // paired index-for-index with their fact so Search_ReturnsScoredHits's query always matches
    // whichever variant was actually stored.
    private static readonly string[] SeatFacts =
    {
        "I prefer window seats on long-haul flights",
        "I always choose aisle seats near the exit row",
        "I book bulkhead seats whenever legroom matters most",
        "I avoid middle seats unless traveling with family",
    };

    private static readonly (string Fact, string Query)[] ColourFacts =
    {
        ("My favourite colour is a specific shade of teal", "favourite colour specific shade of teal"),
        ("My favourite colour is burnt orange, never red", "favourite colour burnt orange"),
        ("My favourite colour is moss green in every room", "favourite colour moss green"),
        ("My favourite colour is dusty rose for stationery", "favourite colour dusty rose"),
    };

    private static readonly string[] AllergyFacts =
    {
        "I am allergic to peanuts",
        "I have a severe tree nut allergy",
        "I cannot eat shellfish because of an allergy",
        "I break out in hives around penicillin",
    };

    private static readonly string[] PaginationFacts =
    {
        "Memory written to verify the list endpoint returns it",
        "Entry stored to confirm pagination includes fresh rows",
        "Fact added to check the listing API surfaces new writes",
        "Row created to validate that list results include this run",
    };

    private static readonly string[] DeletionFacts =
    {
        "Temporary fact staged for deletion in this run",
        "Disposable memory created only to be deleted",
        "Scratch entry that this test immediately removes",
        "Throwaway fact this run deletes right after adding it",
    };

    // ── Teardown ─────────────────────────────────────────────────────────────────────────────

    // xUnit constructs a fresh ConformanceTests instance per test method (no shared fixture), so
    // this list only ever holds ids the *current* test created.
    private readonly List<string> _createdIds = new();

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        if (_createdIds.Count == 0 || !Enabled) return;
        try
        {
            using var c = NewClient();
            await c.DeleteAsync(_createdIds);
        }
        catch
        {
            // Best-effort cleanup: a teardown failure (transient network error, or an id the
            // test itself already deleted) must not mask the test's own pass/fail result, which
            // has already been determined by the time this runs - there is nothing more this
            // suite can do about a cleanup that didn't take.
        }
    }

    // ── Raw-wire cross-checks ────────────────────────────────────────────────────────────────
    //
    // CortadelClient's mapping coalesces several nullable wire fields to a default that happens
    // to equal what a *correct* response looks like for the data this suite creates (every
    // memory here is personal and active): `IsGlobal = ... ?? false` (MapDetail, MapListItem,
    // MapHit) and `State = ... ?? "active"` (MapDetail). A wire-name regression on
    // is_global/global/state would silently fall back to that same default - indistinguishable,
    // through the facade alone, from a correct mapping. `Assert.False(x.IsGlobal)` or
    // `Assert.Equal("active", x.State)` would pass either way. These helpers issue the identical
    // request through a bare HttpClient, bypassing CortadelClient's mapping entirely, and check
    // the raw JSON body directly, so a missing/renamed key fails loudly instead of being
    // absorbed by the coalesce.
    private static HttpClient NewRawHttpClient()
    {
        var http = new HttpClient { BaseAddress = new Uri(Url!) };
        var key = Environment.GetEnvironmentVariable("CORTADEL_CONFORMANCE_KEY");
        if (!string.IsNullOrWhiteSpace(key))
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return http;
    }

    private static async Task<JsonElement> GetRawAsync(string pathAndQuery)
    {
        using var http = NewRawHttpClient();
        using var res = await http.GetAsync(pathAndQuery);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStreamAsync());
        return doc.RootElement.Clone();
    }

    private static async Task<JsonElement> PostRawAsync(string path, object body)
    {
        using var http = NewRawHttpClient();
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var res = await http.PostAsync(path, content);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStreamAsync());
        return doc.RootElement.Clone();
    }

    private static void AssertWireBoolField(JsonElement obj, string key, bool expected, string context)
    {
        Assert.True(obj.TryGetProperty(key, out var prop), $"{context}: wire body has no '{key}' key at all");
        Assert.Equal(expected, prop.GetBoolean());
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // No-LLM tier - needs only CORTADEL_CONFORMANCE_URL (a Memgraph-backed server; no LLM or
    // embedding provider required).
    // ═══════════════════════════════════════════════════════════════════════════════════════

    [SkippableFact]
    public async Task Health_ReportsAStatus()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();

        var h = await c.HealthAsync();

        Assert.Contains(h.Status, new[] { "ok", "degraded" });
    }

    [SkippableFact]
    public async Task Get_ReturnsNullForAMissingMemory()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();

        Assert.Null(await c.GetAsync($"does-not-exist-{RunTag}"));
    }

    [SkippableFact]
    public async Task List_Paginates()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();

        // Deliberately does not seed data - that would need AddAsync, which is LLM-tier (see
        // List_IncludesAJustAddedMemory for the content-level check). Page/Size are checked as
        // an exact echo of the request (37 chosen specifically to not collide with a plausible
        // server-side default like 10/20/50, so this is load-bearing even if the param were
        // silently ignored), which holds whether the store is empty or not.
        var page = await c.ListAsync(new ListOptions { Page = 1, Size = 37 });

        Assert.Equal(1, page.Page);
        Assert.Equal(37, page.Size);
        Assert.True(page.Total >= 0);
        Assert.True(page.Items.Count <= page.Size);
    }

    [SkippableFact]
    public async Task Delete_ToleratesANonexistentId()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();

        // No AddAsync involved - deleting an id that was never created needs only a store query
        // matching zero rows, not the LLM-gated write pipeline. Exercises DeleteAsync's request/
        // response mapping without requiring the LLM tier.
        var msg = await c.DeleteAsync(new[] { $"does-not-exist-{RunTag}" });

        Assert.False(string.IsNullOrWhiteSpace(msg));
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // LLM tier - needs CORTADEL_CONFORMANCE_URL *and* CORTADEL_CONFORMANCE_LLM, and the server
    // itself configured with a working LLM provider (intent classification, conversation
    // distillation) and embedding provider (vector search, dedup).
    // ═══════════════════════════════════════════════════════════════════════════════════════

    [SkippableFact]
    public async Task Add_Then_Get_RoundTripsEveryField()
    {
        Skip.IfNot(LlmTierEnabled, "CORTADEL_CONFORMANCE_URL/CORTADEL_CONFORMANCE_LLM not set");
        using var c = NewClient();
        var text = $"[conformance {RunTag}] {Vary(SeatFacts)}";

        var created = await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });
        _createdIds.Add(created.Id);
        Assert.False(string.IsNullOrWhiteSpace(created.Id));
        // MemoryCreatedResponse.created_at is an ISO 8601 *string* on this endpoint (unlike
        // list/detail, which return Unix seconds - see Models.cs) - assert it is both present
        // and actually parses, not just non-blank.
        Assert.False(string.IsNullOrWhiteSpace(created.CreatedAt));
        Assert.True(DateTimeOffset.TryParse(created.CreatedAt, out _),
            $"MemoryCreated.CreatedAt '{created.CreatedAt}' is not a parseable ISO 8601 timestamp");
        // app_name is one of the fields called out as historically mis-bound; assert it on the
        // create response directly, not only on the later Get. No `?? default` collision here -
        // MapCreated passes AppName through unmodified, so null would fail this outright.
        Assert.Equal("conformance-suite", created.AppName);

        var got = await c.GetAsync(created.Id);
        Assert.NotNull(got);
        Assert.Equal(text, got!.Text);
        // created_at here is Unix seconds (MemoryDetailResponse) - the field the shipped SDK
        // silently read as 0 because of a wire-name/casing mismatch. Assert.NotNull would pass
        // right through that regression; a plausible real value would not, and MapDetail's own
        // `?? 0` fallback can't collide with "plausible" the way it can with IsGlobal/State
        // below, since 0 always fails the range check.
        AssertPlausibleUnixSeconds(got.CreatedAt, "MemoryDetail.CreatedAt");
        Assert.Equal("conformance-suite", got.AppName);

        // Facade-level observations: what a caller of GetAsync actually sees. On their own these
        // two cannot distinguish a correct mapping from a silently-broken one for this suite's
        // data - MapDetail's `IsGlobal = d.IsGlobal ?? false` / `State = d.State ?? "active"`
        // defaults happen to equal what a genuinely personal, active memory looks like. The
        // raw-wire cross-check right after this is the actual regression detector for these two
        // fields; see "Raw-wire cross-checks" above.
        Assert.False(got.IsGlobal);
        Assert.Equal("active", got.State);

        var raw = await GetRawAsync($"/api/v1/memories/{Uri.EscapeDataString(created.Id)}?user_id={Uri.EscapeDataString(User)}");
        AssertWireBoolField(raw, "is_global", expected: false, context: "MemoryDetailResponse");
        Assert.True(raw.TryGetProperty("state", out var rawState), "MemoryDetailResponse: wire body has no 'state' key at all");
        Assert.Equal("active", rawState.GetString());
    }

    [SkippableFact]
    public async Task List_IncludesAJustAddedMemory()
    {
        Skip.IfNot(LlmTierEnabled, "CORTADEL_CONFORMANCE_URL/CORTADEL_CONFORMANCE_LLM not set");
        using var c = NewClient();
        var text = $"[conformance {RunTag}] {Vary(PaginationFacts)}";
        var created = await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });
        _createdIds.Add(created.Id);

        // Size at the documented max (100) so the item we just added (newest-first sort) is
        // guaranteed to land on page 1 regardless of how much history a persistent store has.
        var page = await c.ListAsync(new ListOptions { Page = 1, Size = 100 });

        var item = Assert.Single(page.Items, i => i.Id == created.Id);
        Assert.Equal(text, item.Content);
        AssertPlausibleUnixSeconds(item.CreatedAt, "MemoryListItem.CreatedAt");
        // Facade-level observation only - see "Raw-wire cross-checks" above for why this alone
        // cannot catch a wire-name regression on is_global, and the real check right after it.
        Assert.False(item.IsGlobal);

        var raw = await GetRawAsync($"/api/v1/memories?user_id={Uri.EscapeDataString(User)}&page=1&size=100");
        var rawItem = raw.GetProperty("items").EnumerateArray().Single(e => e.GetProperty("id").GetString() == created.Id);
        AssertWireBoolField(rawItem, "is_global", expected: false, context: "MemoryListItemResponse");
    }

    [SkippableFact]
    public async Task Search_ReturnsScoredHits()
    {
        Skip.IfNot(LlmTierEnabled, "CORTADEL_CONFORMANCE_URL/CORTADEL_CONFORMANCE_LLM not set");
        using var c = NewClient();
        var (fact, query) = Vary(ColourFacts);
        var text = $"[conformance {RunTag}] {fact}";
        var created = await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });
        _createdIds.Add(created.Id);

        // TopK at the documented max (50) so this doesn't flake against a busy persistent store
        // where our fresh memory might not land in a smaller top-K window.
        var r = await c.SearchAsync(query, new SearchOptions { TopK = 50 });

        Assert.NotEmpty(r.Results);
        var hit = Assert.Single(r.Results, h => h.Content == text);
        // rrf_score is the field the shipped SDK pinned to the wrong wire name and always read
        // as null. The contract declares it a required, non-nullable number - a real hit must
        // carry a real, plausible score. No `?? default` here (MapHit passes RrfScore through
        // unmodified), so this genuinely can't be satisfied by a coalesced fallback.
        Assert.True(hit.RrfScore.HasValue, "rrf_score did not bind - naming regression");
        Assert.True(hit.RrfScore!.Value > 0, $"rrf_score = {hit.RrfScore} is not a plausible fused score");
        Assert.Equal("conformance-suite", hit.AppName);
        // Facade-level observation only - see "Raw-wire cross-checks" above.
        Assert.False(hit.IsGlobal);

        var raw = await PostRawAsync("/api/v1/memories/search", new { query, user_id = User, top_k = 50 });
        var rawHit = raw.GetProperty("results").EnumerateArray().Single(e => e.GetProperty("content").GetString() == text);
        AssertWireBoolField(rawHit, "global", expected: false, context: "HybridSearchResult");
    }

    [SkippableFact]
    public async Task AddConversation_ReturnsResults()
    {
        Skip.IfNot(LlmTierEnabled, "CORTADEL_CONFORMANCE_URL/CORTADEL_CONFORMANCE_LLM not set");
        using var c = NewClient();

        var r = await c.AddConversationAsync(new[]
        {
            new ChatMessage("user", $"[conformance {RunTag}] {Vary(AllergyFacts)}"),
            new ChatMessage("assistant", "Noted."),
        }, new ConversationOptions { SessionId = $"conformance-{RunTag}" });

        if (r.Results is not null)
            _createdIds.AddRange(r.Results.Where(i => !string.IsNullOrWhiteSpace(i.Id)).Select(i => i.Id!));

        // The shipped SDK invented a Stored/Skipped/Ids shape that never existed on the wire.
        // The real contract is Results (one entry per distilled fact) XOR NoFactsExtracted -
        // never both, per ConversationIngestResponse's documented invariant. Exactly how many
        // facts a conversation distills into depends on the conformance server's own LLM
        // extraction, which this suite does not control - so this checks the *shape* is the
        // real one, not an exact fact count.
        if (r.NoFactsExtracted == true)
        {
            Assert.Null(r.Results);
        }
        else
        {
            Assert.NotNull(r.Results);
            Assert.NotEmpty(r.Results!);
            foreach (var item in r.Results!)
            {
                Assert.False(string.IsNullOrWhiteSpace(item.Event));
                // Memory (the distilled fact text) is only guaranteed populated on a non-ERROR
                // event; an ERROR item instead carries Error, per ConversationIngestItem's docs.
                if (item.Event != "ERROR")
                {
                    Assert.False(string.IsNullOrWhiteSpace(item.Memory));
                    Assert.False(string.IsNullOrWhiteSpace(item.Id), "Id did not bind to a real value - naming regression");
                }
            }
        }
    }

    [SkippableFact]
    public async Task Delete_RemovesAMemory()
    {
        Skip.IfNot(LlmTierEnabled, "CORTADEL_CONFORMANCE_URL/CORTADEL_CONFORMANCE_LLM not set");
        using var c = NewClient();
        var text = $"[conformance {RunTag}] {Vary(DeletionFacts)}";
        var created = await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });
        _createdIds.Add(created.Id); // redundant safety net; the explicit delete below already removes it

        var msg = await c.DeleteAsync(new[] { created.Id });

        Assert.False(string.IsNullOrWhiteSpace(msg));
        // The real behavioral proof, not just trusting the confirmation string: the memory must
        // actually be gone.
        Assert.Null(await c.GetAsync(created.Id));
    }
}
