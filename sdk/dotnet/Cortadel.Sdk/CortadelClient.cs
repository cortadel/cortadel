using System.Text.Json;
using Cortadel.Sdk.Generated;
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Abstractions.Serialization;
using Microsoft.Kiota.Http.HttpClientLibrary;
using Microsoft.Kiota.Serialization.Json;
using GM = Cortadel.Sdk.Generated.Models;

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

    /// <summary>
    /// Request timeout. Defaults to 100 seconds (generous for reranked search).
    /// <b>No-op when you pass your own <see cref="HttpClient"/></b> to the constructor: the facade
    /// deliberately never mutates a caller-supplied client (its <c>Timeout</c> setter throws once
    /// that client has sent a request, and touching it would surprise anyone reusing one client for
    /// other calls too). This value only takes effect on the internal <see cref="HttpClient"/> the
    /// client creates for you. Set the timeout on your own <see cref="HttpClient"/> instead when
    /// you supply one.
    /// </summary>
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
/// <remarks>
/// Internally this is a facade over a Kiota-generated transport
/// (<see cref="Generated.CortadelApiClient"/>); the generated types never appear on this type's
/// public surface.
/// </remarks>
public sealed class CortadelClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly CortadelClientOptions _opts;
    private readonly HttpClientRequestAdapter _adapter;
    private readonly CortadelApiClient _generated;

    /// <summary>Create a client from full options, optionally reusing an existing <see cref="HttpClient"/>.</summary>
    public CortadelClient(CortadelClientOptions options, HttpClient? httpClient = null)
    {
        _opts = options ?? throw new ArgumentNullException(nameof(options));
        if (string.IsNullOrWhiteSpace(options.BaseUrl))
            throw new ArgumentException("BaseUrl is required.", nameof(options));
        if (!Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out _))
            throw new ArgumentException("BaseUrl must be an absolute URL.", nameof(options));
        if (string.IsNullOrWhiteSpace(options.UserId))
            throw new ArgumentException("UserId is required.", nameof(options));

        // Never mutate a caller-supplied HttpClient: BaseAddress/Timeout setters throw once the
        // client has sent a request, and DefaultRequestHeaders would leak the bearer token onto
        // every other request that client makes. Only touch it when we own it.
        _ownsHttp = httpClient is null;
        _http = httpClient ?? new HttpClient();
        if (_ownsHttp) _http.Timeout = options.Timeout;

        // Kiota generated no authentication code for this contract's securitySchemes (see task
        // report). Auth is attached per-request by this provider instead of on the HttpClient.
        IAuthenticationProvider authProvider = string.IsNullOrWhiteSpace(options.ApiKey)
            ? new AnonymousAuthenticationProvider()
            : new BearerTokenAuthenticationProvider(options.ApiKey);

        // No `servers` block in the contract, so the request adapter's BaseUrl must be set
        // explicitly before the generated client is constructed.
        _adapter = new HttpClientRequestAdapter(authProvider, httpClient: _http)
        {
            BaseUrl = options.BaseUrl.TrimEnd('/'),
        };
        _generated = new CortadelApiClient(_adapter);
    }

    /// <summary>Convenience constructor: <c>new CortadelClient("http://localhost:3001", "alice")</c>.</summary>
    public CortadelClient(string baseUrl, string userId, string? apiKey = null)
        : this(new CortadelClientOptions { BaseUrl = baseUrl, UserId = userId, ApiKey = apiKey }) { }

    /// <summary>Store a memory. By default the server extracts entities/categories in the background; set <see cref="AddOptions.Infer"/> to <c>false</c> to store verbatim.</summary>
    public async Task<MemoryCreated> AddAsync(string text, AddOptions? options = null, CancellationToken cancellationToken = default)
    {
        var body = new GM.CreateMemoryRequest
        {
            UserId = _opts.UserId,
            Text = text,
            App = options?.App,
            Infer = options?.Infer ?? true,
            MemoryType = options?.MemoryType,
            Metadata = ToMetadataBag(options?.Metadata),
        };
        var res = await ExecuteAsync(() => _generated.Api.V1.Memories.PostAsync(body, cancellationToken: cancellationToken)).ConfigureAwait(false);
        return MapCreated(res);
    }

    /// <summary>Distill a multi-turn conversation into atomic facts and store each one.</summary>
    public async Task<ConversationResult> AddConversationAsync(IEnumerable<ChatMessage> messages, ConversationOptions? options = null, CancellationToken cancellationToken = default)
    {
        var body = new GM.AddConversationRequest
        {
            UserId = _opts.UserId,
            Messages = messages.Select(m => new GM.ConversationMessageItem { Role = m.Role, Content = m.Content, Uuid = m.Uuid }).ToList(),
            IsAgentMemory = options?.IsAgentMemory ?? false,
            Tags = options?.Tags?.ToList(),
            Project = options?.Project,
            SessionId = options?.SessionId,
            TranscriptPath = options?.TranscriptPath,
        };
        var res = await ExecuteAsync(() => _generated.Api.V1.Memories.FromConversation.PostAsync(body, cancellationToken: cancellationToken)).ConfigureAwait(false);
        return MapConversation(res);
    }

    /// <summary>Hybrid search (BM25 + vector + RRF, optional cross-encoder rerank).</summary>
    public async Task<SearchResults> SearchAsync(string query, SearchOptions? options = null, CancellationToken cancellationToken = default)
    {
        var body = new GM.SearchMemoriesRequest
        {
            Query = query,
            UserId = _opts.UserId,
            AppName = _opts.AppName,
            TopK = options?.TopK ?? 10,
            Mode = options?.Mode ?? "hybrid",
            SessionId = options?.SessionId,
            Rerank = options?.Rerank,
            MemoryType = options?.MemoryType,
        };
        var res = await ExecuteAsync(() => _generated.Api.V1.Memories.Search.PostAsync(body, cancellationToken: cancellationToken)).ConfigureAwait(false);
        return MapSearch(res);
    }

    /// <summary>List memories for the user, newest-first, with pagination and optional filters.</summary>
    public async Task<MemoryList> ListAsync(ListOptions? options = null, CancellationToken cancellationToken = default)
    {
        var res = await ExecuteAsync(() => _generated.Api.V1.Memories.GetAsync(config =>
        {
            config.QueryParameters.UserId = _opts.UserId;
            config.QueryParameters.Page = options?.Page ?? 1;
            config.QueryParameters.Size = options?.Size ?? 20;
            if (!string.IsNullOrWhiteSpace(options?.AppId)) config.QueryParameters.AppId = options!.AppId;
            if (!string.IsNullOrWhiteSpace(options?.Categories)) config.QueryParameters.Categories = options!.Categories;
            if (!string.IsNullOrWhiteSpace(options?.SearchQuery)) config.QueryParameters.SearchQuery = options!.SearchQuery;
            // Trap: IncludeSuperseded is a string query param on the generated builder ("true"),
            // not a bool - ListOptions.IncludeSuperseded is a bool and must be stringified.
            if (options?.IncludeSuperseded == true) config.QueryParameters.IncludeSuperseded = "true";
            if (!string.IsNullOrWhiteSpace(options?.MemoryType)) config.QueryParameters.MemoryType = options!.MemoryType;
        }, cancellationToken: cancellationToken)).ConfigureAwait(false);
        return MapList(res);
    }

    /// <summary>Fetch a single memory by id. Returns <c>null</c> if it does not exist.</summary>
    public async Task<MemoryDetail?> GetAsync(string memoryId, CancellationToken cancellationToken = default)
    {
        GM.MemoryDetailResponse? res;
        try
        {
            res = await _generated.Api.V1.Memories[memoryId]
                .GetAsync(config => config.QueryParameters.UserId = _opts.UserId, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
        }
        // Trap: the wire-body ErrorResponse.Status is nullable and not guaranteed present; the
        // transport-level ResponseStatusCode (inherited from ApiException) is always populated.
        // This must filter on the ApiException base, not the generated ErrorResponse subtype: when
        // the 404 body can't be deserialized into ErrorResponse at all (e.g. an empty body with no
        // Content-Type - exactly what ASP.NET Core returns for an unmatched route), Kiota still
        // throws an ApiException with the real ResponseStatusCode, just not the ErrorResponse subtype.
        catch (ApiException e) when (e.ResponseStatusCode == 404)
        {
            return null;
        }
        catch (GM.ErrorResponse e)
        {
            throw ToCortadelException(e);
        }
        catch (GM.ValidationProblemDetails e)
        {
            throw ToCortadelException(e);
        }
        catch (ApiException e)
        {
            throw ToCortadelException(e);
        }
        // Fallback: a non-JSON/unparseable error body (e.g. a proxy's text/html error page)
        // makes Kiota's ParseNodeFactoryRegistry throw a bare InvalidOperationException before
        // it ever constructs an ApiException, so no status code survives to be checked above. We
        // cannot safely infer "this was a 404" from a wholly opaque failure - silently returning
        // null could just as easily hide a real 500 - so this still throws (as a
        // CortadelException, not a leaking framework exception) rather than returning null. See
        // the task report's known limitations for this residual gap.
        // Deliberately narrow (not a bare `catch (Exception)`): OperationCanceledException /
        // TaskCanceledException from a caller's CancellationToken firing (or an HttpClient
        // timeout, which surfaces the same way) must propagate untouched, matching the standard
        // .NET cancellation idiom every caller of an `Async` method with a token relies on.
        catch (InvalidOperationException e)
        {
            throw ToCortadelException(e);
        }
        return res is null ? null : MapDetail(res);
    }

    /// <summary>Delete one or more memories. Returns the server's confirmation message.</summary>
    public async Task<string> DeleteAsync(IEnumerable<string> memoryIds, CancellationToken cancellationToken = default)
    {
        var body = new GM.DeleteMemoriesRequest { UserId = _opts.UserId, MemoryIds = memoryIds.ToList() };
        var res = await ExecuteAsync(() => _generated.Api.V1.Memories.DeleteAsync(body, cancellationToken: cancellationToken)).ConfigureAwait(false);
        return res.Message ?? "";
    }

    /// <summary>Server health (database + embedding provider reachability).</summary>
    public async Task<HealthResult> HealthAsync(CancellationToken cancellationToken = default)
    {
        GM.HealthResponse? res;
        try
        {
            res = await _generated.Api.Health.GetAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        // Trap: the contract $refs HealthResponse for both the 200 and the 503 body, so Kiota
        // error-maps the 503 and a degraded server throws its own success-shaped type rather
        // than returning it. The documented surface never throws on "degraded" - only on
        // transport/unexpected-status failures - so catch it and map it like a normal body.
        catch (GM.HealthResponse degraded)
        {
            return MapHealth(degraded);
        }
        catch (ApiException e)
        {
            throw ToCortadelException(e);
        }
        // Same non-JSON-body fallback as ExecuteAsync/GetAsync - a proxy/gateway fronting the
        // health endpoint can return an unparseable error body too. Deliberately narrow: see the
        // comment on the equivalent catch in GetAsync for why this must not be `catch (Exception)`.
        catch (InvalidOperationException e)
        {
            throw ToCortadelException(e);
        }
        if (res is null) throw new CortadelException(502, "empty_response", "The server returned an empty response.");
        return MapHealth(res);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        _adapter.Dispose();
        if (_ownsHttp) _http.Dispose();
    }

    // ── Generated call execution + error translation ───────────────────────────────────────

    private static async Task<T> ExecuteAsync<T>(Func<Task<T?>> call) where T : class
    {
        T? result;
        try
        {
            result = await call().ConfigureAwait(false);
        }
        catch (GM.ValidationProblemDetails e)
        {
            throw ToCortadelException(e);
        }
        catch (GM.ErrorResponse e)
        {
            throw ToCortadelException(e);
        }
        catch (ApiException e)
        {
            throw ToCortadelException(e);
        }
        // Fallback: for statuses in the operation's errorMapping, Kiota parses the body before
        // throwing - and for a content type with no registered parser (e.g. "text/html" from a
        // reverse proxy or WAF error page, or "text/json" - anything that isn't exactly what
        // this operation's declared error schemas expect), ParseNodeFactoryRegistry throws a
        // bare InvalidOperationException instead of an ApiException. That must not escape this
        // library as an unrelated framework exception - translate it into a CortadelException
        // too, without a resolvable status code (see the task report's known limitations: the
        // real HTTP status is not recoverable from this exception).
        // Deliberately narrow (not a bare `catch (Exception)`): OperationCanceledException /
        // TaskCanceledException from a caller's CancellationToken firing (or an HttpClient
        // timeout, which surfaces the same way) must propagate untouched, matching the standard
        // .NET cancellation idiom every caller of an `Async` method with a token relies on.
        catch (InvalidOperationException e)
        {
            throw ToCortadelException(e);
        }
        return result ?? throw new CortadelException(502, "empty_response", "The server returned an empty response.");
    }

    private static CortadelException ToCortadelException(GM.ErrorResponse e) =>
        new(e.ResponseStatusCode, e.Code ?? "http_error", string.IsNullOrEmpty(e.Message) ? "The request failed." : e.Message);

    private static CortadelException ToCortadelException(GM.ValidationProblemDetails e) =>
        new(e.ResponseStatusCode, "validation_error", BuildValidationMessage(e));

    private static CortadelException ToCortadelException(ApiException e) =>
        new(e.ResponseStatusCode, "http_error", string.IsNullOrEmpty(e.Message) ? "The request failed." : e.Message);

    /// <summary>
    /// Last-resort translation for the one failure mode that never becomes an
    /// <see cref="ApiException"/>: <c>ParseNodeFactoryRegistry</c> throwing
    /// <see cref="InvalidOperationException"/> for a response content type it has no parser for
    /// (see the fallback catch clauses above). There is no transport status code to recover here,
    /// so 0 is used as an explicit "unknown" sentinel rather than guessing one. The parameter type
    /// is deliberately this narrow, not <see cref="Exception"/>: it exists specifically so the
    /// fallback catch clauses can stay narrow too (never a bare `catch (Exception)`, which would
    /// also swallow <see cref="OperationCanceledException"/> from a caller's cancellation token).
    /// </summary>
    private static CortadelException ToCortadelException(InvalidOperationException e) =>
        new(0, "transport_error", string.IsNullOrEmpty(e.Message) ? "The request failed." : e.Message);

    /// <summary>
    /// A model-state 400 carries field-level errors in <see cref="GM.ValidationProblemDetails.Errors"/>
    /// (an open ASP.NET Core ModelState map with no declared properties - everything lands in its
    /// AdditionalData bag as Kiota Untyped* nodes). Fold them into the message instead of
    /// discarding them, since the old client's opaque "An error occurred" was a documented complaint.
    /// </summary>
    private static string BuildValidationMessage(GM.ValidationProblemDetails e)
    {
        var baseMessage = e.Detail ?? e.Title ?? "Validation failed.";
        if (e.Errors?.AdditionalData is not { Count: > 0 } fields) return baseMessage;

        var parts = fields.Select(kv => $"{kv.Key}: {string.Join("; ", FlattenErrorValues(kv.Value))}");
        return $"{baseMessage} ({string.Join(", ", parts)})";
    }

    private static IEnumerable<string> FlattenErrorValues(object value) => value switch
    {
        UntypedArray arr => arr.GetValue().Select(FlattenUntyped),
        UntypedNode node => new[] { FlattenUntyped(node) },
        _ => new[] { value.ToString() ?? "" },
    };

    private static string FlattenUntyped(UntypedNode node) => node switch
    {
        UntypedString s => s.GetValue() ?? "",
        UntypedNull => "",
        _ => node.GetValue()?.ToString() ?? "",
    };

    // ── DTO mapping: generated model -> frozen public DTO ──────────────────────────────────

    private static MemoryCreated MapCreated(GM.MemoryCreatedResponse r) => new()
    {
        Id = r.Id ?? "",
        Content = r.Content,
        State = r.State,
        CreatedAt = r.CreatedAt,
        Event = r.Event,
        AppName = r.AppName,
        Metadata = r.Metadata,
    };

    private static ConversationResult MapConversation(GM.ConversationIngestResponse r) => new()
    {
        Results = r.Results?.Select(MapConversationItem).ToList(),
        NoFactsExtracted = r.NoFactsExtracted,
    };

    private static ConversationIngestItem MapConversationItem(GM.ConversationIngestItem i) => new()
    {
        Id = i.Id,
        Memory = i.Memory,
        Event = i.Event,
        Error = i.Error,
    };

    private static SearchResults MapSearch(GM.SearchResponse r) => new()
    {
        Query = r.Query ?? "",
        Results = r.Results?.Select(MapHit).ToList() ?? new(),
        Total = r.Total ?? 0,
    };

    private static SearchHit MapHit(GM.HybridSearchResult h) => new()
    {
        Id = h.Id ?? "",
        Content = h.Content ?? "",
        RrfScore = h.RrfScore,
        CreatedAt = h.CreatedAt,
        AppName = h.AppName,
        Categories = h.Categories,
        MemoryType = h.MemoryType,
        Tags = h.Tags,
        Source = h.Source,
        IsGlobal = h.Global ?? false,
        Gist = h.Gist,
        ProjectId = h.ProjectId,
        MemberIds = h.MemberIds,
        SimilarIds = h.SimilarIds,
        TextRank = h.TextRank,
        VectorRank = h.VectorRank,
        Attributes = ToAttributeMap(h.Attributes?.AdditionalData),
    };

    private static MemoryList MapList(GM.MemoryListPagedResponse r) => new()
    {
        Items = r.Items?.Select(MapListItem).ToList() ?? new(),
        Total = r.Total ?? 0,
        Page = r.Page ?? 0,
        Size = r.Size ?? 0,
        Pages = r.Pages ?? 0,
    };

    private static MemoryListItem MapListItem(GM.MemoryListItemResponse i) => new()
    {
        Id = i.Id ?? "",
        Content = i.Content ?? "",
        CreatedAt = i.CreatedAt ?? 0,
        State = i.State ?? "active",
        AppId = i.AppId,
        AppName = i.AppName,
        Categories = i.Categories ?? new(),
        MemoryType = i.MemoryType,
        ExtractionStatus = i.ExtractionStatus,
        ValidAt = i.ValidAt,
        InvalidAt = i.InvalidAt,
        IsCurrent = i.IsCurrent,
        IsGlobal = i.IsGlobal ?? false,
        // Trap: wire key is "metadata_" (trailing underscore); the generated Metadata property
        // already binds to it correctly, no renaming needed here.
        Metadata = i.Metadata is null ? null : UntypedToJsonElement(i.Metadata),
    };

    private static MemoryDetail MapDetail(GM.MemoryDetailResponse d) => new()
    {
        Id = d.Id ?? "",
        Text = d.Text ?? "",
        CreatedAt = d.CreatedAt ?? 0,
        State = d.State ?? "active",
        AppId = d.AppId,
        AppName = d.AppName,
        Categories = d.Categories ?? new(),
        Metadata = d.Metadata is null ? null : UntypedToJsonElement(d.Metadata),
        ValidAt = d.ValidAt,
        InvalidAt = d.InvalidAt,
        IsCurrent = d.IsCurrent,
        SupersededBy = d.SupersededBy,
        IsGlobal = d.IsGlobal ?? false,
    };

    private static HealthResult MapHealth(GM.HealthResponse r) => new()
    {
        Status = r.Status ?? "",
        CheckedAt = r.CheckedAt,
        Checks = ToChecksDict(r.Checks),
    };

    // ── Free-form value conversion (Kiota Untyped* graph <-> JsonElement) ──────────────────

    private static GM.CreateMemoryRequest_metadata? ToMetadataBag(IDictionary<string, object?>? metadata)
    {
        if (metadata is null) return null;
        var bag = new GM.CreateMemoryRequest_metadata();
        foreach (var (k, v) in metadata)
            bag.AdditionalData[k] = v!;
        return bag;
    }

    private static Dictionary<string, JsonElement?>? ToAttributeMap(IDictionary<string, object>? additionalData)
    {
        if (additionalData is null || additionalData.Count == 0) return null;
        var result = new Dictionary<string, JsonElement?>();
        foreach (var (key, value) in additionalData)
            result[key] = value is UntypedNode node ? UntypedToJsonElement(node) : JsonSerializer.SerializeToElement(value);
        return result;
    }

    private static Dictionary<string, JsonElement>? ToChecksDict(GM.HealthChecks? checks)
    {
        if (checks is null) return null;
        var elem = ToJsonElementObj(checks);
        var dict = new Dictionary<string, JsonElement>();
        foreach (var prop in elem.EnumerateObject())
            dict[prop.Name] = prop.Value;
        return dict;
    }

    /// <summary>Round-trips any generated <see cref="IParsable"/> through Kiota's own JSON writer
    /// so its shape (including nested free-form data) matches exactly what the wire would have
    /// produced, without hand-rolling a second serializer.</summary>
    private static JsonElement ToJsonElementObj<T>(T value) where T : class, IParsable
    {
        using var writer = new JsonSerializationWriter();
        writer.WriteObjectValue(null!, value);
        using var stream = writer.GetSerializedContent();
        using var doc = JsonDocument.Parse(stream);
        return doc.RootElement.Clone();
    }

    private static JsonElement UntypedToJsonElement(UntypedNode? node)
    {
        switch (node)
        {
            case null:
            case UntypedNull:
                return JsonSerializer.SerializeToElement((object?)null);
            case UntypedString s:
                return JsonSerializer.SerializeToElement(s.GetValue());
            case UntypedBoolean b:
                return JsonSerializer.SerializeToElement(b.GetValue());
            case UntypedInteger i:
                return JsonSerializer.SerializeToElement(i.GetValue());
            case UntypedLong l:
                return JsonSerializer.SerializeToElement(l.GetValue());
            case UntypedFloat f:
                return JsonSerializer.SerializeToElement(f.GetValue());
            case UntypedDouble d:
                return JsonSerializer.SerializeToElement(d.GetValue());
            case UntypedDecimal m:
                return JsonSerializer.SerializeToElement(m.GetValue());
            case UntypedArray arr:
            {
                using var doc = JsonSerializer.SerializeToDocument(arr.GetValue().Select(UntypedToJsonElement).ToArray());
                return doc.RootElement.Clone();
            }
            case UntypedObject obj:
            {
                var dict = obj.GetValue().ToDictionary(kv => kv.Key, kv => UntypedToJsonElement(kv.Value));
                using var doc = JsonSerializer.SerializeToDocument(dict);
                return doc.RootElement.Clone();
            }
            default:
                return JsonSerializer.SerializeToElement(node.GetValue());
        }
    }

    // ── Authentication ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Kiota generated no authentication code for this contract's securitySchemes (the C# generator
    /// ignores them). This attaches the bearer token per-request through the request adapter
    /// instead of on a shared HttpClient's DefaultRequestHeaders.
    /// </summary>
    private sealed class BearerTokenAuthenticationProvider(string apiKey) : IAuthenticationProvider
    {
        public Task AuthenticateRequestAsync(
            RequestInformation request,
            Dictionary<string, object>? additionalAuthenticationContext = null,
            CancellationToken cancellationToken = default)
        {
            request.Headers.Add("Authorization", new[] { $"Bearer {apiKey}" });
            return Task.CompletedTask;
        }
    }
}
