// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using System.ComponentModel;
using Cortadel.Sdk;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;

namespace Cortadel.AgentFramework;

/// <summary>Options shared by the two memory tool builders on <see cref="CortadelMemoryTools"/>.</summary>
public sealed class CortadelMemoryToolOptions
{
    /// <summary>Name the <c>search_memory</c> tool is exposed under to the model.</summary>
    public string SearchToolName { get; init; } = "search_memory";

    /// <summary>Name the <c>add_memories</c> tool is exposed under to the model.</summary>
    public string AddToolName { get; init; } = "add_memories";

    /// <summary>
    /// Result count <c>search_memory</c> uses when the model does not ask for one. Defaults to
    /// <c>10</c>, matching the Cortadel SDK's own <see cref="SearchOptions"/> default for an
    /// explicit search. (<see cref="CortadelContextProvider"/> recalls fewer, because it injects on
    /// every turn whether the agent wanted memories or not.)
    /// </summary>
    public int TopK { get; init; } = 10;

    /// <summary>Set to <c>cross_encoder</c> to rerank search results with the server's cross-encoder; omit to skip.</summary>
    public string? Rerank { get; init; }

    /// <summary>
    /// Forwarded to <c>add_memories</c>. <c>false</c> stores the text verbatim and skips background
    /// entity/category extraction (Cortadel's dedup still applies). Defaults to the server's <c>true</c>.
    /// </summary>
    public bool? Infer { get; init; }

    /// <summary>Pin the cognitive type written by <c>add_memories</c>: <c>episodic</c>, <c>semantic</c> or <c>procedural</c>.</summary>
    public string? MemoryType { get; init; }

    /// <summary>
    /// Propagate a Cortadel failure to the framework's function-invocation machinery instead of
    /// answering the model with a graceful "memory is unavailable" note. Defaults to <c>false</c> —
    /// a memory outage must never take the agent down.
    /// </summary>
    public bool ThrowOnError { get; init; }

    /// <summary>
    /// Invoked with the exception when a tool call fails. Replaces the warning log; the model still
    /// gets the graceful note unless <see cref="ThrowOnError"/> is set.
    /// </summary>
    public Action<Exception>? OnError { get; init; }

    /// <summary>Logger for swallowed, unobserved failures. Falls back to <see cref="Console.Error"/>.</summary>
    public ILogger? Logger { get; init; }
}

/// <summary>
/// Cortadel memory exposed as Agent Framework tools the agent can call itself.
/// </summary>
/// <remarks>
/// <para>
/// Where <see cref="CortadelContextProvider"/> gives an agent memory it never has to ask for, these
/// give it memory it can <i>choose</i> to use — recalling on demand mid-reasoning, or deliberately
/// committing something worth keeping.
/// </para>
/// <para>
/// Both are built with the framework's own tool primitive:
/// <see cref="AIFunctionFactory.Create(Delegate, string?, string?, System.Text.Json.JsonSerializerOptions?)"/>,
/// which derives the JSON schema from the delegate's signature and turns
/// <see cref="DescriptionAttribute"/> on each parameter into that parameter's description. The
/// result is an <see cref="AIFunction"/>, which is an <see cref="AITool"/> — exactly what
/// <c>ChatClientAgentOptions.ChatOptions.Tools</c> and <c>AIContext.Tools</c> accept.
/// </para>
/// </remarks>
public static class CortadelMemoryTools
{
    private const string SearchToolDescription =
        "Search long-term memory for facts about the user recalled from earlier conversations. " +
        "Call this before answering anything that may depend on prior context.";

    private const string AddToolDescription =
        "Save a durable fact to long-term memory so it can be recalled in future conversations. " +
        "Use for stable preferences, decisions and constraints.";

    private const string SearchFailedMessage = "Cortadel search_memory tool failed.";
    private const string AddFailedMessage = "Cortadel add_memories tool failed.";

    /// <summary>Build both memory tools for one client: <c>[search_memory, add_memories]</c>.</summary>
    /// <param name="client">
    /// The Cortadel client both tools are bound to. Bound at build time, so the tools are already
    /// scoped to that client's user — the model cannot reach another user's memories.
    /// </param>
    /// <param name="options">Tool options; <c>null</c> uses the defaults.</param>
    public static IList<AITool> CreateAll(ICortadelMemory client, CortadelMemoryToolOptions? options = null)
        => [CreateSearchMemoryTool(client, options), CreateAddMemoriesTool(client, options)];

