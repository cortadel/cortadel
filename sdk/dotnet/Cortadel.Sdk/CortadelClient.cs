using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cortadel.Sdk;

/// <summary>Configuration for a <see cref="CortadelClient"/>.</summary>
public sealed class CortadelClientOptions
{
    /// <summary>Base URL of the Cortadel server, e.g. <c>http://localhost:3001</c>.</summary>
    public required string BaseUrl { get; init; }

    /// <summary>User identifier that owns the memories (the namespace anchor). Required by the REST API.</summary>
    public required string UserId { get; init; }

    /// <summary>Optional API key. Sent as <c>Authorization: Bearer &lt;key&gt;</c>. Omit when the server runs with auth disabled.</summary>
    public string? ApiKey { get; init; }

    /// <summary>App name recorded for access logging on searches. Defaults to <c>cortadel-dotnet</c>.</summary>
    public string AppName { get; init; } = "cortadel-dotnet";

    /// <summary>Request timeout. Defaults to 100 seconds (generous for reranked search).</summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(100);
}

/// <summary>Thrown when the Cortadel server returns a non-success response.</summary>
public sealed class CortadelException : Exception
{
    /// <summary>HTTP status code returned by the server.</summary>
    public int StatusCode { get; }

    /// <summary>Machine-readable error code (e.g. <c>not_found</c>, <c>validation_error</c>).</summary>
    public string Code { get; }

    public CortadelException(int statusCode, string code, string message) : base(message)
    {
        StatusCode = statusCode;
        Code = code;
    }
}

