using System.Text.Json;
using Cortadel.Sdk;

namespace Cortadel.Sdk.Tests;

public class ModelsTests
{
    private static readonly JsonSerializerOptions Wire = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    [Fact]
    public void SearchHit_ReadsRrfScoreFromTheWireName()
    {
        // The shipped SDK pinned this to "rrfScore" with an explicit attribute,
        // so it was always null - including in the README's headline example.
        var hit = JsonSerializer.Deserialize<SearchHit>(
            """{"id":"m1","content":"hello","rrf_score":0.42}""", Wire)!;

        Assert.Equal(0.42, hit.RrfScore);
    }

    [Fact]
    public void MemoryDetail_ReadsSnakeCaseFields()
    {
        var d = JsonSerializer.Deserialize<MemoryDetail>(
            """{"id":"m1","text":"t","created_at":1700000000,"app_name":"cli","is_global":true}""",
            Wire)!;

        Assert.Equal(1700000000, d.CreatedAt);
        Assert.Equal("cli", d.AppName);
        Assert.True(d.IsGlobal);
    }

    [Fact]
    public void ConversationResult_ReadsTheShapeTheServerActuallyEmits()
    {
        // The shipped SDK declared Stored/Skipped/Ids, which the server never emits.
        var r = JsonSerializer.Deserialize<ConversationResult>(
            """{"results":[{"id":"m1","memory":"fact","event":"ADD"}]}""", Wire)!;

        Assert.Single(r.Results!);
        Assert.Equal("m1", r.Results![0].Id);
        Assert.Equal("ADD", r.Results[0].Event);
        Assert.Null(r.NoFactsExtracted);
    }

    [Fact]
    public void ConversationItem_CarriesTheErrorDiagnostic()
    {
        var r = JsonSerializer.Deserialize<ConversationResult>(
            """{"results":[{"memory":"f","event":"ERROR","error":"Bulk insert failed"}]}""", Wire)!;

        Assert.Equal("Bulk insert failed", r.Results![0].Error);
    }

    [Fact]
    public void SearchOptions_DoesNotExposeDetail()
    {
        // detail=summary|headline returns a shape the 1.0.0 contract cannot represent.
        Assert.Null(typeof(SearchOptions).GetProperty("Detail"));
    }

    // ── Regression coverage added on review: every corrected/added property below is
    //    exercised with a JSON literal built from spec/openapi.json's wire names (never
    //    from the DTO's C# names), asserting real values so a future edit that silently
    //    reintroduces an invisible-wire-name bug fails a test. ──────────────────────────

    [Fact]
    public void MemoryCreated_ReadsSnakeCaseFields()
    {
        var m = JsonSerializer.Deserialize<MemoryCreated>(
            """
            {"id":"m1","content":"hello","state":"active","created_at":"2024-01-01T00:00:00Z",
             "event":"ADD","app_name":"cli","metadata":"{\"k\":\"v\"}"}
            """, Wire)!;

        Assert.Equal("2024-01-01T00:00:00Z", m.CreatedAt);
        Assert.Equal("cli", m.AppName);
        Assert.Equal("{\"k\":\"v\"}", m.Metadata);
    }

    [Fact]
    public void SearchHit_ReadsGlobalFlagFromTheWireName()
    {
        // The wire key is "global", not "is_global" (that name is only used on the
        // list/detail schemas) - the C# member name and the wire name genuinely differ here.
        var globalHit = JsonSerializer.Deserialize<SearchHit>(
            """{"id":"m1","content":"c","global":true}""", Wire)!;
        var personalHit = JsonSerializer.Deserialize<SearchHit>(
            """{"id":"m2","content":"c","global":false}""", Wire)!;

        Assert.True(globalHit.IsGlobal);
        Assert.False(personalHit.IsGlobal);
    }

