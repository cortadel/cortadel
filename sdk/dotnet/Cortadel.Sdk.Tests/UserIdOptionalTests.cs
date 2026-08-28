using System.Net;
using Cortadel.Sdk;

namespace Cortadel.Sdk.Tests;

/// <summary>
/// <c>UserId</c> is optional: the server fills a missing user_id from the API key (server commit
/// 30b70ea4). These pin the three states that behaviour has to distinguish —
/// <list type="bullet">
/// <item>omitted (null) → nothing on the wire, no body field and no query parameter;</item>
/// <item>provided → sent exactly as before;</item>
/// <item>explicitly blank/whitespace → still a constructor <see cref="ArgumentException"/>.</item>
/// </list>
/// The wire assertions matter more than they look: not assigning the generated model's UserId
/// leaves it null, and whether that produces <c>"user_id":null</c> or no key at all is Kiota's
/// serializer's decision, not ours — a <c>null</c> user_id is a 400 on the server just like a
/// missing one would have been before the fix, so it has to be *absent*, not null.
/// </summary>
public class UserIdOptionalTests
{
    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastRequestBody { get; private set; }

        public FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => _respond = respond;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            LastRequestBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return _respond(request);
        }
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
    };

    private static (FakeHandler Handler, HttpClient Http) Responding(string body)
    {
        var handler = new FakeHandler(_ => Json(body));
        return (handler, new HttpClient(handler));
    }

    private const string CreatedBody = """{"id":"m1","content":"hello","state":"active"}""";
    private const string SearchBody = """{"query":"q","total":0,"results":[]}""";
    private const string ListBody = """{"items":[],"total":0,"page":1,"size":20,"pages":0}""";
    private const string DetailBody = """{"id":"m1","text":"hello","created_at":1,"state":"active"}""";
    private const string DeleteBody = """{"message":"deleted"}""";
    private const string ConversationBody = """{"results":[]}""";

    // ── Constructor validation ────────────────────────────────────────────────────────────

    [Fact]
    public void Constructor_AcceptsAnOmittedUserId_ViaOptions()
    {
        var ex = Record.Exception(() =>
            new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }).Dispose());

        Assert.Null(ex);
    }

    [Fact]
    public void Constructor_AcceptsAnOmittedUserId_ViaTheConvenienceConstructor()
    {
        // The convenience ctor must still be usable without a user id - both fully positional-free
        // and with a named apiKey, which is the shape the README now documents.
        var omitted = Record.Exception(() => new CortadelClient("http://localhost:3001").Dispose());
        var keyOnly = Record.Exception(() => new CortadelClient("http://localhost:3001", apiKey: "k").Dispose());
        var explicitNull = Record.Exception(() => new CortadelClient("http://localhost:3001", null, "k").Dispose());

        Assert.Null(omitted);
        Assert.Null(keyOnly);
        Assert.Null(explicitNull);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    public void Constructor_StillRejectsAnExplicitlyBlankUserId(string blank)
    {
        // Omission is legal; an explicitly supplied blank string is a caller bug (unset variable,
        // empty config entry) and must keep throwing.
        Assert.Throws<ArgumentException>(() =>
            new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = blank }));
        Assert.Throws<ArgumentException>(() =>
            new CortadelClient("http://localhost:3001", blank));
    }

    // ── Omitted: nothing on the wire ──────────────────────────────────────────────────────

    [Fact]
    public async Task AddAsync_PutsNoUserIdOnTheWire_WhenOmitted()
    {
        var (handler, http) = Responding(CreatedBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        await cortadel.AddAsync("hello");

        // Not `"user_id":null` either - the substring check covers both spellings.
        Assert.DoesNotContain("user_id", handler.LastRequestBody);
        Assert.Contains("\"text\":\"hello\"", handler.LastRequestBody);
    }

    [Fact]
    public async Task SearchAsync_PutsNoUserIdOnTheWire_WhenOmitted()
    {
        var (handler, http) = Responding(SearchBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        await cortadel.SearchAsync("pets");

        Assert.DoesNotContain("user_id", handler.LastRequestBody);
        Assert.Contains("\"query\":\"pets\"", handler.LastRequestBody);
    }

    [Fact]
    public async Task AddConversationAsync_PutsNoUserIdOnTheWire_WhenOmitted()
    {
        var (handler, http) = Responding(ConversationBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        await cortadel.AddConversationAsync(new[] { new ChatMessage("user", "hi") });

        Assert.DoesNotContain("user_id", handler.LastRequestBody);
    }

    [Fact]
    public async Task DeleteAsync_PutsNoUserIdOnTheWire_WhenOmitted()
    {
        var (handler, http) = Responding(DeleteBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        await cortadel.DeleteAsync(new[] { "m1" });

        Assert.DoesNotContain("user_id", handler.LastRequestBody);
        Assert.Contains("memory_ids", handler.LastRequestBody);
    }

    [Fact]
    public async Task ListAsync_PutsNoUserIdQueryParameterOnTheWire_WhenOmitted()
    {
        var (handler, http) = Responding(ListBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        await cortadel.ListAsync(new ListOptions { Page = 2, Size = 5 });

        var uri = handler.LastRequest!.RequestUri!.ToString();
        Assert.DoesNotContain("user_id", uri);
        // The other query parameters must still be there - "omit user_id" must not degrade into
        // "send no query string at all".
        Assert.Contains("page=2", uri);
        Assert.Contains("size=5", uri);
    }

    [Fact]
    public async Task GetAsync_PutsNoUserIdQueryParameterOnTheWire_WhenOmitted()
    {
        var (handler, http) = Responding(DetailBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        var detail = await cortadel.GetAsync("m1");

        Assert.NotNull(detail);
        Assert.DoesNotContain("user_id", handler.LastRequest!.RequestUri!.ToString());
    }

    // ── ListAsync's rebuilt URL must stay a faithful request ──────────────────────────────
    //
    // ListAsync is the one operation whose generated URL template pins user_id as a literal
    // ("...?user_id={user_id}{&...}"), so an unset value expands to a bare "user_id=" that the
    // server reads as a blank user. The client strips it and re-issues against the cleaned
    // absolute URL - these check that detour did not quietly change anything else about the request.

    [Fact]
    public async Task ListAsync_WhenOmitted_StillTargetsTheCorrectAbsoluteUrl()
    {
        var (handler, http) = Responding(ListBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        await cortadel.ListAsync();

        var uri = handler.LastRequest!.RequestUri!;
        Assert.Equal("http", uri.Scheme);
        Assert.Equal("localhost", uri.Host);
        Assert.Equal(3001, uri.Port);
        Assert.Equal("/api/v1/memories", uri.AbsolutePath);
        Assert.Equal(HttpMethod.Get, handler.LastRequest.Method);
        // The bearer credential must survive the rebuilt-URL detour too.
        Assert.Equal("k", handler.LastRequest.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task ListAsync_WhenOmitted_StillPercentEncodesTheOtherQueryParameters()
    {
        // The rebuilt URL is produced by the generated builder's own template expansion, so Kiota
        // still owns escaping - a hand-rolled query string would get this wrong.
        var (handler, http) = Responding(ListBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", ApiKey = "k" }, http);

        await cortadel.ListAsync(new ListOptions { SearchQuery = "dark mode & tabs", IncludeSuperseded = true });

        var uri = handler.LastRequest!.RequestUri!;
        Assert.DoesNotContain("user_id", uri.ToString());
        Assert.Equal("dark mode & tabs", System.Web.HttpUtility.ParseQueryString(uri.Query)["search_query"]);
        Assert.Equal("true", System.Web.HttpUtility.ParseQueryString(uri.Query)["include_superseded"]);
    }

    [Fact]
    public async Task ListAsync_WhenOmitted_StillMapsServerErrorsThroughTheGeneratedErrorMapping()
    {
        // The rebuilt request goes back through the generated operation, so a structured error
        // body must still land as a CortadelException carrying the server's own code - not a
        // generic http_error.
        var handler = new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized)
        {
            Content = new StringContent("""{"code":"unauthorized","message":"missing key"}""",
                System.Text.Encoding.UTF8, "application/json"),
        });
        using var http = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001" }, http);

        var ex = await Assert.ThrowsAsync<CortadelException>(() => cortadel.ListAsync());

        Assert.Equal(401, ex.StatusCode);
        Assert.Equal("unauthorized", ex.Code);
    }

    [Fact]
    public async Task ListAsync_WhenOmitted_HonoursATrailingSlashOnTheBaseUrl()
    {
        // The cleaned URL is rebuilt from the adapter's BaseUrl, which the constructor trims - a
        // regression here would produce "//api/v1/memories".
        var (handler, http) = Responding(ListBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001/", ApiKey = "k" }, http);

        await cortadel.ListAsync();

        Assert.Equal("/api/v1/memories", handler.LastRequest!.RequestUri!.AbsolutePath);
    }

    // ── Provided: unchanged behaviour ─────────────────────────────────────────────────────

    [Fact]
    public async Task AddAsync_StillSendsAProvidedUserId()
    {
        var (handler, http) = Responding(CreatedBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, http);

        await cortadel.AddAsync("hello");

        Assert.Contains("\"user_id\":\"alice\"", handler.LastRequestBody);
    }

    [Fact]
    public async Task SearchAsync_StillSendsAProvidedUserId()
    {
        var (handler, http) = Responding(SearchBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, http);

        await cortadel.SearchAsync("pets");

        Assert.Contains("\"user_id\":\"alice\"", handler.LastRequestBody);
    }

    [Fact]
    public async Task AddConversationAsync_StillSendsAProvidedUserId()
    {
        var (handler, http) = Responding(ConversationBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, http);

        await cortadel.AddConversationAsync(new[] { new ChatMessage("user", "hi") });

        Assert.Contains("\"user_id\":\"alice\"", handler.LastRequestBody);
    }

    [Fact]
    public async Task DeleteAsync_StillSendsAProvidedUserId()
    {
        var (handler, http) = Responding(DeleteBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, http);

        await cortadel.DeleteAsync(new[] { "m1" });

        Assert.Contains("\"user_id\":\"alice\"", handler.LastRequestBody);
    }

    [Fact]
    public async Task ListAsync_StillSendsAProvidedUserIdQueryParameter()
    {
        var (handler, http) = Responding(ListBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, http);

        await cortadel.ListAsync();

        Assert.Contains("user_id=alice", handler.LastRequest!.RequestUri!.ToString());
    }

    [Fact]
    public async Task GetAsync_StillSendsAProvidedUserIdQueryParameter()
    {
        var (handler, http) = Responding(DetailBody);
        using var _ = http;
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, http);

        await cortadel.GetAsync("m1");

        Assert.Contains("user_id=alice", handler.LastRequest!.RequestUri!.ToString());
    }
}
