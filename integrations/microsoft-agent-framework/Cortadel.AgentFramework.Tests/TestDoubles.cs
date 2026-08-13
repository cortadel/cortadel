// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using System.Runtime.CompilerServices;
using Cortadel.AgentFramework;
using Cortadel.Sdk;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using CortadelChatMessage = Cortadel.Sdk.ChatMessage;
using SdkSearchOptions = Cortadel.Sdk.SearchOptions;

namespace Cortadel.AgentFramework.Tests;

/// <summary>One recorded call to <see cref="FakeCortadelMemory.SearchAsync"/>.</summary>
internal sealed record SearchCall(string Query, SdkSearchOptions? Options);

/// <summary>One recorded call to <see cref="FakeCortadelMemory.AddConversationAsync"/>.</summary>
internal sealed record ConversationCall(IReadOnlyList<CortadelChatMessage> Messages, ConversationOptions? Options);

/// <summary>One recorded call to <see cref="FakeCortadelMemory.AddAsync"/>.</summary>
internal sealed record AddCall(string Text, AddOptions? Options);

/// <summary>
/// The Cortadel boundary, stubbed. No server, no network, no key — the whole suite runs offline.
/// </summary>
internal sealed class FakeCortadelMemory : ICortadelMemory
{
    private readonly TaskCompletionSource<bool> _released = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public List<SearchCall> Searches { get; } = [];

    public List<ConversationCall> Conversations { get; } = [];

    public List<AddCall> Adds { get; } = [];

    /// <summary>Hits the next search returns.</summary>
    public List<SearchHit> Hits { get; set; } = [];

    /// <summary>Result the next <see cref="AddAsync"/> returns.</summary>
    public MemoryCreated Created { get; set; } = new() { Id = "m-new", Event = "ADD" };

    public Exception? SearchThrows { get; set; }

    public Exception? ConversationThrows { get; set; }

    public Exception? AddThrows { get; set; }

    /// <summary>When true, <see cref="AddConversationAsync"/> blocks until <see cref="Release"/> is called.</summary>
    public bool BlockConversation { get; set; }

    public void Release() => _released.TrySetResult(true);

    public Task<SearchResults> SearchAsync(string query, SdkSearchOptions? options = null, CancellationToken cancellationToken = default)
    {
        Searches.Add(new SearchCall(query, options));
        if (SearchThrows is not null)
        {
            return Task.FromException<SearchResults>(SearchThrows);
        }

        return Task.FromResult(new SearchResults { Query = query, Results = [.. Hits], Total = Hits.Count });
    }

    public async Task<ConversationResult> AddConversationAsync(IEnumerable<CortadelChatMessage> messages, ConversationOptions? options = null, CancellationToken cancellationToken = default)
    {
        if (BlockConversation)
        {
            await _released.Task.ConfigureAwait(false);
        }

        Conversations.Add(new ConversationCall([.. messages], options));
        if (ConversationThrows is not null)
        {
            throw ConversationThrows;
        }

        return new ConversationResult { Results = [new ConversationIngestItem { Id = "m-1", Memory = "fact", Event = "ADD" }] };
    }

    public Task<MemoryCreated> AddAsync(string text, AddOptions? options = null, CancellationToken cancellationToken = default)
    {
        Adds.Add(new AddCall(text, options));
        return AddThrows is not null
            ? Task.FromException<MemoryCreated>(AddThrows)
            : Task.FromResult(Created);
    }
}

/// <summary>
/// A chat client that never calls a model: it records what the agent sent and replies with a fixed
/// message. Keeps the end-to-end test offline and keyless.
/// </summary>
internal sealed class StubChatClient : IChatClient
{
    public List<List<Microsoft.Extensions.AI.ChatMessage>> Requests { get; } = [];

    public List<ChatOptions?> RequestOptions { get; } = [];

    public string Reply { get; set; } = "Sure thing.";

    public Task<ChatResponse> GetResponseAsync(IEnumerable<Microsoft.Extensions.AI.ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        Requests.Add([.. messages]);
        RequestOptions.Add(options);
        return Task.FromResult(new ChatResponse(new Microsoft.Extensions.AI.ChatMessage(ChatRole.Assistant, Reply)));
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<Microsoft.Extensions.AI.ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await GetResponseAsync(messages, options, cancellationToken).ConfigureAwait(false);
        foreach (var update in response.ToChatResponseUpdates())
        {
            yield return update;
        }
    }

    public object? GetService(Type serviceType, object? serviceKey = null) => null;

    public void Dispose()
    {
    }
}

/// <summary>Helpers for driving the provider's lifecycle hooks directly.</summary>
internal static class Harness
{
    /// <summary>
    /// A real <see cref="ChatClientAgent"/> over <see cref="StubChatClient"/>. Used even by the
    /// direct-hook tests, because <c>InvokingContext</c> rejects a null agent.
    /// </summary>
    public static ChatClientAgent NewAgent(StubChatClient? chatClient = null, params AIContextProvider[] providers)
        => new(chatClient ?? new StubChatClient(), new ChatClientAgentOptions { AIContextProviders = providers });

    public static async Task<AgentSession> NewSessionAsync(ChatClientAgent agent)
        => await agent.CreateSessionAsync();

    public static Microsoft.Extensions.AI.ChatMessage User(string text, string? messageId = null)
        => new(ChatRole.User, text) { MessageId = messageId };

    public static Microsoft.Extensions.AI.ChatMessage Assistant(string text, string? messageId = null)
        => new(ChatRole.Assistant, text) { MessageId = messageId };

    public static SearchHit Hit(string id, string content, string? gist = null)
        => new() { Id = id, Content = content, Gist = gist };
}
