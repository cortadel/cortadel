using System.Linq;
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
/// </summary>
public class ConformanceTests
{
    private static string? Url => Environment.GetEnvironmentVariable("CORTADEL_CONFORMANCE_URL");
    private static bool Enabled => !string.IsNullOrWhiteSpace(Url);

    // Every user id in this suite is test-scoped. Never "serhii" or any other real identity -
    // this suite writes real data to whatever server CORTADEL_CONFORMANCE_URL points at, and
    // "e2e-*" is the project-wide convention marking data as disposable test/E2E data.
    private const string User = "e2e-dotnet-sdk-conformance";

    // A single per-process tag, computed once and folded into every piece of content this suite
    // writes. Two distinct goals, one value:
    //
    //  1. Uniqueness *across runs* against a persistent server. CI (Task 5) starts a fresh,
    //     throwaway service container per job, so this mostly matters for a developer running
    //     the suite repeatedly against a long-lived local instance - without it, a second run's
    //     "assert this exact content came back" checks could match a row an earlier run left
    //     behind instead of (or in addition to) the row this run just wrote, and the store's
    //     dedup pipeline (cosine >= 0.85 candidate + LLM verdict) could also treat repeated
    //     identical content as a candidate duplicate of itself across runs.
    //
    //  2. Determinism *within* a run. Guid.NewGuid() would satisfy goal 1 just as well, but
    //     invites a real trap for goal 2: call it twice inside the same test (once to build the
    //     text you Add, once - by mistake - to build the query you later Search for) and you
    //     silently get two different values; the test then fails for a reason that has nothing
    //     to do with the SDK under test. A single timestamp captured once into a
    //     `static readonly` field removes that failure mode by construction (every test reads
    //     the same field, there is nothing left to accidentally re-roll), and is more useful than
    //     an opaque Guid when eyeballing server-side logs or rows while debugging a real
    //     conformance failure - it sorts and reads as "when this run happened".
    //
    // This is not cryptographically unique, but two conformance runs colliding on the same
    // millisecond is not a realistic concern for what this suite is for.
    private static readonly string RunTag = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();

    private static CortadelClient NewClient() =>
        new(Url!, User, Environment.GetEnvironmentVariable("CORTADEL_CONFORMANCE_KEY"));

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

    // ── HealthAsync ──────────────────────────────────────────────────────────────────────────

    [SkippableFact]
    public async Task Health_ReportsAStatus()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();

        var h = await c.HealthAsync();

