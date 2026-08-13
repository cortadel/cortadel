// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using Cortadel.Sdk;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using CortadelChatMessage = Cortadel.Sdk.ChatMessage;
using SdkSearchOptions = Cortadel.Sdk.SearchOptions;

namespace Cortadel.AgentFramework;

/// <summary>
/// Cortadel long-term memory as a Microsoft Agent Framework <see cref="AIContextProvider"/>.
/// </summary>
/// <remarks>
/// <para>
/// This is the framework's own memory seam. The provider overrides the two extension points the
/// base class defines for it:
/// </para>
/// <list type="bullet">
///   <item><description>
///     <see cref="ProvideAIContextAsync"/> — hybrid-searches Cortadel with the current turn's input
///     and returns an <see cref="AIContext"/> the framework merges into the invocation, so the model
///     sees the memories without the agent asking.
///   </description></item>
///   <item><description>
///     <see cref="StoreAIContextAsync"/> — hands the completed turn to Cortadel's conversation
///     pipeline, which distils durable facts out of it off the request path.
///   </description></item>
/// </list>
/// <para>
/// Attach it through <c>ChatClientAgentOptions.AIContextProviders</c>:
/// </para>
/// <code>
/// await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
/// {
///     BaseUrl = "http://localhost:3001",
///     UserId = "e2e-alice",
/// });
///
/// AIAgent agent = chatClient.AsAIAgent(new ChatClientAgentOptions
/// {
///     AIContextProviders = [memory],
/// });
/// </code>
/// <para>
/// <b>One provider instance per user.</b> A Cortadel client is bound to a single user id at
/// construction — no Cortadel method takes a user id per call — so a provider instance <i>is</i> a
/// per-user object. Never share one across end users; build one per user and cache it.
/// </para>
/// <para>
/// <b>Sessions.</b> Cortadel's <c>SessionId</c> comes from
/// <see cref="ChatClientAgentSession.ConversationId"/> when the chat service manages the thread; for
/// a client-managed session (where that id is <c>null</c>) the provider mints one and keeps it in
/// <c>AgentSession.StateBag</c>, so it survives session serialization. Turns are <i>written</i>
/// tagged with the session, but <i>recalled</i> across every session by default — which is what
/// makes this long-term memory rather than a transcript buffer. Set
/// <see cref="CortadelContextProviderOptions.ScopeRecallToSession"/> to restrict recall to the live
/// session.
/// </para>
/// <para>
/// <b>Failure behaviour.</b> Every Cortadel call is best-effort and fails open: transport errors,
/// HTTP errors and unexpected exceptions are swallowed so a memory outage cannot take the agent
/// down. Set <see cref="CortadelContextProviderOptions.OnError"/> to observe them, or
/// <see cref="CortadelContextProviderOptions.ThrowOnError"/> to propagate them instead; a failure
/// that is neither observed nor propagated is logged as a warning.
/// <see cref="OperationCanceledException"/> is deliberately rethrown — cancellation is the caller's
/// intent, not a Cortadel failure.
/// </para>
/// <para>
/// <b>Security.</b> The base class documents that context providers are trusted: whatever this
/// returns is merged into the request as-is. Memories are user-authored text from an earlier
/// conversation, so treat a Cortadel instance you do not control as an indirect-prompt-injection
/// source, exactly as you would any retrieval corpus.
/// </para>
/// </remarks>
public sealed class CortadelContextProvider : AIContextProvider, IAsyncDisposable
{
    /// <summary>Prepended to the injected block. Deliberately generic: Cortadel is domain-agnostic.</summary>
    public const string DefaultContextPrompt =
        "## Memories\n" +
        "Consider the following memories about this user when answering. They come from earlier " +
        "conversations and may be incomplete — prefer what the user says now if they conflict.";

    private const string SearchFailedMessage = "Cortadel search failed; continuing without memories.";
    private const string StoreFailedMessage = "Cortadel AddConversation failed; this turn was not stored.";

