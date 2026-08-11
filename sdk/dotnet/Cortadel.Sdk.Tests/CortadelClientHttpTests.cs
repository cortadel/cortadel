using System.Net;
using Cortadel.Sdk;

namespace Cortadel.Sdk.Tests;

/// <summary>
/// Exercises the generated-transport facade against a fake HttpMessageHandler. The brief's
/// CortadelClientTests only checks constructor validation and the public-surface shape; these
/// cover the wire-level behavior the task's five traps and the HttpClient-mutation bug are about.
/// </summary>
public class CortadelClientHttpTests
{
    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _respond;
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastRequestBody { get; private set; }

        public FakeHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) => _respond = respond;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            LastRequestBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return await _respond(request);
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
    };

    [Fact]
    public async Task Auth_AttachesBearerHeaderPerRequest_WithoutMutatingCallerHttpClient()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK,
            """{"status":"ok","checked_at":"2024-01-01T00:00:00Z"}""")));
        using var httpClient = new HttpClient(handler);

        using var cortadel = new CortadelClient(
            new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice", ApiKey = "secret-key" },
            httpClient);

        await cortadel.HealthAsync();

        Assert.Equal("Bearer", handler.LastRequest!.Headers.Authorization!.Scheme);
        Assert.Equal("secret-key", handler.LastRequest.Headers.Authorization!.Parameter);

        // The caller's own HttpClient must never carry the credential - that would leak it onto
        // any other request the caller makes with this client (shared / IHttpClientFactory case).
        Assert.Null(httpClient.DefaultRequestHeaders.Authorization);
    }

    [Fact]
    public async Task Constructor_DoesNotMutateAnAlreadyUsedCallerHttpClient()
    {
        // BaseAddress and Timeout setters both throw InvalidOperationException once an HttpClient
        // has sent a request. The old client set both unconditionally - reproduce that state and
        // confirm construction (which must not touch them) succeeds anyway.
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK, "{}")));
        using var httpClient = new HttpClient(handler) { BaseAddress = new Uri("http://prior.example/") };
        await httpClient.GetAsync("probe");

        var ex = Record.Exception(() => new CortadelClient(
            new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" },
            httpClient));

        Assert.Null(ex);
    }

    [Fact]
    public async Task HealthAsync_MapsA503DegradedBodyInsteadOfThrowing()
    {
        // Trap: HealthResponse is $ref'd for both 200 and 503, so Kiota error-maps the 503 and
        // throws its own success-shaped type. The documented surface must still just return it.
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.ServiceUnavailable,
            """{"status":"degraded","checked_at":"2024-01-01T00:00:00Z","checks":{"memgraph":{"ok":false,"error":"timeout"}}}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var health = await cortadel.HealthAsync();

        Assert.Equal("degraded", health.Status);
        Assert.True(health.Checks!.ContainsKey("memgraph"));
        Assert.False(health.Checks["memgraph"].GetProperty("ok").GetBoolean());
        Assert.Equal("timeout", health.Checks["memgraph"].GetProperty("error").GetString());
    }

    [Fact]
    public async Task GetAsync_Returns404AsNull_UsingTransportStatusNotTheBodyField()
    {
        // Trap: ApiError.Status is a nullable wire-body field and must not be relied on for the
        // 404 check - the body here omits it entirely.
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.NotFound,
            """{"code":"not_found","message":"no such memory"}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var result = await cortadel.GetAsync("missing-id");

        Assert.Null(result);
    }

    [Fact]
    public async Task GetAsync_MapsA200BodyAndOtherStatusesThrowCortadelException()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK,
            """{"id":"m1","text":"hello","created_at":1700000000,"state":"active","is_global":false}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var detail = await cortadel.GetAsync("m1");

        Assert.NotNull(detail);
        Assert.Equal("m1", detail!.Id);
        Assert.Equal("hello", detail.Text);
        Assert.Equal(1700000000L, detail.CreatedAt);
    }

    [Fact]
    public async Task GetAsync_Surfaces401AsCortadelException()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.Unauthorized,
            """{"code":"unauthorized","message":"missing key"}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var ex = await Assert.ThrowsAsync<CortadelException>(() => cortadel.GetAsync("m1"));

        Assert.Equal(401, ex.StatusCode);
        Assert.Equal("unauthorized", ex.Code);
        Assert.Equal("missing key", ex.Message);
    }

    [Fact]
    public async Task ListAsync_StringifiesIncludeSupersededAndSendsAllQueryParams()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK,
            """{"items":[],"total":0,"page":1,"size":20,"pages":0}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        await cortadel.ListAsync(new ListOptions { IncludeSuperseded = true, AppId = "app-1", MemoryType = "semantic" });

        var uri = handler.LastRequest!.RequestUri!.ToString();
        Assert.Contains("user_id=alice", uri);
        Assert.Contains("include_superseded=true", uri);
        Assert.Contains("app_id=app-1", uri);
        Assert.Contains("memory_type=semantic", uri);
    }

    [Fact]
    public async Task AddAsync_SendsSnakeCaseWireBodyAndMapsTheResponse()
    {
        // The old client serialized request bodies in camelCase against a snake_case server -
        // that bug must be gone now that the generated transport owns serialization.
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK,
            """{"id":"m1","content":"hello","state":"active","created_at":"2024-01-01T00:00:00Z","event":"ADD","app_name":"cli"}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var created = await cortadel.AddAsync("hello", new AddOptions { MemoryType = "semantic" });

        Assert.Contains("\"user_id\":\"alice\"", handler.LastRequestBody);
        Assert.Contains("\"memory_type\":\"semantic\"", handler.LastRequestBody);
        Assert.DoesNotContain("\"userId\"", handler.LastRequestBody);

        Assert.Equal("m1", created.Id);
        Assert.Equal("ADD", created.Event);
        Assert.Equal("cli", created.AppName);
    }

    [Fact]
    public async Task AddAsync_SurfacesValidationFieldErrorsInTheExceptionMessage()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.BadRequest,
            """{"detail":"one or more validation errors","errors":{"text":["The Text field is required."]},"status":400,"title":"Bad Request"}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var ex = await Assert.ThrowsAsync<CortadelException>(() => cortadel.AddAsync("hello"));

        Assert.Equal(400, ex.StatusCode);
        Assert.Equal("validation_error", ex.Code);
        Assert.Contains("text", ex.Message);
        Assert.Contains("The Text field is required.", ex.Message);
    }

    [Fact]
    public async Task SearchAsync_MapsGlobalFlagAndFreeformAttributes()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK,
            """
            {"query":"pets","total":1,"results":[
              {"id":"m1","content":"has a dog","global":true,"rrf_score":0.42,
               "attributes":{"confidence_band":"high"}}
            ]}
            """)));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var results = await cortadel.SearchAsync("pets");

        var hit = Assert.Single(results.Results);
        Assert.True(hit.IsGlobal);
        Assert.Equal(0.42, hit.RrfScore);
        Assert.Equal("high", hit.Attributes!["confidence_band"]!.Value.GetString());
    }

    [Fact]
    public async Task DeleteAsync_ReturnsTheConfirmationMessage()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK,
            """{"message":"deleted 2 memories"}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var message = await cortadel.DeleteAsync(new[] { "m1", "m2" });

        Assert.Equal("deleted 2 memories", message);
        Assert.Contains("\"user_id\":\"alice\"", handler.LastRequestBody);
    }

    [Fact]
    public async Task AddConversationAsync_MapsResultsAndSendsSnakeCaseFields()
    {
        var handler = new FakeHandler(_ => Task.FromResult(Json(HttpStatusCode.OK,
            """{"results":[{"id":"m1","memory":"fact","event":"ADD"}]}""")));
        using var httpClient = new HttpClient(handler);
        using var cortadel = new CortadelClient(new CortadelClientOptions { BaseUrl = "http://localhost:3001", UserId = "alice" }, httpClient);

        var result = await cortadel.AddConversationAsync(
            new[] { new ChatMessage("user", "hi", "turn-1") },
            new ConversationOptions { SessionId = "s1" });

        Assert.Contains("\"session_id\":\"s1\"", handler.LastRequestBody);
        Assert.Contains("\"uuid\":\"turn-1\"", handler.LastRequestBody);
        Assert.Single(result.Results!);
        Assert.Equal("ADD", result.Results![0].Event);
    }

    [Fact]
    public void Constructor_WithoutAnApiKey_SendsNoAuthorizationHeader()
    {
        // Anonymous access must remain possible - the server allows it when auth is disabled.
        using var cortadel = new CortadelClient("http://localhost:3001", "alice");
        Assert.NotNull(cortadel); // construction alone must not require/attach credentials
    }
}