    [Fact]
    public void SearchHit_ReadsTheRemainingNewlyAddedFields()
    {
        var hit = JsonSerializer.Deserialize<SearchHit>(
            """
            {
              "id":"m1","content":"c",
              "created_at":"2024-01-01T00:00:00Z",
              "app_name":"cli",
              "memory_type":"semantic",
              "gist":"a short gist",
              "project_id":"proj-1",
              "member_ids":["m2","m3"],
              "similar_ids":["m4"],
              "text_rank":2,
              "vector_rank":5,
              "attributes":{"confidence_band":"high"}
            }
            """, Wire)!;

        Assert.Equal("2024-01-01T00:00:00Z", hit.CreatedAt);
        Assert.Equal("cli", hit.AppName);
        Assert.Equal("semantic", hit.MemoryType);
        Assert.Equal("a short gist", hit.Gist);
        Assert.Equal("proj-1", hit.ProjectId);
        Assert.Equal(new[] { "m2", "m3" }, hit.MemberIds);
        Assert.Equal(new[] { "m4" }, hit.SimilarIds);
        Assert.Equal(2, hit.TextRank);
        Assert.Equal(5, hit.VectorRank);
        Assert.Equal("high", hit.Attributes!["confidence_band"]!.Value.GetString());
    }

    [Fact]
    public void MemoryListItem_ReadsSnakeCaseFields()
    {
        var item = JsonSerializer.Deserialize<MemoryListItem>(
            """
            {
              "id":"m1","content":"c","state":"active",
              "created_at":1700000000,
              "app_id":"app-1",
              "app_name":"cli",
              "memory_type":"semantic",
              "extraction_status":"done",
              "valid_at":"2024-01-01T00:00:00Z",
              "invalid_at":"2024-02-01T00:00:00Z",
              "is_current":false,
              "is_global":true
            }
            """, Wire)!;

        Assert.Equal(1700000000L, item.CreatedAt);
        Assert.Equal("app-1", item.AppId);
        Assert.Equal("cli", item.AppName);
        Assert.Equal("semantic", item.MemoryType);
        Assert.Equal("done", item.ExtractionStatus);
        Assert.Equal("2024-01-01T00:00:00Z", item.ValidAt);
        Assert.Equal("2024-02-01T00:00:00Z", item.InvalidAt);
        Assert.False(item.IsCurrent);
        Assert.True(item.IsGlobal);
    }

    [Fact]
    public void MemoryDetail_ReadsTheRemainingSnakeCaseFields()
    {
        var d = JsonSerializer.Deserialize<MemoryDetail>(
            """
            {
              "id":"m1","text":"t","state":"active",
              "app_id":"app-1",
              "valid_at":"2024-01-01T00:00:00Z",
              "invalid_at":"2024-02-01T00:00:00Z",
              "is_current":false,
              "superseded_by":"m2"
            }
            """, Wire)!;

        Assert.Equal("app-1", d.AppId);
        Assert.Equal("2024-01-01T00:00:00Z", d.ValidAt);
        Assert.Equal("2024-02-01T00:00:00Z", d.InvalidAt);
        Assert.False(d.IsCurrent);
        Assert.Equal("m2", d.SupersededBy);
    }

    [Fact]
    public void HealthResult_BindsChecksDirectlyNotUnderANestedChecksKey()
    {
        // The shipped SDK marked Checks with [JsonExtensionData], which excludes a property
        // from name-based binding entirely - so the real "checks" object landed one level
        // too deep, as Checks["checks"], instead of Checks itself holding the per-dependency map.
        var h = JsonSerializer.Deserialize<HealthResult>(
            """
            {"status":"ok","checked_at":"2024-01-01T00:00:00Z",
             "checks":{"memgraph":{"ok":true},"embeddings":{"ok":true}}}
            """, Wire)!;

        Assert.Equal("ok", h.Status);
        Assert.Equal("2024-01-01T00:00:00Z", h.CheckedAt);
        Assert.True(h.Checks!.ContainsKey("memgraph"));
        Assert.False(h.Checks.ContainsKey("checks"));
        Assert.True(h.Checks["memgraph"].GetProperty("ok").GetBoolean());
    }

    [Fact]
    public void HealthResult_ChecksStillBindsCorrectlyWithUnknownFieldsPresent()
    {
        // Regression guard for the exact combination that broke before: Checks must bind by
        // name even when the extension-data catch-all is simultaneously absorbing other keys.
        var h = JsonSerializer.Deserialize<HealthResult>(
            """
            {"status":"degraded","checks":{"memgraph":{"ok":false,"error":"timeout"}},
             "future_field":"something new"}
            """, Wire)!;

        Assert.Equal("degraded", h.Status);
        Assert.True(h.Checks!.ContainsKey("memgraph"));
        Assert.False(h.Checks["memgraph"].GetProperty("ok").GetBoolean());
        Assert.Equal("timeout", h.Checks["memgraph"].GetProperty("error").GetString());
        Assert.Equal("something new", h.Extra!["future_field"].GetString());
    }
}
