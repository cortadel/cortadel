// Copyright (c) Cortadel. Licensed under the Apache-2.0 License.
//
// Cortadel × Microsoft Agent Framework — an agent that remembers between conversations.
//
// What this shows
// ---------------
//   1. CortadelContextProvider attached through ChatClientAgentOptions.AIContextProviders. It is
//      an AIContextProvider, the framework's own memory seam: it recalls before every model call
//      and persists after every turn, without the agent asking for either.
//   2. The same provider also offering search_memory / add_memories as tools the model can call
//      on its own initiative (IncludeMemoryTools).
//   3. Two separate conversations: the second one has no chat history at all, so anything it
//      knows came out of Cortadel.
//
// Run it
// ------
//   # a Cortadel server (self-hosted)
//   docker compose up            # -> http://localhost:3001
//
//   export OPENAI_API_KEY=sk-...
//   export CORTADEL_BASE_URL=http://localhost:3001      # or https://app.cortadel.ai
//   export CORTADEL_API_KEY=...                         # only if the server has auth enabled
//   dotnet run --project examples/BasicMemoryAgent
//
// This example is a real project in the solution, so `dotnet build` compiles it. That is
// deliberate: sample code that nothing compiles is the code most likely to be wrong.

using Cortadel.AgentFramework;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;
using OpenAI.Chat;

var baseUrl = Environment.GetEnvironmentVariable("CORTADEL_BASE_URL") ?? "http://localhost:3001";
var cortadelApiKey = Environment.GetEnvironmentVariable("CORTADEL_API_KEY");
var openAiApiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY")
    ?? throw new InvalidOperationException("Set OPENAI_API_KEY to run this example.");
var model = Environment.GetEnvironmentVariable("OPENAI_MODEL") ?? "gpt-4o-mini";

// A Cortadel client is bound to one user id at construction — every call is scoped to it. So one
// provider instance means one end user; build one per user and cache it, never share it.
const string UserId = "e2e-agent-framework-demo";

// `await using`: the framework never disposes a provider, and disposal is what flushes any
// in-flight background write and closes the client this provider created.
await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
{
    BaseUrl = baseUrl,
    UserId = UserId,
    ApiKey = cortadelApiKey,

    // Recall knobs. TopK is deliberately small: this runs on every single turn.
    TopK = 5,

    // Long-term memory is the point, so recall is cross-session by default. Flip
    // ScopeRecallToSession to true to restrict it to the live conversation instead.
    ScopeRecallToSession = false,

    // Also hand the model search_memory / add_memories, so it can dig deeper or deliberately
    // commit something mid-answer rather than relying only on what was injected for it.
    IncludeMemoryTools = true,

    // Fail open (the default): if Cortadel is unreachable the agent still answers, just without
    // long-term memory. OnError is how you find out that happened.
    OnError = exception => Console.Error.WriteLine($"[cortadel] {exception.Message}"),
});

ChatClient chatClient = new OpenAIClient(openAiApiKey).GetChatClient(model);

AIAgent agent = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    Name = "Memory Assistant",

    // Note: the system prompt is ChatOptions.Instructions, not a property on ChatClientAgentOptions.
    ChatOptions = new ChatOptions
    {
        Instructions = "You are a helpful assistant. Use what you remember about the user; never invent memories.",
    },
    AIContextProviders = [memory],
});

// ── Conversation one: tell it something worth keeping ────────────────────────────────────────

var first = await agent.CreateSessionAsync();

Console.WriteLine("— conversation one —");
foreach (var line in new[]
         {
             "I'm Alex. I'm rebuilding our billing service in Go, and I ship on Fridays.",
             "Also: I hate long meetings, so keep answers short.",
         })
{
    Console.WriteLine($"you: {line}");
    Console.WriteLine($"agent: {(await agent.RunAsync(line, first)).Text}\n");
}

// Cortadel distils facts out of the turn off the request path, so give the server a moment before
// asking for them back. In a real app there is a human between the turns and this is a non-issue.
await Task.Delay(TimeSpan.FromSeconds(3));

// ── Conversation two: a brand-new session, no chat history ───────────────────────────────────

var second = await agent.CreateSessionAsync();

Console.WriteLine("— conversation two (fresh session, no history) —");
const string Question = "What am I working on, and how should you talk to me?";
Console.WriteLine($"you: {Question}");
Console.WriteLine($"agent: {(await agent.RunAsync(Question, second)).Text}");

// Anything the agent knew there came out of Cortadel: the second session shares no messages with
// the first. That is the difference between long-term memory and a transcript buffer.
