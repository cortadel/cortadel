using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cortadel.Sdk;

// ── Requests & options ───────────────────────────────────────────────────

/// <summary>A single conversation turn passed to <see cref="CortadelClient.AddConversationAsync"/>.</summary>
/// <param name="Role">"user", "assistant", or "system".</param>
/// <param name="Content">Message text.</param>
/// <param name="Uuid">Optional producer-side turn id (kept as a pointer anchor on extracted facts).</param>
public sealed record ChatMessage(string Role, string Content, string? Uuid = null);

/// <summary>Options for <see cref="CortadelClient.AddAsync"/>.</summary>
public sealed class AddOptions
{
    /// <summary>App name that created the memory.</summary>
    public string? App { get; init; }

    /// <summary>Arbitrary metadata stored alongside the memory.</summary>
    public IDictionary<string, object?>? Metadata { get; init; }

    /// <summary>When <c>false</c>, store the text verbatim and skip background entity/category extraction (dedup still applies). Default <c>true</c>.</summary>
    public bool? Infer { get; init; }

    /// <summary>Optional cognitive-type pin: <c>episodic</c> | <c>semantic</c> | <c>procedural</c>. Invalid values are ignored (auto-classified).</summary>
    public string? MemoryType { get; init; }
}

/// <summary>Options for <see cref="CortadelClient.AddConversationAsync"/>.</summary>
public sealed class ConversationOptions
{
    /// <summary>When <c>true</c>, extract facts about the assistant instead of the user.</summary>
    public bool IsAgentMemory { get; init; }

    /// <summary>Tags applied to every extracted fact (for scoped retrieval).</summary>
    public string[]? Tags { get; init; }

    /// <summary>Optional project scope (e.g. a repo name).</summary>
    public string? Project { get; init; }

    /// <summary>Optional session id grouping the extracted facts.</summary>
    public string? SessionId { get; init; }

    /// <summary>Optional producer-local transcript path (stored as a pointer anchor).</summary>
    public string? TranscriptPath { get; init; }
}

/// <summary>Options for <see cref="CortadelClient.SearchAsync"/>.</summary>
public sealed class SearchOptions
{
    /// <summary>Maximum number of results (1–50). Default 10.</summary>
    public int TopK { get; init; } = 10;

    /// <summary>Search mode: <c>hybrid</c> (default), <c>text</c>, or <c>vector</c>.</summary>
    public string Mode { get; init; } = "hybrid";

    /// <summary>Restrict results to a session.</summary>
    public string? SessionId { get; init; }

    /// <summary>Set to <c>cross_encoder</c> to rerank with the local cross-encoder; omit to skip.</summary>
    public string? Rerank { get; init; }

    /// <summary>Filter by cognitive type: <c>episodic</c> | <c>semantic</c> | <c>procedural</c>.</summary>
    public string? MemoryType { get; init; }

    /// <summary>Response density tier: <c>full</c> (default), <c>summary</c>, or <c>headline</c>.</summary>
    public string Detail { get; init; } = "full";
}

/// <summary>Options for <see cref="CortadelClient.ListAsync"/>.</summary>
public sealed class ListOptions
{
    /// <summary>Page number (1-based). Default 1.</summary>
    public int Page { get; init; } = 1;

    /// <summary>Page size (max 100). Default 20.</summary>
    public int Size { get; init; } = 20;

    /// <summary>Filter by app id.</summary>
    public string? AppId { get; init; }

    /// <summary>Comma-separated category names to filter by.</summary>
    public string? Categories { get; init; }

    /// <summary>When set, runs a hybrid search instead of a plain list.</summary>
    public string? SearchQuery { get; init; }

    /// <summary>Include superseded (older) versions of memories.</summary>
    public bool IncludeSuperseded { get; init; }

    /// <summary>Filter by cognitive type.</summary>
    public string? MemoryType { get; init; }
}

// ── Responses ────────────────────────────────────────────────────────────

/// <summary>Result of storing a memory.</summary>
public sealed record MemoryCreated
{
    public string Id { get; init; } = "";
    public string? Content { get; init; }
    public string? State { get; init; }
    public string? CreatedAt { get; init; }

