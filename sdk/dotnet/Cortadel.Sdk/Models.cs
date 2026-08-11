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

    /// <summary>ISO 8601 creation timestamp (this endpoint returns a string; list/detail return Unix seconds).</summary>
    [JsonPropertyName("created_at")] public string? CreatedAt { get; init; }

    /// <summary>What happened, e.g. <c>ADD</c> or <c>SKIP_DUPLICATE</c>.</summary>
    public string? Event { get; init; }

    [JsonPropertyName("app_name")] public string? AppName { get; init; }

    /// <summary>Metadata as a JSON string (not a nested object, unlike <see cref="MemoryDetail.Metadata"/>).</summary>
    public string? Metadata { get; init; }
}

/// <summary>A page of search hits.</summary>
public sealed record SearchResults
{
    public string Query { get; init; } = "";
    public List<SearchHit> Results { get; init; } = new();
    public int Total { get; init; }
}

/// <summary>A single ranked search hit.</summary>
public sealed record SearchHit
{
    public string Id { get; init; } = "";
    public string Content { get; init; } = "";

    /// <summary>Fused relevance score (RRF, sqrt-normalized).</summary>
    [JsonPropertyName("rrf_score")] public double? RrfScore { get; init; }

    [JsonPropertyName("created_at")] public string? CreatedAt { get; init; }
    [JsonPropertyName("app_name")] public string? AppName { get; init; }
    public List<string>? Categories { get; init; }
    [JsonPropertyName("memory_type")] public string? MemoryType { get; init; }
    public List<string>? Tags { get; init; }

    /// <summary><c>personal</c> or <c>global</c> — where the hit came from.</summary>
    public string? Source { get; init; }

    /// <summary><c>true</c> when this hit is a globally-shared memory owned by another user.</summary>
    [JsonPropertyName("global")] public bool IsGlobal { get; init; }

    /// <summary>One-line distilled gist of the memory, when the server computed one.</summary>
    public string? Gist { get; init; }

    [JsonPropertyName("project_id")] public string? ProjectId { get; init; }

    /// <summary>Member memory ids folded into this hit (session-arm rollups).</summary>
    [JsonPropertyName("member_ids")] public List<string>? MemberIds { get; init; }

    /// <summary>Ids of similar/duplicate memories, when computed.</summary>
    [JsonPropertyName("similar_ids")] public List<string>? SimilarIds { get; init; }

    /// <summary>Rank within the text (BM25) arm before fusion, if this hit matched it.</summary>
    [JsonPropertyName("text_rank")] public int? TextRank { get; init; }

    /// <summary>Rank within the vector arm before fusion, if this hit matched it.</summary>
    [JsonPropertyName("vector_rank")] public int? VectorRank { get; init; }

    /// <summary>Freeform attributes attached to this hit (e.g. confidence_band, anchors).</summary>
    public Dictionary<string, JsonElement?>? Attributes { get; init; }

    /// <summary>
    /// Always <c>null</c> on a <see cref="SearchHit"/> returned by <see cref="CortadelClient"/>:
    /// its pipeline deserializes via the generated <c>HybridSearchResult</c>, which does not
    /// implement <c>IAdditionalDataHolder</c>, before mapping to this type, so fields the server
    /// adds beyond the ones already mapped above never reach this bag. (The
    /// <c>[JsonExtensionData]</c> attribute itself still works as documented if you deserialize
    /// this DTO directly with <c>System.Text.Json</c>, bypassing <see cref="CortadelClient"/> -
    /// that path just isn't how any value from this client reaches you.) Kept for source
    /// compatibility only; do not rely on it for values from <see cref="CortadelClient"/>.
    /// </summary>
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
    [JsonPropertyName("created_at")] public long CreatedAt { get; init; }
    public string State { get; init; } = "active";
    [JsonPropertyName("app_id")] public string? AppId { get; init; }
    [JsonPropertyName("app_name")] public string? AppName { get; init; }
    public List<string> Categories { get; init; } = new();
    [JsonPropertyName("memory_type")] public string? MemoryType { get; init; }

    /// <summary>Extraction pipeline status: <c>done</c>, <c>pending</c>, or <c>failed</c>.</summary>
    [JsonPropertyName("extraction_status")] public string? ExtractionStatus { get; init; }

    /// <summary>ISO 8601 timestamp from which this memory version is valid.</summary>
    [JsonPropertyName("valid_at")] public string? ValidAt { get; init; }

    /// <summary>ISO 8601 timestamp at which this memory was invalidated/superseded.</summary>
    [JsonPropertyName("invalid_at")] public string? InvalidAt { get; init; }

    /// <summary>Whether this is the current (non-superseded) version of the memory.</summary>
    [JsonPropertyName("is_current")] public bool? IsCurrent { get; init; }

    /// <summary><c>true</c> when this is a globally-shared memory owned by another user.</summary>
    [JsonPropertyName("is_global")] public bool IsGlobal { get; init; }

    [JsonPropertyName("metadata_")] public JsonElement? Metadata { get; init; }
}

/// <summary>A single memory (from <see cref="CortadelClient.GetAsync"/>). Note the content field is <see cref="Text"/>.</summary>
public sealed record MemoryDetail
{
    public string Id { get; init; } = "";
    public string Text { get; init; } = "";

