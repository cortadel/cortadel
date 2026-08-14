// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace Cortadel.AgentFramework.Tests;

/// <summary>
/// The whole loop, driven by a real <see cref="ChatClientAgent"/> over a stub chat client.
/// </summary>
/// <remarks>
/// The tests in <see cref="CortadelContextProviderTests"/> call the provider's hooks directly. These
/// let the framework do the calling, which is the only way to prove the seam is actually wired: that
/// <c>ChatClientAgentOptions.AIContextProviders</c> reaches our provider, that what we return really
/// arrives at the model, and that the framework's own message filtering keeps injected context out
/// of what we write back.
/// </remarks>
public sealed class AgentIntegrationTests
{
    [Fact]
    public async Task Recalled_memories_reach_the_model_without_the_agent_asking()
    {
        var cortadel = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions { Client = cortadel });

        var chatClient = new StubChatClient();
        var agent = new ChatClientAgent(chatClient, new ChatClientAgentOptions { AIContextProviders = [memory] });
        var session = await agent.CreateSessionAsync();

        await agent.RunAsync("When do I usually ship?", session);

        var sent = Assert.Single(chatClient.Requests);
        Assert.Contains(sent, m => m.Text.Contains("Alice ships on Fridays.", StringComparison.Ordinal));
        Assert.Equal("When do I usually ship?", Assert.Single(cortadel.Searches).Query);
    }

    [Fact]
    public async Task Instructions_mode_reaches_the_model_as_instructions()
    {
        var cortadel = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = cortadel,
            InjectAs = MemoryInjectionMode.Instructions,
        });

        var chatClient = new StubChatClient();
        var agent = new ChatClientAgent(chatClient, new ChatClientAgentOptions { AIContextProviders = [memory] });

        await agent.RunAsync("When do I usually ship?", await agent.CreateSessionAsync());

        Assert.Contains("Alice ships on Fridays.", Assert.Single(chatClient.RequestOptions)!.Instructions);
    }

    [Fact]
    public async Task The_turn_is_persisted_after_the_agent_answers()
    {
        var cortadel = new FakeCortadelMemory();
        await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions { Client = cortadel });

        var chatClient = new StubChatClient { Reply = "Fridays it is." };
        var agent = new ChatClientAgent(chatClient, new ChatClientAgentOptions { AIContextProviders = [memory] });

        await agent.RunAsync("I ship on Fridays.", await agent.CreateSessionAsync());

        var call = Assert.Single(cortadel.Conversations);
        Assert.Equal(["I ship on Fridays.", "Fridays it is."], call.Messages.Select(m => m.Content));
        Assert.Equal(["user", "assistant"], call.Messages.Select(m => m.Role));
    }

    [Fact]
    public async Task Injected_memories_are_never_written_back_across_a_multi_turn_conversation()
    {
        var cortadel = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = cortadel,
            DeduplicateAcrossTurns = false, // inject the same block every turn, the worst case
        });

        var agent = new ChatClientAgent(new StubChatClient(), new ChatClientAgentOptions { AIContextProviders = [memory] });
        var session = await agent.CreateSessionAsync();

        await agent.RunAsync("turn one", session);
        await agent.RunAsync("turn two", session);

        Assert.Equal(2, cortadel.Conversations.Count);
        Assert.DoesNotContain(
            cortadel.Conversations.SelectMany(c => c.Messages),
            m => m.Content.Contains("## Memories", StringComparison.Ordinal));

        // Turn two writes only turn two: replayed history is not re-ingested either.
        Assert.Equal(["turn two", "Sure thing."], cortadel.Conversations[1].Messages.Select(m => m.Content));
    }

    [Fact]
    public async Task Tools_offered_by_the_provider_reach_the_model_as_callable_functions()
    {
        var cortadel = new FakeCortadelMemory();
        await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = cortadel,
            IncludeMemoryTools = true,
        });

        var chatClient = new StubChatClient();
        var agent = new ChatClientAgent(chatClient, new ChatClientAgentOptions { AIContextProviders = [memory] });

        await agent.RunAsync("hello", await agent.CreateSessionAsync());

        var tools = Assert.Single(chatClient.RequestOptions)!.Tools!;
        Assert.Equal(["search_memory", "add_memories"], tools.Select(t => t.Name));
    }

    [Fact]
    public async Task Tools_handed_straight_to_the_agent_reach_the_model_too()
    {
        var cortadel = new FakeCortadelMemory();
        var chatClient = new StubChatClient();
        var agent = new ChatClientAgent(chatClient, new ChatClientAgentOptions
        {
            ChatOptions = new ChatOptions { Tools = CortadelMemoryTools.CreateAll(cortadel) },
        });

        await agent.RunAsync("hello", await agent.CreateSessionAsync());

        Assert.Equal(["search_memory", "add_memories"], Assert.Single(chatClient.RequestOptions)!.Tools!.Select(t => t.Name));
    }

    [Fact]
    public async Task A_cortadel_outage_leaves_the_agent_answering_normally()
    {
        var cortadel = new FakeCortadelMemory
        {
            SearchThrows = new InvalidOperationException("cortadel down"),
            ConversationThrows = new InvalidOperationException("cortadel down"),
        };
        var observed = new List<Exception>();
        await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = cortadel,
            OnError = observed.Add,
        });

        var agent = new ChatClientAgent(new StubChatClient { Reply = "still here" }, new ChatClientAgentOptions
        {
            AIContextProviders = [memory],
        });

        var response = await agent.RunAsync("hello", await agent.CreateSessionAsync());

        Assert.Equal("still here", response.Text);
        Assert.Equal(2, observed.Count); // the failed search and the failed write
    }

    [Fact]
    public async Task Provider_state_survives_session_serialization()
    {
        var cortadel = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions { Client = cortadel });

        var agent = new ChatClientAgent(new StubChatClient(), new ChatClientAgentOptions { AIContextProviders = [memory] });
        var session = await agent.CreateSessionAsync();
        await agent.RunAsync("turn one", session);

        var serialized = await agent.SerializeSessionAsync(session);
        var restored = await agent.DeserializeSessionAsync(serialized);

        var chatClient = new StubChatClient();
        var sameAgent = new ChatClientAgent(chatClient, new ChatClientAgentOptions { AIContextProviders = [memory] });
        await sameAgent.RunAsync("turn two", restored);

        // The already-injected id round-tripped, so nothing fresh was injected on turn two. The
        // replayed history still carries turn one's block, but the framework re-stamps that as
        // ChatHistory — so "did this provider inject again?" is a question about source type, not
        // about whether the text appears anywhere in the request.
        Assert.DoesNotContain(
            chatClient.Requests[0],
            m => m.GetAgentRequestMessageSourceType() == AgentRequestMessageSourceType.AIContextProvider);
        Assert.Equal(2, cortadel.Searches.Count); // it did search again; it just had nothing new to add
    }

    [Fact]
    public void Two_providers_on_one_agent_need_distinct_state_key_prefixes()
    {
        var first = new CortadelContextProvider(new CortadelContextProviderOptions { Client = new FakeCortadelMemory() });
        var clash = new CortadelContextProvider(new CortadelContextProviderOptions { Client = new FakeCortadelMemory() });

        // The framework itself enforces this: identical state keys are a construction-time error.
        Assert.ThrowsAny<Exception>(() => new ChatClientAgent(
            new StubChatClient(),
            new ChatClientAgentOptions { AIContextProviders = [first, clash] }));

        var distinct = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = new FakeCortadelMemory(),
            StateKeyPrefix = "cortadel-second",
        });
        _ = new ChatClientAgent(new StubChatClient(), new ChatClientAgentOptions { AIContextProviders = [first, distinct] });
    }
}