    private readonly CortadelContextProviderOptions _options;
    private readonly ICortadelMemory _client;
    private readonly bool _ownsClient;
    private readonly IReadOnlyList<string> _stateKeys;
    private readonly string _injectedIdsKey;
    private readonly string _sessionIdKey;
    private readonly IList<AITool>? _tools;

    // In-flight fire-and-forget writes (AwaitPersist = false), drained by DisposeAsync. Held in a
    // strong reference: an untracked Task can be collected mid-write.
    private readonly HashSet<Task> _pending = [];
    private readonly object _pendingLock = new();
    private bool _disposed;

    /// <summary>Create a provider from full options.</summary>
    /// <param name="options">Provider configuration. See <see cref="CortadelContextProviderOptions"/>.</param>
    /// <exception cref="ArgumentException">Neither <c>Client</c> nor both <c>BaseUrl</c> and <c>UserId</c> were given, or <c>TopK</c>/<c>MaxRememberedIds</c> are out of range.</exception>
    public CortadelContextProvider(CortadelContextProviderOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (options.TopK < 1)
        {
            throw new ArgumentException($"TopK must be at least 1, got: {options.TopK}", nameof(options));
        }

        if (options.MaxRememberedIds < 0)
        {
            throw new ArgumentException($"MaxRememberedIds must not be negative, got: {options.MaxRememberedIds}", nameof(options));
        }

        if (options.Client is not null)
        {
            _client = options.Client;
            _ownsClient = false;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(options.BaseUrl) || string.IsNullOrWhiteSpace(options.UserId))
            {
                throw new ArgumentException(
                    "CortadelContextProvider needs either a pre-built Client, or both BaseUrl and UserId.",
                    nameof(options));
            }

            // Let the SDK validate BaseUrl/UserId — it throws with a good message.
            _client = CortadelMemoryClient.Create(options.BaseUrl, options.UserId, options.ApiKey, options.AppName);
            _ownsClient = true;
        }

        _options = options;

        var prefix = string.IsNullOrWhiteSpace(options.StateKeyPrefix)
            ? nameof(CortadelContextProvider)
            : options.StateKeyPrefix!;
        _injectedIdsKey = prefix + ".InjectedMemoryIds";
        _sessionIdKey = prefix + ".SessionId";
        _stateKeys = [_injectedIdsKey, _sessionIdKey];

