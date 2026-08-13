// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

using System.Text.Json;
using Cortadel.Sdk;
using Microsoft.Extensions.AI;

namespace Cortadel.AgentFramework.Tests;

/// <summary>The two framework-native tools an agent can call on its own initiative.</summary>
public sealed class CortadelMemoryToolsTests
{
    /// <summary>
    /// Invoke a tool the way the framework does and read back what the model would see.
    /// </summary>
    /// <remarks>
    /// <see cref="AIFunction.InvokeAsync"/> marshals the return value to JSON, so a
    /// <c>Task&lt;string&gt;</c> function hands back a <see cref="JsonElement"/> holding a JSON
    /// string — not a <see cref="string"/>. Unwrapping it here is what keeps the assertions below
    /// about the memory answer rather than about JSON plumbing.
    /// </remarks>
    private static async Task<string> InvokeAsync(AIFunction tool, AIFunctionArguments arguments)
    {
        var result = await tool.InvokeAsync(arguments);
        var element = Assert.IsType<JsonElement>(result);
        Assert.Equal(JsonValueKind.String, element.ValueKind);
        return element.GetString()!;
    }

    [Fact]
    public void Tool_names_match_cortadels_own_mcp_surface()
    {
        var client = new FakeCortadelMemory();
        Assert.Equal("search_memory", CortadelMemoryTools.CreateSearchMemoryTool(client).Name);
        Assert.Equal("add_memories", CortadelMemoryTools.CreateAddMemoriesTool(client).Name);
        Assert.Equal(["search_memory", "add_memories"], CortadelMemoryTools.CreateAll(client).Select(t => t.Name));
    }

    [Fact]
    public void Search_tool_schema_describes_the_parameters_the_model_may_send()
    {
        var tool = CortadelMemoryTools.CreateSearchMemoryTool(new FakeCortadelMemory());
        var schema = JsonDocument.Parse(tool.JsonSchema.GetRawText()).RootElement;
        var properties = schema.GetProperty("properties");

        Assert.Equal("object", schema.GetProperty("type").GetString());
        Assert.True(properties.TryGetProperty("query", out var query));
        Assert.Contains("recall", query.GetProperty("description").GetString(), StringComparison.OrdinalIgnoreCase);
        Assert.True(properties.TryGetProperty("top_k", out _));
        Assert.Equal(["query"], schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()));

