// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using Microsoft.Extensions.Logging;

namespace Cortadel.AgentFramework;

/// <summary>Where <see cref="CortadelContextProvider"/> puts the memories it recalled.</summary>
public enum MemoryInjectionMode
{
    /// <summary>Inject a user-role context message carrying the memory block. The default.</summary>
    Message,

    /// <summary>Append the memory block to the invocation's system instructions instead.</summary>
    Instructions,
}

/// <summary>Configuration for a <see cref="CortadelContextProvider"/>.</summary>
/// <remarks>
/// Either set <see cref="BaseUrl"/> and <see cref="UserId"/> and let the provider build (and own) a
/// Cortadel client, or set <see cref="Client"/> to one you own yourself.
/// </remarks>
public sealed class CortadelContextProviderOptions
{
    /// <summary>Cortadel server URL, e.g. <c>https://app.cortadel.ai</c> or <c>http://localhost:3001</c>. Required unless <see cref="Client"/> is set.</summary>
    public string? BaseUrl { get; init; }

    /// <summary>The user whose memories this provider reads and writes. Required unless <see cref="Client"/> is set. Every call is scoped to it.</summary>
    public string? UserId { get; init; }

    /// <summary>Bearer token. Omit when the server runs with auth disabled.</summary>
    public string? ApiKey { get; init; }

    /// <summary>App name Cortadel records for access logging on searches.</summary>
    public string AppName { get; init; } = CortadelMemoryClient.DefaultAppName;

    /// <summary>
    /// A pre-built Cortadel client. When set, <see cref="BaseUrl"/>/<see cref="UserId"/>/
    /// <see cref="ApiKey"/>/<see cref="AppName"/> are ignored and <b>you</b> own its lifetime — the
    /// provider will not dispose it.
    /// </summary>
    public ICortadelMemory? Client { get; init; }

    /// <summary>Maximum memories to recall per turn (Cortadel accepts 1-50).</summary>
    public int TopK { get; init; } = 5;

    /// <summary>Search mode: <c>hybrid</c> (default), <c>text</c> or <c>vector</c>.</summary>
    public string SearchMode { get; init; } = "hybrid";

    /// <summary>Set to <c>cross_encoder</c> to rerank with the server's cross-encoder. Cortadel accepts no other value; omit to skip.</summary>
    public string? Rerank { get; init; }

    /// <summary>Restrict recall to one cognitive type: <c>episodic</c>, <c>semantic</c> or <c>procedural</c>.</summary>
    public string? MemoryType { get; init; }

    /// <summary>Header placed above the injected memories.</summary>
    public string ContextPrompt { get; init; } = CortadelContextProvider.DefaultContextPrompt;

    /// <summary>Where the recalled memories go: a context message (default) or the system instructions.</summary>
    public MemoryInjectionMode InjectAs { get; init; } = MemoryInjectionMode.Message;

    /// <summary>
    /// Restrict recall to the current agent session (the framework's word for a thread of turns).
    /// Off by default — cross-session recall is the point of long-term memory.
    /// </summary>
    public bool ScopeRecallToSession { get; init; }

    /// <summary>Skip memories already injected earlier in this session, so a long conversation does not re-pay for the same context every turn.</summary>
    public bool DeduplicateAcrossTurns { get; init; } = true;

    /// <summary>Cap on remembered ids per session, bounding session-state growth. <c>0</c> remembers nothing, so every hit stays eligible for re-injection each turn.</summary>
    public int MaxRememberedIds { get; init; } = 256;

    /// <summary>Persist each completed turn via Cortadel's conversation pipeline. Set <c>false</c> for a read-only agent.</summary>
    public bool StoreTurns { get; init; } = true;

    /// <summary>
    /// Await the write before the turn returns. <b>Defaults to <c>true</c></b>, unlike most Cortadel
    /// integrations: the framework never disposes a provider, so a program that returns from
    /// <c>RunAsync</c> and exits would drop an in-flight write. Set <c>false</c> to take the write
    /// off the turn's critical path — then you must dispose the provider
    /// (<see cref="CortadelContextProvider.DisposeAsync"/>) to flush it, and a failed write can only
    /// be seen through <see cref="OnError"/>.
    /// </summary>
    public bool AwaitPersist { get; init; } = true;

    /// <summary>Extract facts about the <i>assistant</i> rather than the user.</summary>
    public bool IsAgentMemory { get; init; }

    /// <summary>Tags applied to every fact extracted from stored turns.</summary>
    public IReadOnlyList<string>? Tags { get; init; }

    /// <summary>Project scope (e.g. a repo name) applied to stored turns.</summary>
    public string? Project { get; init; }

    /// <summary>Also offer <c>search_memory</c> and <c>add_memories</c> as tools for this invocation, so one attachment gives both automatic and deliberate memory. Tool defaults are independent of this provider's (see <see cref="CortadelMemoryToolOptions"/>).</summary>
    public bool IncludeMemoryTools { get; init; }

    /// <summary>Propagate Cortadel failures to the caller instead of swallowing them. Defaults to <c>false</c> — a memory outage must never take the agent down.</summary>
    public bool ThrowOnError { get; init; }

    /// <summary>Invoked with the exception when a Cortadel call fails. Replaces the warning log; use it to route failures into your own telemetry. A callback that itself throws is logged and swallowed.</summary>
    public Action<Exception>? OnError { get; init; }

    /// <summary>Logger for swallowed, unobserved failures. Falls back to <see cref="Console.Error"/>.</summary>
    public ILogger? Logger { get; init; }

    /// <summary>
    /// Prefix for this provider's <c>AgentSession.StateBag</c> keys. Defaults to
    /// <c>"CortadelContextProvider"</c>. Give each one a distinct prefix when attaching more than
    /// one provider to the same agent — <c>ChatClientAgent</c> rejects duplicate state keys.
    /// </summary>
    public string? StateKeyPrefix { get; init; }
}