/// <summary>
/// A thin, typed client for the Cortadel REST API. Create one and reuse it (it wraps a single
/// <see cref="HttpClient"/>). All calls are scoped to <see cref="CortadelClientOptions.UserId"/>.
/// </summary>
public sealed class CortadelClient : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly CortadelClientOptions _opts;

    /// <summary>Create a client from full options, optionally reusing an existing <see cref="HttpClient"/>.</summary>
    public CortadelClient(CortadelClientOptions options, HttpClient? httpClient = null)
    {
        _opts = options ?? throw new ArgumentNullException(nameof(options));
        if (string.IsNullOrWhiteSpace(options.BaseUrl)) throw new ArgumentException("BaseUrl is required.", nameof(options));
        if (string.IsNullOrWhiteSpace(options.UserId)) throw new ArgumentException("UserId is required.", nameof(options));

        _ownsHttp = httpClient is null;
        _http = httpClient ?? new HttpClient();
        _http.BaseAddress = new Uri(options.BaseUrl.TrimEnd('/') + "/");
        _http.Timeout = options.Timeout;
        if (!string.IsNullOrWhiteSpace(options.ApiKey))
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
    }

    /// <summary>Convenience constructor: <c>new CortadelClient("http://localhost:3001", "alice")</c>.</summary>
    public CortadelClient(string baseUrl, string userId, string? apiKey = null)
        : this(new CortadelClientOptions { BaseUrl = baseUrl, UserId = userId, ApiKey = apiKey }) { }

    /// <summary>Store a memory. By default the server extracts entities/categories in the background; set <see cref="AddOptions.Infer"/> to <c>false</c> to store verbatim.</summary>
    public Task<MemoryCreated> AddAsync(string text, AddOptions? options = null, CancellationToken cancellationToken = default)
    {
        var body = new
        {
            userId = _opts.UserId,
            text,
            app = options?.App,
            metadata = options?.Metadata,
            infer = options?.Infer ?? true,
            memoryType = options?.MemoryType,
        };
        return SendAsync<MemoryCreated>(HttpMethod.Post, "api/v1/memories", body, cancellationToken);
    }

    /// <summary>Distill a multi-turn conversation into atomic facts and store each one.</summary>
    public Task<ConversationResult> AddConversationAsync(IEnumerable<ChatMessage> messages, ConversationOptions? options = null, CancellationToken cancellationToken = default)
    {
        var body = new
        {
            userId = _opts.UserId,
            messages = messages.Select(m => new { role = m.Role, content = m.Content, uuid = m.Uuid }),
            isAgentMemory = options?.IsAgentMemory ?? false,
            tags = options?.Tags,
            project = options?.Project,
            sessionId = options?.SessionId,
            transcriptPath = options?.TranscriptPath,
        };
        return SendAsync<ConversationResult>(HttpMethod.Post, "api/v1/memories/from-conversation", body, cancellationToken);
    }

    /// <summary>Hybrid search (BM25 + vector + RRF, optional cross-encoder rerank).</summary>
    public Task<SearchResults> SearchAsync(string query, SearchOptions? options = null, CancellationToken cancellationToken = default)
    {
        var body = new
        {
            query,
            userId = _opts.UserId,
            appName = _opts.AppName,
            topK = options?.TopK ?? 10,
            mode = options?.Mode ?? "hybrid",
            sessionId = options?.SessionId,
            rerank = options?.Rerank,
            memoryType = options?.MemoryType,
        };
        return SendAsync<SearchResults>(HttpMethod.Post, "api/v1/memories/search", body, cancellationToken);
    }

    /// <summary>List memories for the user, newest-first, with pagination and optional filters.</summary>
    public Task<MemoryList> ListAsync(ListOptions? options = null, CancellationToken cancellationToken = default)
    {
        var q = new List<string>
        {
            "user_id=" + Uri.EscapeDataString(_opts.UserId),
            "page=" + (options?.Page ?? 1),
            "size=" + (options?.Size ?? 20),
        };
        if (!string.IsNullOrWhiteSpace(options?.AppId)) q.Add("app_id=" + Uri.EscapeDataString(options!.AppId!));
        if (!string.IsNullOrWhiteSpace(options?.Categories)) q.Add("categories=" + Uri.EscapeDataString(options!.Categories!));
        if (!string.IsNullOrWhiteSpace(options?.SearchQuery)) q.Add("search_query=" + Uri.EscapeDataString(options!.SearchQuery!));
        if (options?.IncludeSuperseded == true) q.Add("include_superseded=true");
        if (!string.IsNullOrWhiteSpace(options?.MemoryType)) q.Add("memory_type=" + Uri.EscapeDataString(options!.MemoryType!));
        return SendAsync<MemoryList>(HttpMethod.Get, "api/v1/memories?" + string.Join("&", q), null, cancellationToken);
    }

    /// <summary>Fetch a single memory by id. Returns <c>null</c> if it does not exist.</summary>
    public async Task<MemoryDetail?> GetAsync(string memoryId, CancellationToken cancellationToken = default)
    {
        var path = "api/v1/memories/" + Uri.EscapeDataString(memoryId) + "?user_id=" + Uri.EscapeDataString(_opts.UserId);
        using var res = await _http.GetAsync(path, cancellationToken).ConfigureAwait(false);
        if (res.StatusCode == HttpStatusCode.NotFound) return null;
        await EnsureSuccess(res, cancellationToken).ConfigureAwait(false);
        return await res.Content.ReadFromJsonAsync<MemoryDetail>(Json, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Delete one or more memories. Returns the server's confirmation message.</summary>
    public async Task<string> DeleteAsync(IEnumerable<string> memoryIds, CancellationToken cancellationToken = default)
    {
        var body = new { userId = _opts.UserId, memoryIds = memoryIds.ToList() };
        var res = await SendAsync<MessageResult>(HttpMethod.Delete, "api/v1/memories", body, cancellationToken).ConfigureAwait(false);
        return res.Message;
    }

    /// <summary>Server health (database + embedding provider reachability).</summary>
    public Task<HealthResult> HealthAsync(CancellationToken cancellationToken = default)
        => SendAsync<HealthResult>(HttpMethod.Get, "api/health", null, cancellationToken);

    private async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct) where T : class
    {
        using var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body, options: Json);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        await EnsureSuccess(res, ct).ConfigureAwait(false);
        var result = await res.Content.ReadFromJsonAsync<T>(Json, ct).ConfigureAwait(false);
        return result ?? throw new CortadelException(502, "empty_response", "The server returned an empty response.");
    }

    private static async Task EnsureSuccess(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.IsSuccessStatusCode) return;
        ApiError? err = null;
        try { err = await res.Content.ReadFromJsonAsync<ApiError>(Json, ct).ConfigureAwait(false); }
        catch { /* response body was not JSON */ }
        throw new CortadelException((int)res.StatusCode, err?.Code ?? "http_error",
            err?.Message ?? res.ReasonPhrase ?? "The request failed.");
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }
}