        Assert.Contains(h.Status, new[] { "ok", "degraded" });
    }

    // ── AddAsync + GetAsync ──────────────────────────────────────────────────────────────────

    [SkippableFact]
    public async Task Add_Then_Get_RoundTripsEveryField()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();
        var text = $"[conformance {RunTag}] I prefer window seats on long flights";

        var created = await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });
        Assert.False(string.IsNullOrWhiteSpace(created.Id));
        // MemoryCreatedResponse.created_at is an ISO 8601 *string* on this endpoint (unlike
        // list/detail, which return Unix seconds - see Models.cs) - assert it is both present
        // and actually parses, not just non-blank.
        Assert.False(string.IsNullOrWhiteSpace(created.CreatedAt));
        Assert.True(DateTimeOffset.TryParse(created.CreatedAt, out _),
            $"MemoryCreated.CreatedAt '{created.CreatedAt}' is not a parseable ISO 8601 timestamp");
        // app_name is one of the fields called out as historically mis-bound; assert it on the
        // create response directly, not only on the later Get.
        Assert.Equal("conformance-suite", created.AppName);

        var got = await c.GetAsync(created.Id);
        Assert.NotNull(got);
        Assert.Equal(text, got!.Text);
        // created_at here is Unix seconds (MemoryDetailResponse) - the field the shipped SDK
        // silently read as 0 because of a wire-name/casing mismatch. Assert.NotNull would pass
        // right through that regression; a plausible real value would not.
        AssertPlausibleUnixSeconds(got.CreatedAt, "MemoryDetail.CreatedAt");
        Assert.Equal("conformance-suite", got.AppName);
        Assert.False(got.IsGlobal, "a memory just created by this user must not be global");
        Assert.Equal("active", got.State);
    }

    [SkippableFact]
    public async Task Get_ReturnsNullForAMissingMemory()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();

        Assert.Null(await c.GetAsync($"does-not-exist-{RunTag}"));
    }

    // ── SearchAsync ──────────────────────────────────────────────────────────────────────────

    [SkippableFact]
    public async Task Search_ReturnsScoredHits()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();
        var text = $"[conformance {RunTag}] My favourite colour is a specific shade of teal";
        await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });

        // TopK at the documented max (50) so this doesn't flake against a busy persistent store
        // where our fresh memory might not land in a smaller top-K window.
        var r = await c.SearchAsync("favourite colour specific shade of teal", new SearchOptions { TopK = 50 });

        Assert.NotEmpty(r.Results);
        var hit = Assert.Single(r.Results, h => h.Content == text);
        // rrf_score is the field the shipped SDK pinned to the wrong wire name and always read
        // as null. The contract declares it a required, non-nullable number - a real hit must
        // carry a real, plausible score, not merely "the property deserialized to *something*".
        Assert.True(hit.RrfScore.HasValue, "rrf_score did not bind - naming regression");
        Assert.True(hit.RrfScore!.Value > 0, $"rrf_score = {hit.RrfScore} is not a plausible fused score");
        Assert.Equal("conformance-suite", hit.AppName);
        Assert.False(hit.IsGlobal, "a hit owned by this same test user must not be flagged global");
    }

    // ── ListAsync ────────────────────────────────────────────────────────────────────────────

    [SkippableFact]
    public async Task List_Paginates()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();
        var text = $"[conformance {RunTag}] Memory for list pagination check";
        var created = await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });

        // Size at the documented max (100) so the item we just added (newest-first sort) is
        // guaranteed to land on page 1 regardless of how much history a persistent store has.
        var page = await c.ListAsync(new ListOptions { Page = 1, Size = 100 });

        Assert.Equal(1, page.Page);
        // size/total are the fields the shipped SDK historically mis-bound to 0 via a wrong
        // wire name; assert real values rather than non-nullness.
        Assert.True(page.Size > 0, "size did not bind to a real value - naming regression");
        Assert.True(page.Total > 0, "total did not bind to a real value - naming regression");

        var item = Assert.Single(page.Items, i => i.Id == created.Id);
        Assert.Equal(text, item.Content);
        AssertPlausibleUnixSeconds(item.CreatedAt, "MemoryListItem.CreatedAt");
        Assert.False(item.IsGlobal, "a memory just created by this user must not be global");
    }

    // ── AddConversationAsync ─────────────────────────────────────────────────────────────────

    [SkippableFact]
    public async Task AddConversation_ReturnsResults()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();

        var r = await c.AddConversationAsync(new[]
        {
            new ChatMessage("user", $"[conformance {RunTag}] I am allergic to peanuts"),
            new ChatMessage("assistant", "Noted."),
        }, new ConversationOptions { SessionId = $"conformance-{RunTag}" });

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

    // ── DeleteAsync ──────────────────────────────────────────────────────────────────────────

    [SkippableFact]
    public async Task Delete_RemovesAMemory()
    {
        Skip.IfNot(Enabled, "CORTADEL_CONFORMANCE_URL not set");
        using var c = NewClient();
        var text = $"[conformance {RunTag}] Temporary fact for deletion";
        var created = await c.AddAsync(text, new AddOptions { App = "conformance-suite", Infer = false });

        var msg = await c.DeleteAsync(new[] { created.Id });

        Assert.False(string.IsNullOrWhiteSpace(msg));
        // The real behavioral proof, not just trusting the confirmation string: the memory must
        // actually be gone.
        Assert.Null(await c.GetAsync(created.Id));
    }
}