    /// <summary>Build the <c>search_memory</c> tool bound to a Cortadel client.</summary>
    /// <param name="client">The Cortadel client to search. Bound at build time, so the tool is already scoped to that client's user.</param>
    /// <param name="options">Tool options; <c>null</c> uses the defaults.</param>
    public static AIFunction CreateSearchMemoryTool(ICortadelMemory client, CortadelMemoryToolOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(client);
        var opts = options ?? new CortadelMemoryToolOptions();

        // The model-facing parameter is deliberately named `top_k`, matching the Cortadel SDK's own
        // spelling — the JSON schema shows the model exactly the name the docs use.
        async Task<string> SearchMemoryAsync(
            [Description("What to recall, phrased as a natural-language question or topic.")] string query,
            [Description("How many memories to return (1-50). Defaults to 10.")] int? top_k = null,
            CancellationToken cancellationToken = default)
        {
            SearchResults results;
            try
            {
                results = await client.SearchAsync(
                    query,
                    new SearchOptions
                    {
                        TopK = ClampTopK(top_k, opts.TopK),
                        Rerank = opts.Rerank,
                    },
                    cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
#pragma warning disable CA1031 // fail open: a memory outage must not take the agent down
            catch (Exception exception)
#pragma warning restore CA1031
            {
                MemoryFailure.Report(exception, SearchFailedMessage, opts.Logger, opts.ThrowOnError, opts.OnError);
                return "Memory is temporarily unavailable; answer without it.";
            }

            var lines = (results.Results ?? [])
                .Select(RenderHit)
                .Where(line => line.Length > 0)
                .Select(line => "- " + line)
                .ToList();

            return lines.Count > 0 ? string.Join("\n", lines) : $"No memories found for: {query}";
        }

        return AIFunctionFactory.Create(
            SearchMemoryAsync,
            name: opts.SearchToolName,
            description: SearchToolDescription);
    }

    /// <summary>Build the <c>add_memories</c> tool bound to a Cortadel client.</summary>
    /// <param name="client">The Cortadel client to write to. Bound at build time, so writes always land in that client's user namespace.</param>
    /// <param name="options">Tool options; <c>null</c> uses the defaults.</param>
    public static AIFunction CreateAddMemoriesTool(ICortadelMemory client, CortadelMemoryToolOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(client);
        var opts = options ?? new CortadelMemoryToolOptions();

        async Task<string> AddMemoriesAsync(
            [Description("The fact to remember, written as one self-contained sentence.")] string text,
            CancellationToken cancellationToken = default)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return "Nothing to remember: the text was empty.";
            }

            MemoryCreated created;
            try
            {
                created = await client.AddAsync(
                    text,
                    new AddOptions
                    {
                        App = CortadelMemoryClient.DefaultAppName,
                        Infer = opts.Infer,
                        MemoryType = opts.MemoryType,
                    },
                    cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
#pragma warning disable CA1031 // fail open: a memory outage must not take the agent down
            catch (Exception exception)
#pragma warning restore CA1031
            {
                MemoryFailure.Report(exception, AddFailedMessage, opts.Logger, opts.ThrowOnError, opts.OnError);
                return "Memory is temporarily unavailable; the fact was not saved.";
            }

            // A 2xx does not mean a new memory was written — Cortadel reports what the store
            // pipeline actually decided (ADD, SKIP_DUPLICATE, SUPERSEDE, TOUCH, ...).
            return created.Event == "SKIP_DUPLICATE"
                ? "Already remembered; nothing new was stored."
                : $"Remembered (event: {created.Event ?? "ADD"}).";
        }

        return AIFunctionFactory.Create(
            AddMemoriesAsync,
            name: opts.AddToolName,
            description: AddToolDescription);
    }

    /// <summary>Render one hit as a single memory line, preferring the server's distilled gist.</summary>
    internal static string RenderHit(SearchHit hit)
    {
        var text = hit.Gist;
        if (string.IsNullOrWhiteSpace(text))
        {
            text = hit.Content;
        }

        return string.IsNullOrWhiteSpace(text)
            ? string.Empty
            : text.Replace("\r\n", " ").Replace('\n', ' ').Replace('\r', ' ').Trim();
    }

    /// <summary>Clamp a model-supplied <c>top_k</c> into the 1-50 range Cortadel accepts.</summary>
    internal static int ClampTopK(int? requested, int fallback)
    {
        var value = requested is > 0 ? requested.Value : fallback;
        return Math.Max(1, Math.Min(50, value));
    }
}
