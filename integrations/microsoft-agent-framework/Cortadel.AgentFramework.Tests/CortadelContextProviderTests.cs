// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using Cortadel.Sdk;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace Cortadel.AgentFramework.Tests;

/// <summary>
/// The recall-before-model and persist-after-turn paths, driven through the framework's own hooks
/// (<c>InvokingAsync</c> / <c>InvokedAsync</c>) so the base class's filtering, merging and
/// source-stamping behaviour is exercised too, not bypassed.
/// </summary>
public sealed class CortadelContextProviderTests
{
    private const string TestUser = "e2e-agent-framework";

    private static CortadelContextProvider NewProvider(FakeCortadelMemory client, Action<CortadelContextProviderOptions>? _ = null)
        => new(new CortadelContextProviderOptions { Client = client });

    private static async Task<AIContext> InvokeAsync(
        CortadelContextProvider provider,
        ChatClientAgent agent,
        AgentSession session,
        params Microsoft.Extensions.AI.ChatMessage[] input)
    {
        var incoming = new AIContext { Messages = input };
        return await provider.InvokingAsync(new AIContextProvider.InvokingContext(agent, session, incoming));
    }

    // ── Recall ───────────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Searches_with_the_turns_user_text_and_injects_a_context_message()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("What am I working on?"));

        var search = Assert.Single(client.Searches);
        Assert.Equal("What am I working on?", search.Query);