    /// <summary>What happened, e.g. <c>ADD</c> or <c>SKIP_DUPLICATE</c>.</summary>
    public string? Event { get; init; }
    public string? AppName { get; init; }
}

/// <summary>A page of search hits.</summary>
public sealed record SearchResults
{
    public string Query { get; init; } = "";
    public List<SearchHit> Results { get; init; } = new();
    public int Total { get; init; }
}

/// <summary>A single ranked search hit. Fields the server adds beyond these are available in <see cref="Extra"/>.</summary>
public sealed record SearchHit
{
    public string Id { get; init; } = "";
    public string Content { get; init; } = "";

    /// <summary>Fused relevance score (RRF, sqrt-normalized).</summary>
    [JsonPropertyName("rrfScore")] public double? RrfScore { get; init; }
    public string? CreatedAt { get; init; }
    public string? AppName { get; init; }
    public List<string>? Categories { get; init; }
    public string? MemoryType { get; init; }
    public List<string>? Tags { get; init; }

    /// <summary><c>personal</c> or <c>global</c> — where the hit came from.</summary>
    public string? Source { get; init; }

    /// <summary>Any additional fields the server returned (e.g. confidence_band, anchors).</summary>
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; init; }
}

/// <summary>A paginated list of memories.</summary>
public sealed record MemoryList
{
    public List<MemoryListItem> Items { get; init; } = new();
    public int Total { get; init; }
    public int Page { get; init; }
    public int Size { get; init; }
    public int Pages { get; init; }
}

/// <summary>A memory in a list response.</summary>
public sealed record MemoryListItem
{
    public string Id { get; init; } = "";
    public string Content { get; init; } = "";

    /// <summary>Creation time as Unix seconds.</summary>
    public long CreatedAt { get; init; }
    public string State { get; init; } = "active";
    public string? AppId { get; init; }
    public string? AppName { get; init; }
    public List<string> Categories { get; init; } = new();
    public string? MemoryType { get; init; }

    /// <summary><c>true</c> when this is a globally-shared memory owned by another user.</summary>
    public bool IsGlobal { get; init; }

    [JsonPropertyName("metadata_")] public JsonElement? Metadata { get; init; }
}

/// <summary>A single memory (from <see cref="CortadelClient.GetAsync"/>). Note the content field is <see cref="Text"/>.</summary>
public sealed record MemoryDetail
{
    public string Id { get; init; } = "";
    public string Text { get; init; } = "";

    /// <summary>Creation time as Unix seconds.</summary>
    public long CreatedAt { get; init; }
    public string State { get; init; } = "active";
    public string? AppId { get; init; }
    public string? AppName { get; init; }
    public List<string> Categories { get; init; } = new();
    [JsonPropertyName("metadata_")] public JsonElement? Metadata { get; init; }
    public string? ValidAt { get; init; }
    public string? InvalidAt { get; init; }
    public bool? IsCurrent { get; init; }
    public string? SupersededBy { get; init; }
    public bool IsGlobal { get; init; }
}

/// <summary>Result of ingesting a conversation. Uncommon fields land in <see cref="Raw"/>.</summary>
public sealed record ConversationResult
{
    public int? Stored { get; init; }
    public int? Skipped { get; init; }
    public List<string>? Ids { get; init; }

    /// <summary>Any additional fields the server returned.</summary>
    [JsonExtensionData] public Dictionary<string, JsonElement>? Raw { get; init; }
}

/// <summary>Server health snapshot.</summary>
public sealed record HealthResult
{
    /// <summary>Overall status, e.g. <c>healthy</c> or <c>degraded</c>.</summary>
    public string Status { get; init; } = "";
    public string? CheckedAt { get; init; }

    /// <summary>Per-dependency check details (database, embeddings, indexes).</summary>
    [JsonExtensionData] public Dictionary<string, JsonElement>? Checks { get; init; }
}

internal sealed record MessageResult
{
    public string Message { get; init; } = "";
}

/// <summary>A structured error returned by the server.</summary>
public sealed record ApiError
{
    public int Status { get; init; }
    public string Code { get; init; } = "error";
    public string Message { get; init; } = "An error occurred";
    public string? Detail { get; init; }
}
