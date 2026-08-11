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
}