        // Built once, not per turn: an AIFunction is stateless and reflecting a schema on every
        // invocation would be pure waste.
        _tools = options.IncludeMemoryTools
            ? CortadelMemoryTools.CreateAll(_client, new CortadelMemoryToolOptions
            {
                ThrowOnError = options.ThrowOnError,
                OnError = options.OnError,
                Logger = options.Logger,
            })
            : null;
    }

    /// <summary>Convenience constructor: <c>new CortadelContextProvider("http://localhost:3001", "e2e-alice")</c>.</summary>
    /// <param name="baseUrl">Cortadel server URL.</param>
    /// <param name="userId">The user whose memories this provider reads and writes.</param>
    /// <param name="apiKey">Bearer token. Omit when the server runs with auth disabled.</param>
    public CortadelContextProvider(string baseUrl, string userId, string? apiKey = null)
        : this(new CortadelContextProviderOptions { BaseUrl = baseUrl, UserId = userId, ApiKey = apiKey })
    {
    }

    /// <summary>The Cortadel client this provider reads and writes through.</summary>
    public ICortadelMemory Client => _client;

    /// <inheritdoc/>
    /// <remarks>
    /// Two keys: the ids already injected in this session (so a long conversation does not re-pay
    /// for the same context) and the minted Cortadel session id. Both live in
    /// <c>AgentSession.StateBag</c> rather than in fields on this object, because one provider
    /// serves many sessions.
    /// </remarks>
    public override IReadOnlyList<string> StateKeys => _stateKeys;

    // ── Recall: before the model call ────────────────────────────────────────────────────────

    /// <summary>
    /// Search Cortadel for memories relevant to this turn and return them as additional context.
    /// </summary>
    /// <remarks>
    /// The base class hands this the input messages already filtered by
    /// <c>ProvideInputMessageFilter</c> (user-role messages by default), merges whatever is returned
    /// into the invocation's context, and stamps the returned messages with
    /// <c>AgentRequestMessageSourceType.AIContextProvider</c> attribution.
    /// </remarks>
    /// <param name="context">The invocation being prepared.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    protected override async ValueTask<AIContext> ProvideAIContextAsync(
        InvokingContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);

        var result = new AIContext();
        if (_tools is not null)
        {
            result.Tools = _tools;
        }

        SearchResults hits;
        try
        {
            // Reading the turn's text is inside the guard too: the "never takes your agent down"
            // promise has to cover the whole recall path, not just the network call.
            var query = BuildQuery(context.AIContext.Messages);
            if (query.Length == 0)
            {
                return result;
            }

            hits = await _client.SearchAsync(
                query,
                new SdkSearchOptions
                {
                    TopK = _options.TopK,
                    Mode = _options.SearchMode,
                    Rerank = _options.Rerank,
                    MemoryType = _options.MemoryType,
                    SessionId = _options.ScopeRecallToSession ? SessionIdFor(context.Session) : null,
                },
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // degrade to "no memory", never take the agent down (unless asked to)
        catch (Exception exception)
#pragma warning restore CA1031
        {
            Report(exception, SearchFailedMessage);
            return result;
        }

        var results = (IReadOnlyList<SearchHit>)(hits.Results ?? []);
        if (_options.DeduplicateAcrossTurns)
        {
            results = DropAlreadyInjected(results, context.Session);
        }

        var lines = results
            .Select(CortadelMemoryTools.RenderHit)
            .Where(line => line.Length > 0)
            .Select(line => "- " + line)
            .ToList();

        if (lines.Count == 0)
        {
            return result;
        }

        var rendered = _options.ContextPrompt + "\n" + string.Join("\n", lines);
        if (_options.InjectAs == MemoryInjectionMode.Instructions)
        {
            result.Instructions = rendered;
        }
        else
        {
            result.Messages = [new Microsoft.Extensions.AI.ChatMessage(ChatRole.User, rendered)];
        }

        if (_options.DeduplicateAcrossTurns)
        {
            Remember(results, context.Session);
        }

        return result;
    }

    // ── Persist: after the turn ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Persist the completed turn to Cortadel's conversation pipeline.
    /// </summary>
    /// <remarks>
    /// The base class calls this only when the invocation succeeded, and only with request messages
    /// that passed <c>StoreInputRequestMessageFilter</c> — which by default keeps just the caller's
    /// own new user input, so replayed chat history and provider-injected context (this provider's
    /// memories included) are already excluded. <see cref="IsIngestible"/> re-checks the source
    /// attribution anyway, because a caller can hand this method a pre-composed turn.
    /// </remarks>
    /// <param name="context">The completed invocation.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    protected override async ValueTask StoreAIContextAsync(
        InvokedContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);

        if (!_options.StoreTurns)
        {
            return;
        }

        List<CortadelChatMessage> turn;
        ConversationOptions conversationOptions;
        try
        {
            turn = ToCortadelMessages(context.RequestMessages)
                .Concat(ToCortadelMessages(context.ResponseMessages))
                .ToList();

            if (turn.Count == 0)
            {
                return;
            }

            conversationOptions = new ConversationOptions
            {
                IsAgentMemory = _options.IsAgentMemory,
                Tags = _options.Tags?.ToArray(),
                Project = _options.Project,
                SessionId = SessionIdFor(context.Session),
            };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // a malformed message must cost you this turn's memory, not the turn
        catch (Exception exception)
#pragma warning restore CA1031
        {
            Report(exception, StoreFailedMessage);
            return;
        }

        if (_options.AwaitPersist)
        {
            await PersistAsync(turn, conversationOptions, propagate: true, cancellationToken).ConfigureAwait(false);
            return;
        }

        // Fire-and-forget. The write must outlive this turn's cancellation token — the token is
        // cancelled when the run completes, which is exactly when this task is still going.
        var task = Task.Run(() => PersistAsync(turn, conversationOptions, propagate: false, CancellationToken.None));
        lock (_pendingLock)
        {
            _pending.Add(task);
        }

        _ = task.ContinueWith(
            static (completed, state) =>
            {
                var provider = (CortadelContextProvider)state!;
                lock (provider._pendingLock)
                {
                    provider._pending.Remove(completed);
                }
            },
            this,
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    /// <summary>Send one composed turn to Cortadel, reporting a failure rather than letting it escape.</summary>
    /// <remarks>
    /// <paramref name="propagate"/> is <c>false</c> on the fire-and-forget path: the turn has already
    /// returned, so there is no caller left for <c>ThrowOnError</c> to throw into and the failure
    /// would become an unobserved <see cref="Task"/> exception. It is observed or logged instead.
    /// </remarks>
    private async Task PersistAsync(
        List<CortadelChatMessage> turn,
        ConversationOptions options,
        bool propagate,
        CancellationToken cancellationToken)
    {
        try
        {
            await _client.AddConversationAsync(turn, options, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // fail open
        catch (Exception exception)
#pragma warning restore CA1031
        {
            Report(exception, StoreFailedMessage, propagate);
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Flush pending fire-and-forget writes, then dispose the Cortadel client if this provider
    /// created it.
    /// </summary>
    /// <remarks>
    /// The framework never disposes a provider, so this is yours to call — and it is the only thing
    /// that makes <c>AwaitPersist = false</c> safe in a short-lived process. A client you supplied
    /// through <see cref="CortadelContextProviderOptions.Client"/> is never disposed here; pending
    /// writes are still drained, because they belong to this provider whoever owns the client.
    /// </remarks>
    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        await DrainAsync().ConfigureAwait(false);

        if (_ownsClient && _client is IDisposable disposable)
        {
            disposable.Dispose();
        }
    }

    /// <summary>Await every in-flight background write.</summary>
    /// <remarks>
    /// The set is snapshotted and cleared before awaiting: the removal continuation runs on another
    /// scheduler pass, so a "wait until the set empties" loop would spin on tasks that have already
    /// finished but not yet been discarded.
    /// </remarks>
    private async Task DrainAsync()
    {
        while (true)
        {
            Task[] inFlight;
            lock (_pendingLock)
            {
                if (_pending.Count == 0)
                {
                    return;
                }

                inFlight = [.. _pending];
                _pending.Clear();
            }

            // Failures were already reported inside PersistAsync; this only waits for the writes.
            try
            {
                await Task.WhenAll(inFlight).ConfigureAwait(false);
            }
#pragma warning disable CA1031
            catch (Exception)
#pragma warning restore CA1031
            {
                // Already reported. Draining must not throw out of DisposeAsync.
            }
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    private void Report(Exception exception, string message, bool propagate = true)
        => MemoryFailure.Report(exception, message, _options.Logger, _options.ThrowOnError, _options.OnError, propagate);

    /// <summary>Build the retrieval query from the turn's (already filtered) input messages.</summary>
    internal static string BuildQuery(IEnumerable<Microsoft.Extensions.AI.ChatMessage>? messages)
    {
        if (messages is null)
        {
            return string.Empty;
        }

        var parts = messages
            .Where(message => message is not null)
            .Select(message => message.Text)
            .Where(text => !string.IsNullOrWhiteSpace(text))
            .Select(text => text.Trim());

        return string.Join("\n", parts);
    }

    /// <summary>
    /// Map framework messages onto Cortadel <see cref="CortadelChatMessage"/>s, dropping tool /
    /// function plumbing, empty text, and anything a context provider or the chat history injected.
    /// </summary>
    /// <remarks>
    /// Skipping provider-sourced messages is what stops the feedback loop: without it, a memory this
    /// provider recalled would be written back as if the user had said it, amplifying it a little
    /// more on every turn.
    /// </remarks>
    internal static List<CortadelChatMessage> ToCortadelMessages(IEnumerable<Microsoft.Extensions.AI.ChatMessage>? messages)
    {
        var output = new List<CortadelChatMessage>();
        if (messages is null)
        {
            return output;
        }

        foreach (var message in messages)
        {
            if (message is null || !IsIngestible(message))
            {
                continue;
            }

            output.Add(new CortadelChatMessage(message.Role.Value, message.Text, message.MessageId));
        }

        return output;
    }

    private static bool IsIngestible(Microsoft.Extensions.AI.ChatMessage message)
    {
        if (message.GetAgentRequestMessageSourceType() != AgentRequestMessageSourceType.External)
        {
            return false;
        }

        var role = message.Role.Value;
        if (role != ChatRole.User.Value && role != ChatRole.Assistant.Value && role != ChatRole.System.Value)
        {
            return false;
        }

        return !string.IsNullOrWhiteSpace(message.Text);
    }

    /// <summary>
    /// The Cortadel session id for this agent session: the chat service's own conversation id when
    /// there is one, otherwise a stable id minted once and kept in the session state bag.
    /// </summary>
    internal string? SessionIdFor(AgentSession? session)
    {
        if (session is null)
        {
            return null;
        }

        if (session is ChatClientAgentSession { ConversationId: { Length: > 0 } conversationId })
        {
            return conversationId;
        }

        if (session.StateBag.TryGetValue<string>(_sessionIdKey, out var stored) && !string.IsNullOrEmpty(stored))
        {
            return stored;
        }

        var minted = Guid.NewGuid().ToString("N");
        session.StateBag.SetValue(_sessionIdKey, minted);
        return minted;
    }

    private List<string> InjectedIds(AgentSession? session)
        => session is not null && session.StateBag.TryGetValue<List<string>>(_injectedIdsKey, out var stored) && stored is not null
            ? stored
            : [];

    private IReadOnlyList<SearchHit> DropAlreadyInjected(IReadOnlyList<SearchHit> hits, AgentSession? session)
    {
        var seen = InjectedIds(session);
        if (seen.Count == 0)
        {
            return hits;
        }

        var seenSet = new HashSet<string>(seen, StringComparer.Ordinal);
        return hits.Where(hit => !seenSet.Contains(hit.Id)).ToList();
    }

    /// <summary>Record the injected ids in session state, newest last, bounded in size.</summary>
    private void Remember(IReadOnlyList<SearchHit> hits, AgentSession? session)
    {
        if (session is null)
        {
            return;
        }

        var remembered = InjectedIds(session);
        var known = new HashSet<string>(remembered, StringComparer.Ordinal);
        foreach (var hit in hits)
        {
            if (!string.IsNullOrEmpty(hit.Id) && known.Add(hit.Id))
            {
                remembered.Add(hit.Id);
            }
        }

        if (_options.MaxRememberedIds == 0)
        {
            // A cap of zero means remember nothing. Special-cased so it cannot be mistaken for
            // "unbounded" — the exact opposite of the cap the caller asked for.
            remembered = [];
        }
        else if (remembered.Count > _options.MaxRememberedIds)
        {
            remembered = remembered.GetRange(remembered.Count - _options.MaxRememberedIds, _options.MaxRememberedIds);
        }

        session.StateBag.SetValue(_injectedIdsKey, remembered);
    }
}