    /// <summary>Creation time as Unix seconds.</summary>
    [JsonPropertyName("created_at")] public long CreatedAt { get; init; }
    public string State { get; init; } = "active";
    [JsonPropertyName("app_id")] public string? AppId { get; init; }
    [JsonPropertyName("app_name")] public string? AppName { get; init; }
    public List<string> Categories { get; init; } = new();
    [JsonPropertyName("metadata_")] public JsonElement? Metadata { get; init; }
    [JsonPropertyName("valid_at")] public string? ValidAt { get; init; }
    [JsonPropertyName("invalid_at")] public string? InvalidAt { get; init; }
    [JsonPropertyName("is_current")] public bool? IsCurrent { get; init; }
    [JsonPropertyName("superseded_by")] public string? SupersededBy { get; init; }
    [JsonPropertyName("is_global")] public bool IsGlobal { get; init; }
}

/// <summary>
/// Result of ingesting a conversation. The two members are mutually exclusive on the wire: the
/// server sends <see cref="Results"/> when it distilled facts, or <see cref="NoFactsExtracted"/>
/// when it didn't — never both. Uncommon/future fields land in <see cref="Raw"/>.
/// </summary>
public sealed record ConversationResult
{
    /// <summary>One entry per distilled fact. Absent when nothing was extracted.</summary>
    public List<ConversationIngestItem>? Results { get; init; }

    /// <summary>True when the conversation yielded no storable facts; absent otherwise.</summary>
    [JsonPropertyName("no_facts_extracted")] public bool? NoFactsExtracted { get; init; }

    /// <summary>
    /// Always <c>null</c> on a <see cref="ConversationResult"/> returned by
    /// <see cref="CortadelClient"/>: its pipeline deserializes via the generated
    /// <c>ConversationIngestResponse</c>, which does not implement <c>IAdditionalDataHolder</c>,
    /// before mapping to this type, so it cannot recover fields the server adds beyond
    /// <see cref="Results"/>/<see cref="NoFactsExtracted"/>. (The <c>[JsonExtensionData]</c>
    /// attribute itself still works as documented if you deserialize this DTO directly with
    /// <c>System.Text.Json</c>, bypassing <see cref="CortadelClient"/> - that path just isn't how
    /// any value from this client reaches you.) Kept for source compatibility only; do not rely on
    /// it for values from <see cref="CortadelClient"/>.
    /// </summary>
    [JsonExtensionData] public Dictionary<string, JsonElement>? Raw { get; init; }
}

/// <summary>One fact distilled from a conversation and stored.</summary>
public sealed record ConversationIngestItem
{
    /// <summary>Id of the stored memory. Empty when the underlying pipeline event carries no id (e.g. <c>ERROR</c>, <c>INVALIDATE</c>).</summary>
    public string? Id { get; init; }

    /// <summary>The distilled fact text.</summary>
    public string? Memory { get; init; }

    /// <summary>What the store pipeline did, e.g. <c>ADD</c>, <c>SKIP_DUPLICATE</c>, or <c>ERROR</c>.</summary>
    public string? Event { get; init; }

    /// <summary>Failure detail when <see cref="Event"/> is <c>ERROR</c> (or another failed branch); absent otherwise.</summary>
    public string? Error { get; init; }
}

/// <summary>Server health snapshot.</summary>
public sealed record HealthResult
{
    /// <summary>Overall status: <c>ok</c> when every check passed, <c>degraded</c> otherwise.</summary>
    public string Status { get; init; } = "";

    [JsonPropertyName("checked_at")] public string? CheckedAt { get; init; }

    /// <summary>
    /// Per-dependency check details, keyed by dependency name (<c>memgraph</c>, <c>embeddings</c>,
    /// <c>indexes</c> today). <b>Not actually open-ended when populated by
    /// <see cref="CortadelClient"/></b>: its pipeline deserializes the response through the
    /// generated <c>HealthChecks</c>/<c>MemgraphCheck</c>/<c>EmbeddingCheck</c>/<c>IndexesCheck</c>
    /// types before mapping into this dictionary, and the contract declares all four with
    /// <c>additionalProperties: false</c>, so those generated types silently drop any key they
    /// don't already know about - a dependency check the contract doesn't declare (e.g. a future
    /// <c>falkordb</c> entry) or an undeclared field on a known check never reaches this dictionary
    /// at all when the value came from <see cref="CortadelClient"/>. This property itself has no
    /// such restriction - deserializing this DTO directly with <c>System.Text.Json</c>, bypassing
    /// <see cref="CortadelClient"/>, preserves arbitrary keys here.
    /// </summary>
    public Dictionary<string, JsonElement>? Checks { get; init; }

    /// <summary>
    /// Always <c>null</c> on a <see cref="HealthResult"/> returned by <see cref="CortadelClient"/>:
    /// its pipeline deserializes via the generated <c>HealthResponse</c>, which does not implement
    /// <c>IAdditionalDataHolder</c>, before mapping to this type, so fields the server adds beyond
    /// <see cref="Status"/>/<see cref="CheckedAt"/>/<see cref="Checks"/> never reach this bag. (The
    /// <c>[JsonExtensionData]</c> attribute itself still works as documented if you deserialize
    /// this DTO directly with <c>System.Text.Json</c>, bypassing <see cref="CortadelClient"/> -
    /// that path just isn't how any value from this client reaches you.) Kept for source
    /// compatibility only; do not rely on it for values from <see cref="CortadelClient"/>.
    /// </summary>
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extra { get; init; }
}

/// <summary>A structured error returned by the server.</summary>
public sealed record ApiError
{
    public int Status { get; init; }
    public string Code { get; init; } = "error";
    public string Message { get; init; } = "An error occurred";
    public string? Detail { get; init; }
}