        var messages = context.Messages!.ToList();
        // The base class merges our block after the caller's own messages.
        Assert.Equal(2, messages.Count);
        Assert.Contains("Alice ships on Fridays.", messages[1].Text);
        Assert.Contains("## Memories", messages[1].Text);
        Assert.Equal(ChatRole.User, messages[1].Role);
    }

    [Fact]
    public async Task Injected_message_is_stamped_as_coming_from_a_context_provider()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("hello"));
        var injected = context.Messages!.Last();

        // The base class stamps this for us. It is what stops the block being written back as user
        // input on the next turn, so it is worth asserting rather than assuming.
        Assert.Equal(AgentRequestMessageSourceType.AIContextProvider, injected.GetAgentRequestMessageSourceType());
        Assert.Equal(typeof(CortadelContextProvider).FullName, injected.GetAgentRequestMessageSourceId());
    }

    [Fact]
    public async Task Injects_into_the_instructions_when_asked_to()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            InjectAs = MemoryInjectionMode.Instructions,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("hello"));

        Assert.Contains("Alice ships on Fridays.", context.Instructions);
        Assert.Single(context.Messages!);
    }

    [Fact]
    public async Task Prefers_the_servers_gist_over_the_raw_content()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "long raw content", gist: "short gist")] };
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("hello"));

        Assert.Contains("short gist", context.Messages!.Last().Text);
        Assert.DoesNotContain("long raw content", context.Messages!.Last().Text);
    }

    [Fact]
    public async Task Does_not_search_when_the_turn_has_no_text()
    {
        var client = new FakeCortadelMemory();
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await InvokeAsync(provider, agent, session, Harness.User("   "));

        Assert.Empty(client.Searches);
    }

    [Fact]
    public async Task Injects_nothing_when_there_are_no_hits()
    {
        var client = new FakeCortadelMemory { Hits = [] };
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("hello"));

        Assert.Single(client.Searches);
        Assert.Single(context.Messages!);
        Assert.Null(context.Instructions);
    }

    [Fact]
    public async Task Search_options_carry_the_configured_knobs()
    {
        var client = new FakeCortadelMemory();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            TopK = 3,
            SearchMode = "vector",
            Rerank = "cross_encoder",
            MemoryType = "semantic",
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await InvokeAsync(provider, agent, session, Harness.User("hello"));

        var options = Assert.Single(client.Searches).Options!;
        Assert.Equal(3, options.TopK);
        Assert.Equal("vector", options.Mode);
        Assert.Equal("cross_encoder", options.Rerank);
        Assert.Equal("semantic", options.MemoryType);
        Assert.Null(options.SessionId); // cross-session recall is the default
    }

    [Fact]
    public async Task Scope_recall_to_session_restricts_the_search_to_this_session()
    {
        var client = new FakeCortadelMemory();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            ScopeRecallToSession = true,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await InvokeAsync(provider, agent, session, Harness.User("first"));
        await InvokeAsync(provider, agent, session, Harness.User("second"));

        var first = client.Searches[0].Options!.SessionId;
        Assert.False(string.IsNullOrWhiteSpace(first));
        // The minted id is stable for the life of the session.
        Assert.Equal(first, client.Searches[1].Options!.SessionId);
    }

    [Fact]
    public async Task Search_failure_leaves_the_context_untouched_and_is_observed()
    {
        var boom = new InvalidOperationException("cortadel down");
        var client = new FakeCortadelMemory { SearchThrows = boom };
        var observed = new List<Exception>();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            OnError = observed.Add,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("hello"));

        Assert.Single(context.Messages!); // only the caller's own message survived
        Assert.Same(boom, Assert.Single(observed));
    }

    [Fact]
    public async Task Search_failure_propagates_when_throw_on_error_is_set()
    {
        var boom = new InvalidOperationException("cortadel down");
        var client = new FakeCortadelMemory { SearchThrows = boom };
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            ThrowOnError = true,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(
            () => InvokeAsync(provider, agent, session, Harness.User("hello")));

        Assert.Same(boom, thrown);
    }

    [Fact]
    public async Task Cancellation_is_never_converted_into_a_memory_failure()
    {
        var client = new FakeCortadelMemory { SearchThrows = new OperationCanceledException() };
        var observed = new List<Exception>();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            OnError = observed.Add,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => InvokeAsync(provider, agent, session, Harness.User("hello")));

        Assert.Empty(observed);
    }

    // ── Deduplication across turns ───────────────────────────────────────────────────────────

    [Fact]
    public async Task Does_not_re_inject_a_memory_it_already_injected_this_session()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var first = await InvokeAsync(provider, agent, session, Harness.User("turn one"));
        var second = await InvokeAsync(provider, agent, session, Harness.User("turn two"));

        Assert.Equal(2, first.Messages!.Count());  // caller message + memory block
        Assert.Single(second.Messages!);           // nothing new to say
    }

    [Fact]
    public async Task Re_injects_when_deduplication_is_off()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            DeduplicateAcrossTurns = false,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await InvokeAsync(provider, agent, session, Harness.User("turn one"));
        var second = await InvokeAsync(provider, agent, session, Harness.User("turn two"));

        Assert.Equal(2, second.Messages!.Count());
    }

    [Fact]
    public async Task Max_remembered_ids_of_zero_remembers_nothing()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            MaxRememberedIds = 0,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await InvokeAsync(provider, agent, session, Harness.User("turn one"));
        var second = await InvokeAsync(provider, agent, session, Harness.User("turn two"));

        // Nothing was remembered, so the same hit is eligible again.
        Assert.Equal(2, second.Messages!.Count());
    }

    [Fact]
    public async Task Remembered_ids_are_bounded_and_kept_newest_last()
    {
        var client = new FakeCortadelMemory();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            MaxRememberedIds = 2,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        client.Hits = [Harness.Hit("m1", "one"), Harness.Hit("m2", "two")];
        await InvokeAsync(provider, agent, session, Harness.User("turn one"));

        client.Hits = [Harness.Hit("m3", "three")];
        await InvokeAsync(provider, agent, session, Harness.User("turn two"));

        Assert.True(session.StateBag.TryGetValue<List<string>>("CortadelContextProvider.InjectedMemoryIds", out var ids));
        Assert.Equal(["m2", "m3"], ids);
    }

    [Fact]
    public async Task Remembered_ids_live_in_the_session_not_in_the_provider()
    {
        var client = new FakeCortadelMemory { Hits = [Harness.Hit("m1", "Alice ships on Fridays.")] };
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var sessionA = await Harness.NewSessionAsync(agent);
        var sessionB = await Harness.NewSessionAsync(agent);

        await InvokeAsync(provider, agent, sessionA, Harness.User("turn one"));
        var inB = await InvokeAsync(provider, agent, sessionB, Harness.User("turn one"));

        // One provider serves many sessions: session B has never seen m1.
        Assert.Equal(2, inB.Messages!.Count());
    }

    [Fact]
    public void State_keys_are_declared_so_the_agent_can_detect_collisions()
    {
        var provider = NewProvider(new FakeCortadelMemory());
        Assert.Equal(
            ["CortadelContextProvider.InjectedMemoryIds", "CortadelContextProvider.SessionId"],
            provider.StateKeys);

        var prefixed = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = new FakeCortadelMemory(),
            StateKeyPrefix = "second",
        });
        Assert.Equal(["second.InjectedMemoryIds", "second.SessionId"], prefixed.StateKeys);
    }

    // ── Persist ──────────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Persists_the_turns_input_and_response_as_a_conversation()
    {
        var client = new FakeCortadelMemory();
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent,
            session,
            [Harness.User("I ship on Fridays.", "msg-1")],
            [Harness.Assistant("Noted.", "msg-2")]));

        var call = Assert.Single(client.Conversations);
        Assert.Equal(2, call.Messages.Count);
        Assert.Equal("user", call.Messages[0].Role);
        Assert.Equal("I ship on Fridays.", call.Messages[0].Content);
        Assert.Equal("msg-1", call.Messages[0].Uuid);
        Assert.Equal("assistant", call.Messages[1].Role);
        Assert.Equal("Noted.", call.Messages[1].Content);
        Assert.False(string.IsNullOrWhiteSpace(call.Options!.SessionId));
    }

    [Fact]
    public async Task Conversation_options_carry_tags_project_and_agent_memory()
    {
        var client = new FakeCortadelMemory();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            Tags = ["support"],
            Project = "cortadel",
            IsAgentMemory = true,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], [Harness.Assistant("hello")]));

        var options = Assert.Single(client.Conversations).Options!;
        Assert.Equal(["support"], options.Tags);
        Assert.Equal("cortadel", options.Project);
        Assert.True(options.IsAgentMemory);
    }

    [Fact]
    public async Task Never_writes_its_own_injected_memories_back_as_user_input()
    {
        var client = new FakeCortadelMemory();
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var injected = Harness.User("## Memories\n- Alice ships on Fridays.")
            .WithAgentRequestMessageSource(AgentRequestMessageSourceType.AIContextProvider, nameof(CortadelContextProvider));

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [injected, Harness.User("real question")], [Harness.Assistant("answer")]));

        var call = Assert.Single(client.Conversations);
        Assert.DoesNotContain(call.Messages, m => m.Content.Contains("## Memories", StringComparison.Ordinal));
        Assert.Equal(["real question", "answer"], call.Messages.Select(m => m.Content));
    }

    [Fact]
    public async Task Never_re_ingests_replayed_chat_history()
    {
        var client = new FakeCortadelMemory();
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var replayed = Harness.User("something said three turns ago")
            .WithAgentRequestMessageSource(AgentRequestMessageSourceType.ChatHistory, "InMemoryChatHistoryProvider");

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [replayed, Harness.User("new question")], [Harness.Assistant("answer")]));

        var call = Assert.Single(client.Conversations);
        Assert.Equal(["new question", "answer"], call.Messages.Select(m => m.Content));
    }

    [Fact]
    public async Task Store_turns_false_makes_the_agent_read_only()
    {
        var client = new FakeCortadelMemory();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            StoreTurns = false,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], [Harness.Assistant("hello")]));

        Assert.Empty(client.Conversations);
    }

    [Fact]
    public async Task Nothing_is_written_when_the_turn_carries_no_ingestible_text()
    {
        var client = new FakeCortadelMemory();
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("   ")], [Harness.Assistant("")]));

        Assert.Empty(client.Conversations);
    }

    [Fact]
    public async Task A_failed_invocation_is_not_persisted()
    {
        var client = new FakeCortadelMemory();
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], new InvalidOperationException("model exploded")));

        Assert.Empty(client.Conversations);
    }

    [Fact]
    public async Task Write_failure_is_observed_and_swallowed_by_default()
    {
        var boom = new InvalidOperationException("cortadel down");
        var client = new FakeCortadelMemory { ConversationThrows = boom };
        var observed = new List<Exception>();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            OnError = observed.Add,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], [Harness.Assistant("hello")]));

        Assert.Same(boom, Assert.Single(observed));
    }

    [Fact]
    public async Task Write_failure_propagates_when_throw_on_error_is_set()
    {
        var boom = new InvalidOperationException("cortadel down");
        var client = new FakeCortadelMemory { ConversationThrows = boom };
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            ThrowOnError = true,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            provider.InvokedAsync(new AIContextProvider.InvokedContext(
                agent, session, [Harness.User("hi")], [Harness.Assistant("hello")])).AsTask());

        Assert.Same(boom, thrown);
    }

    [Fact]
    public async Task An_on_error_callback_that_throws_cannot_take_the_agent_down()
    {
        var client = new FakeCortadelMemory { ConversationThrows = new InvalidOperationException("cortadel down") };
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            OnError = _ => throw new NotSupportedException("bad observer"),
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], [Harness.Assistant("hello")]));
    }

    // ── AwaitPersist / disposal ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task Await_persist_false_returns_before_the_write_lands_and_dispose_drains_it()
    {
        var client = new FakeCortadelMemory { BlockConversation = true };
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            AwaitPersist = false,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], [Harness.Assistant("hello")]));

        Assert.Empty(client.Conversations); // still in flight

        client.Release();
        await provider.DisposeAsync();

        Assert.Single(client.Conversations); // drained
    }

    [Fact]
    public async Task Await_persist_true_blocks_until_the_write_lands()
    {
        var client = new FakeCortadelMemory();
        var provider = NewProvider(client);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], [Harness.Assistant("hello")]));

        Assert.Single(client.Conversations);
    }

    [Fact]
    public async Task A_background_write_failure_is_observed_but_never_propagated()
    {
        var boom = new InvalidOperationException("cortadel down");
        var client = new FakeCortadelMemory { ConversationThrows = boom };
        var observed = new List<Exception>();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            AwaitPersist = false,
            ThrowOnError = true, // there is no caller left to throw into
            OnError = observed.Add,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await provider.InvokedAsync(new AIContextProvider.InvokedContext(
            agent, session, [Harness.User("hi")], [Harness.Assistant("hello")]));
        await provider.DisposeAsync();

        Assert.Same(boom, Assert.Single(observed));
    }

    [Fact]
    public async Task Dispose_is_idempotent()
    {
        var provider = NewProvider(new FakeCortadelMemory());
        await provider.DisposeAsync();
        await provider.DisposeAsync();
    }

    [Fact]
    public async Task A_caller_supplied_client_is_never_disposed_by_the_provider()
    {
        using var real = new CortadelClient("http://localhost:3001", TestUser);
        var wrapper = new CortadelMemoryClient(real);
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions { Client = wrapper });

        await provider.DisposeAsync();

        // Still usable: disposing the wrapper's owner is the caller's job, and this call would
        // throw ObjectDisposedException if the provider had disposed it.
        Assert.NotNull(wrapper.Client);
        wrapper.Dispose();
    }

    // ── Construction ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void Requires_either_a_client_or_a_base_url_and_user_id()
    {
        Assert.Throws<ArgumentException>(() => new CortadelContextProvider(new CortadelContextProviderOptions()));
        Assert.Throws<ArgumentException>(() => new CortadelContextProvider(new CortadelContextProviderOptions { BaseUrl = "http://localhost:3001" }));
        Assert.Throws<ArgumentException>(() => new CortadelContextProvider(new CortadelContextProviderOptions { UserId = TestUser }));
    }

    [Fact]
    public void Rejects_out_of_range_numbers()
    {
        Assert.Throws<ArgumentException>(() => new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = new FakeCortadelMemory(),
            TopK = 0,
        }));
        Assert.Throws<ArgumentException>(() => new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = new FakeCortadelMemory(),
            MaxRememberedIds = -1,
        }));
    }

    [Fact]
    public async Task Builds_its_own_client_from_a_base_url_and_user_id()
    {
        // No request is made here — construction only, so the suite stays offline.
        await using var provider = new CortadelContextProvider("http://localhost:3001", TestUser);
        var client = Assert.IsType<CortadelMemoryClient>(provider.Client);
        Assert.NotNull(client.Client);
    }

    [Fact]
    public async Task Per_user_scoping_means_one_provider_per_user()
    {
        var alice = new FakeCortadelMemory();
        var bob = new FakeCortadelMemory();
        var forAlice = NewProvider(alice);
        var forBob = NewProvider(bob);
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        await InvokeAsync(forAlice, agent, session, Harness.User("alice question"));
        await InvokeAsync(forBob, agent, session, Harness.User("bob question"));

        Assert.Equal("alice question", Assert.Single(alice.Searches).Query);
        Assert.Equal("bob question", Assert.Single(bob.Searches).Query);
    }

    // ── Tools offered through the provider ───────────────────────────────────────────────────

    [Fact]
    public async Task Offers_the_memory_tools_when_asked_to()
    {
        var client = new FakeCortadelMemory();
        var provider = new CortadelContextProvider(new CortadelContextProviderOptions
        {
            Client = client,
            IncludeMemoryTools = true,
        });
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("hello"));

        Assert.Equal(["search_memory", "add_memories"], context.Tools!.Select(t => t.Name));
    }

    [Fact]
    public async Task Offers_no_tools_by_default()
    {
        var provider = NewProvider(new FakeCortadelMemory());
        var agent = Harness.NewAgent();
        var session = await Harness.NewSessionAsync(agent);

        var context = await InvokeAsync(provider, agent, session, Harness.User("hello"));

        Assert.True(context.Tools is null || !context.Tools.Any());
    }
}