        // A CancellationToken is plumbing, not something the model should ever try to send.
        Assert.False(properties.TryGetProperty("cancellationToken", out _));
        Assert.False(string.IsNullOrWhiteSpace(tool.Description));
    }

    [Fact]
    public void Add_tool_schema_takes_a_single_required_text_parameter()
    {
        var tool = CortadelMemoryTools.CreateAddMemoriesTool(new FakeCortadelMemory());
        var schema = JsonDocument.Parse(tool.JsonSchema.GetRawText()).RootElement;

        Assert.True(schema.GetProperty("properties").TryGetProperty("text", out _));
        Assert.Equal(["text"], schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()));
    }

    [Fact]
    public void Tool_names_are_configurable()
    {
        var options = new CortadelMemoryToolOptions { SearchToolName = "recall", AddToolName = "remember" };
        var tools = CortadelMemoryTools.CreateAll(new FakeCortadelMemory(), options);
        Assert.Equal(["recall", "remember"], tools.Select(t => t.Name));
    }

    [Fact]
    public async Task Search_tool_returns_one_memory_per_line()
    {
        var client = new FakeCortadelMemory
        {
            Hits = [Harness.Hit("m1", "Alice ships on Fridays."), Harness.Hit("m2", "raw", gist: "Alice prefers dark mode.")],
        };
        var tool = CortadelMemoryTools.CreateSearchMemoryTool(client);

        var answer = await InvokeAsync(tool, new AIFunctionArguments { ["query"] = "alice preferences" });

        Assert.Equal("- Alice ships on Fridays.\n- Alice prefers dark mode.", answer);
        Assert.Equal("alice preferences", Assert.Single(client.Searches).Query);
    }

    [Fact]
    public async Task Search_tool_says_so_when_there_is_nothing_to_recall()
    {
        var tool = CortadelMemoryTools.CreateSearchMemoryTool(new FakeCortadelMemory { Hits = [] });
        var answer = await InvokeAsync(tool, new AIFunctionArguments { ["query"] = "anything" });
        Assert.Equal("No memories found for: anything", answer);
    }

    [Fact]
    public async Task Search_tool_uses_the_configured_top_k_when_the_model_does_not_ask()
    {
        var client = new FakeCortadelMemory();
        var tool = CortadelMemoryTools.CreateSearchMemoryTool(client, new CortadelMemoryToolOptions { TopK = 7, Rerank = "cross_encoder" });

        await InvokeAsync(tool, new AIFunctionArguments { ["query"] = "q" });

        var options = Assert.Single(client.Searches).Options!;
        Assert.Equal(7, options.TopK);
        Assert.Equal("cross_encoder", options.Rerank);
    }

    [Fact]
    public async Task Search_tool_honours_a_model_supplied_top_k()
    {
        var client = new FakeCortadelMemory();
        var tool = CortadelMemoryTools.CreateSearchMemoryTool(client);

        await InvokeAsync(tool, new AIFunctionArguments { ["query"] = "q", ["top_k"] = 3 });

        Assert.Equal(3, Assert.Single(client.Searches).Options!.TopK);
    }

    [Theory]
    [InlineData(null, 10)]   // model said nothing -> the builder's default
    [InlineData(0, 10)]      // nonsense -> the builder's default
    [InlineData(-4, 10)]
    [InlineData(999, 50)]    // above Cortadel's ceiling -> clamped
    [InlineData(50, 50)]
    public void Model_supplied_top_k_is_clamped_into_the_range_cortadel_accepts(int? requested, int expected)
        => Assert.Equal(expected, CortadelMemoryTools.ClampTopK(requested, 10));

    [Fact]
    public async Task Search_tool_answers_gracefully_when_cortadel_is_down()
    {
        var boom = new InvalidOperationException("cortadel down");
        var observed = new List<Exception>();
        var tool = CortadelMemoryTools.CreateSearchMemoryTool(
            new FakeCortadelMemory { SearchThrows = boom },
            new CortadelMemoryToolOptions { OnError = observed.Add });

        var answer = await InvokeAsync(tool, new AIFunctionArguments { ["query"] = "q" });

        Assert.Equal("Memory is temporarily unavailable; answer without it.", answer);
        Assert.Same(boom, Assert.Single(observed));
    }

    [Fact]
    public async Task Search_tool_propagates_when_throw_on_error_is_set()
    {
        var boom = new InvalidOperationException("cortadel down");
        var tool = CortadelMemoryTools.CreateSearchMemoryTool(
            new FakeCortadelMemory { SearchThrows = boom },
            new CortadelMemoryToolOptions { ThrowOnError = true });

        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(
            () => tool.InvokeAsync(new AIFunctionArguments { ["query"] = "q" }).AsTask());

        Assert.Same(boom, thrown);
    }

    [Fact]
    public async Task Add_tool_reports_what_the_store_pipeline_actually_did()
    {
        var client = new FakeCortadelMemory { Created = new MemoryCreated { Id = "m1", Event = "ADD" } };
        var tool = CortadelMemoryTools.CreateAddMemoriesTool(client);

        var answer = await InvokeAsync(tool, new AIFunctionArguments { ["text"] = "Alice ships on Fridays." });

        Assert.Equal("Remembered (event: ADD).", answer);
        var call = Assert.Single(client.Adds);
        Assert.Equal("Alice ships on Fridays.", call.Text);
        Assert.Equal(CortadelMemoryClient.DefaultAppName, call.Options!.App);
    }

    [Fact]
    public async Task Add_tool_tells_the_model_when_the_fact_was_already_known()
    {
        var client = new FakeCortadelMemory { Created = new MemoryCreated { Id = "m1", Event = "SKIP_DUPLICATE" } };
        var tool = CortadelMemoryTools.CreateAddMemoriesTool(client);

        Assert.Equal(
            "Already remembered; nothing new was stored.",
            await InvokeAsync(tool, new AIFunctionArguments { ["text"] = "Alice ships on Fridays." }));
    }

    [Fact]
    public async Task Add_tool_refuses_empty_text_without_calling_cortadel()
    {
        var client = new FakeCortadelMemory();
        var tool = CortadelMemoryTools.CreateAddMemoriesTool(client);

        Assert.Equal(
            "Nothing to remember: the text was empty.",
            await InvokeAsync(tool, new AIFunctionArguments { ["text"] = "   " }));
        Assert.Empty(client.Adds);
    }

    [Fact]
    public async Task Add_tool_forwards_infer_and_memory_type()
    {
        var client = new FakeCortadelMemory();
        var tool = CortadelMemoryTools.CreateAddMemoriesTool(
            client,
            new CortadelMemoryToolOptions { Infer = false, MemoryType = "procedural" });

        await InvokeAsync(tool, new AIFunctionArguments { ["text"] = "a fact" });

        var options = Assert.Single(client.Adds).Options!;
        Assert.False(options.Infer);
        Assert.Equal("procedural", options.MemoryType);
    }

    [Fact]
    public async Task Add_tool_answers_gracefully_when_cortadel_is_down()
    {
        var tool = CortadelMemoryTools.CreateAddMemoriesTool(
            new FakeCortadelMemory { AddThrows = new InvalidOperationException("cortadel down") });

        Assert.Equal(
            "Memory is temporarily unavailable; the fact was not saved.",
            await InvokeAsync(tool, new AIFunctionArguments { ["text"] = "a fact" }));
    }

    [Fact]
    public async Task Tools_are_bound_to_one_users_client_at_build_time()
    {
        var alice = new FakeCortadelMemory();
        var bob = new FakeCortadelMemory();

        await InvokeAsync(CortadelMemoryTools.CreateSearchMemoryTool(alice), new AIFunctionArguments { ["query"] = "for alice" });
        await InvokeAsync(CortadelMemoryTools.CreateSearchMemoryTool(bob), new AIFunctionArguments { ["query"] = "for bob" });

        Assert.Equal("for alice", Assert.Single(alice.Searches).Query);
        Assert.Equal("for bob", Assert.Single(bob.Searches).Query);
    }

    [Fact]
    public void A_null_client_is_rejected_at_build_time()
    {
        Assert.Throws<ArgumentNullException>(() => CortadelMemoryTools.CreateSearchMemoryTool(null!));
        Assert.Throws<ArgumentNullException>(() => CortadelMemoryTools.CreateAddMemoriesTool(null!));
    }

    [Fact]
    public void Multi_line_memories_are_flattened_to_one_line_each()
        => Assert.Equal(
            "first second",
            CortadelMemoryTools.RenderHit(new SearchHit { Id = "m1", Content = "first\nsecond" }));
}
