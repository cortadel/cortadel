// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using Cortadel.Sdk;

namespace Cortadel.AgentFramework;

/// <summary>
/// The three <see cref="CortadelClient"/> calls this package makes, behind an interface.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="CortadelClient"/> is a <c>sealed class</c>, so there is no way to substitute it in a
/// test. This interface is the seam: it mirrors the three SDK methods used here
/// (<c>SearchAsync</c>, <c>AddConversationAsync</c>, <c>AddAsync</c>) with the same signatures and
/// the same DTOs, adds nothing of its own, and lets the offline test suite stub Cortadel without a
/// server, a network or an API key. <see cref="CortadelMemoryClient"/> is the real implementation.
/// </para>
/// <para>
/// <b>One instance per user.</b> Every Cortadel call is scoped to the <c>UserId</c> given when the
/// underlying client was constructed — no method takes a user id per call. Per-user scoping
/// therefore means one client (and one <see cref="CortadelContextProvider"/>) per end user.
/// </para>
/// </remarks>
public interface ICortadelMemory
{
    /// <summary>Hybrid search (BM25 + vector + RRF, optional cross-encoder rerank).</summary>
    Task<SearchResults> SearchAsync(string query, SearchOptions? options = null, CancellationToken cancellationToken = default);

    /// <summary>Distill a multi-turn conversation into atomic facts and store each one.</summary>
    Task<ConversationResult> AddConversationAsync(IEnumerable<ChatMessage> messages, ConversationOptions? options = null, CancellationToken cancellationToken = default);

    /// <summary>Store a single memory.</summary>
    Task<MemoryCreated> AddAsync(string text, AddOptions? options = null, CancellationToken cancellationToken = default);
}

/// <summary>
/// The real <see cref="ICortadelMemory"/>: a thin pass-through to a <see cref="CortadelClient"/>.
/// </summary>
public sealed class CortadelMemoryClient : ICortadelMemory, IDisposable
{
    /// <summary>
    /// App name this integration records on Cortadel access logs. It is the published package id,
    /// verbatim, which is what the Cortadel integration docs promise for every integration.
    /// </summary>
    public const string DefaultAppName = "Cortadel.AgentFramework";

    private readonly bool _ownsClient;
    private bool _disposed;

    /// <summary>Wrap a Cortadel client you already own.</summary>
    /// <param name="client">The client to delegate to.</param>
    /// <param name="ownsClient">
    /// When <c>true</c>, <see cref="Dispose"/> disposes <paramref name="client"/>. Defaults to
    /// <c>false</c>, mirroring the Cortadel SDK's own rule that a caller-supplied client's
    /// lifetime belongs to the caller.
    /// </param>
    public CortadelMemoryClient(CortadelClient client, bool ownsClient = false)
    {
        Client = client ?? throw new ArgumentNullException(nameof(client));
        _ownsClient = ownsClient;
    }

    /// <summary>Build a Cortadel client for one user and wrap it (this wrapper owns it).</summary>
    /// <param name="baseUrl">Server URL, e.g. <c>https://app.cortadel.ai</c> or <c>http://localhost:3001</c>.</param>
    /// <param name="userId">The user whose memories this client reads and writes.</param>
    /// <param name="apiKey">Bearer token. Omit when the server runs with auth disabled.</param>
    /// <param name="appName">App name recorded for access logging on searches.</param>
    public static CortadelMemoryClient Create(
        string baseUrl,
        string userId,
        string? apiKey = null,
        string appName = DefaultAppName)
        => new(
            new CortadelClient(new CortadelClientOptions
            {
                BaseUrl = baseUrl,
                UserId = userId,
                ApiKey = apiKey,
                AppName = appName,
            }),
            ownsClient: true);

    /// <summary>The wrapped client, for direct access to the seven Cortadel SDK methods.</summary>
    public CortadelClient Client { get; }

    /// <inheritdoc/>
    public Task<SearchResults> SearchAsync(string query, SearchOptions? options = null, CancellationToken cancellationToken = default)
        => Client.SearchAsync(query, options, cancellationToken);

    /// <inheritdoc/>
    public Task<ConversationResult> AddConversationAsync(IEnumerable<ChatMessage> messages, ConversationOptions? options = null, CancellationToken cancellationToken = default)
        => Client.AddConversationAsync(messages, options, cancellationToken);

    /// <inheritdoc/>
    public Task<MemoryCreated> AddAsync(string text, AddOptions? options = null, CancellationToken cancellationToken = default)
        => Client.AddAsync(text, options, cancellationToken);

    /// <inheritdoc/>
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (_ownsClient)
        {
            Client.Dispose();
        }
    }
}
