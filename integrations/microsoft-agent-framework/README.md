# Cortadel × Microsoft Agent Framework

Long-term memory for [Microsoft Agent Framework](https://learn.microsoft.com/agent-framework/)
agents, backed by [Cortadel](https://cortadel.ai). Attach one `AIContextProvider` and your agent
recalls what it learned in earlier conversations before every model call, and files the new turn
away after it — no bookkeeping in your own code, and nothing lost when the session ends.

Cortadel is self-hosted long-term temporal graph memory for AI agents: a bi-temporal graph store
with hybrid BM25 + vector search, so memories can be superseded and re-dated rather than just piled
up. This package makes it feel native inside Agent Framework, using the framework's own extension
points and nothing else.

## Install

```bash
dotnet add package Cortadel.AgentFramework
```

## Quickstart

```csharp
using Cortadel.AgentFramework;
using Microsoft.Agents.AI;
using OpenAI;

// One provider per end user: a Cortadel client is bound to a single user id at construction,
// so `memory` *is* the per-user object. `await using` flushes and closes it on the way out.
await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
{
    BaseUrl = "http://localhost:3001",
    UserId = "e2e-alice",
});

AIAgent agent = new OpenAIClient(Environment.GetEnvironmentVariable("OPENAI_API_KEY"))
    .GetChatClient("gpt-4o-mini")
    .AsAIAgent(new ChatClientAgentOptions
    {
        AIContextProviders = [memory],
    });

var session = await agent.CreateSessionAsync();
Console.WriteLine((await agent.RunAsync("I ship on Fridays.", session)).Text);

// A brand-new session, no chat history — whatever it knows here came out of Cortadel.
var later = await agent.CreateSessionAsync();
Console.WriteLine((await agent.RunAsync("When do I usually ship?", later)).Text);
```

A complete, runnable version is in [`examples/BasicMemoryAgent`](examples/BasicMemoryAgent). It is a
real project in the solution, so `dotnet build` compiles it.

## What you get

**Automatic memory — `CortadelContextProvider`.** A `Microsoft.Agents.AI.AIContextProvider`, which
is the framework's own memory seam. It overrides the two methods the base class defines for exactly
this:

| Hook | What it does |
|---|---|
| `ProvideAIContextAsync` | Hybrid-searches Cortadel with the current turn's input and returns an `AIContext` the framework merges into the invocation — as a user-role context message by default, or as system instructions (`InjectAs`). |
| `StoreAIContextAsync` | Hands the completed turn to Cortadel's conversation pipeline, which distils durable facts out of it off the request path. |

Attach it through `ChatClientAgentOptions.AIContextProviders`. Per-session state (already-injected
memory ids, the Cortadel session id) lives in `AgentSession.StateBag` under this provider's
`StateKeys`, so one provider instance safely serves many sessions and the state survives
`SerializeSessionAsync`.

**Memory tools — `CortadelMemoryTools`.** `search_memory` and `add_memories` as
`Microsoft.Extensions.AI.AIFunction`s (built with `AIFunctionFactory.Create`, so the JSON schema
comes from the signature). Where the provider gives an agent memory it never has to ask for, these
give it memory it can *choose* to use:

```csharp
using Microsoft.Extensions.AI;

var cortadel = CortadelMemoryClient.Create("http://localhost:3001", "e2e-alice");

AIAgent agent = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    ChatOptions = new ChatOptions { Tools = CortadelMemoryTools.CreateAll(cortadel) },
});
```

Both tools are bound to a client at build time, so they are already scoped to that client's user —
the model cannot reach another user's memories by asking. Set `IncludeMemoryTools = true` on the
provider to get both capabilities from a single attachment.

**Graceful degradation.** Every Cortadel call fails open: if the server is unreachable the agent
still answers, just without long-term memory, and the tools reply "memory is temporarily
unavailable" instead of throwing at the model. `OnError` observes those failures;
`ThrowOnError = true` propagates them instead. `OperationCanceledException` is always rethrown
untouched — cancellation is your intent, not a Cortadel failure.

## Configuration

`CortadelContextProviderOptions`. Either set `BaseUrl` and `UserId` and let the provider build (and
own) a Cortadel client, or set `Client` to one you own yourself.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `BaseUrl` | `string?` | `null` | Cortadel server URL, e.g. `https://app.cortadel.ai` or `http://localhost:3001`. Required unless `Client` is set. |
| `UserId` | `string?` | `null` | The user whose memories this provider reads and writes. Required unless `Client` is set. Every call is scoped to it. |
| `ApiKey` | `string?` | `null` | Bearer token. Omit when the server runs with auth disabled. |
| `AppName` | `string` | `"Cortadel.AgentFramework"` | App name Cortadel records for access logging on searches. |
| `Client` | `ICortadelMemory?` | `null` | A pre-built client. When set, `BaseUrl`/`UserId`/`ApiKey`/`AppName` are ignored and you own its lifetime. |
| `TopK` | `int` | `5` | Maximum memories to recall per turn (Cortadel accepts 1–50). Lower than the search *tool*'s 10 because this runs on every turn. |
| `SearchMode` | `string` | `"hybrid"` | `hybrid` (default), `text` or `vector`. |
| `Rerank` | `string?` | `null` | Set to `cross_encoder` to rerank with the server's cross-encoder. Cortadel accepts no other value. |
| `MemoryType` | `string?` | `null` | Restrict recall to one cognitive type: `episodic`, `semantic` or `procedural`. |
| `ContextPrompt` | `string` | a generic `## Memories` header | Header placed above the injected memories. |
| `InjectAs` | `MemoryInjectionMode` | `MemoryInjectionMode.Message` | `Message` injects a user-role context message; `Instructions` appends to the system instructions instead. |
| `ScopeRecallToSession` | `bool` | `false` | Restrict recall to the current session. Off by default — cross-session recall is the point of long-term memory. |
| `DeduplicateAcrossTurns` | `bool` | `true` | Skip memories already injected earlier in this session. |
| `MaxRememberedIds` | `int` | `256` | Cap on remembered ids per session. `0` remembers nothing, so every hit stays eligible each turn. |
| `StoreTurns` | `bool` | `true` | Persist each completed turn. Set `false` for a read-only agent. |
| `AwaitPersist` | `bool` | `true` | Await the write before the turn returns. See the note below. |
| `IsAgentMemory` | `bool` | `false` | Extract facts about the *assistant* rather than the user. |
| `Tags` | `IReadOnlyList<string>?` | `null` | Tags applied to every fact extracted from stored turns. |
| `Project` | `string?` | `null` | Project scope (e.g. a repo name) applied to stored turns. |
| `IncludeMemoryTools` | `bool` | `false` | Also offer `search_memory` / `add_memories` for the invocation, so one attachment gives both automatic and deliberate memory. |
| `ThrowOnError` | `bool` | `false` | Propagate Cortadel failures instead of swallowing them. |
| `OnError` | `Action<Exception>?` | `null` | Invoked with the exception when a Cortadel call fails. Replaces the warning log. |
| `Logger` | `ILogger?` | `null` | Logger for swallowed, unobserved failures. Falls back to `Console.Error`. |
| `StateKeyPrefix` | `string?` | `null` | Prefix for this provider's `AgentSession.StateBag` keys. Defaults to `CortadelContextProvider`. Give each one a distinct prefix when attaching more than one provider to the same agent. |

**Why `AwaitPersist` defaults to `true` here**, unlike most Cortadel integrations: the framework
never disposes a provider, so a program that returns from `RunAsync` and exits would drop an
in-flight write. Set it to `false` to take the write off the turn's critical path — then you must
dispose the provider (`await using` / `DisposeAsync`) to flush it, and a failed write can only be
seen through `OnError`.

### Tool options

`CortadelMemoryToolOptions`, accepted by `CortadelMemoryTools.CreateAll`,
`CreateSearchMemoryTool` and `CreateAddMemoriesTool`. The builders take these options:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `SearchToolName` | `string` | `"search_memory"` | Name the search tool is exposed under to the model. |
| `AddToolName` | `string` | `"add_memories"` | Name the write tool is exposed under to the model. |
| `TopK` | `int` | `10` | Result count `search_memory` uses when the model does not ask, matching the Cortadel SDK's own `SearchOptions` default for an explicit search. |
| `Rerank` | `string?` | `null` | Set to `cross_encoder` to rerank search results server-side. |
| `Infer` | `bool?` | `null` | Forwarded to `add_memories`; `false` stores the text verbatim and skips background entity/category extraction. Defaults to the server's `true`. |
| `MemoryType` | `string?` | `null` | Pin the cognitive type written by `add_memories`. |
| `ThrowOnError` | `bool` | `false` | Propagate a Cortadel failure to the framework's function-invocation machinery instead of answering the model with a graceful note. |
| `OnError` | `Action<Exception>?` | `null` | Invoked with the exception when a tool call fails. |
| `Logger` | `ILogger?` | `null` | Logger for swallowed, unobserved failures. |

## Running the tests

```bash
cd integrations/microsoft-agent-framework
dotnet test
```

The suite is fully offline: no Cortadel server, no network and no API keys. It stubs
`ICortadelMemory` (the interface the package's three Cortadel calls go through) and substitutes an
`IChatClient` that never reaches a model, so the end-to-end tests still drive a real
`ChatClientAgent`. `dotnet build` also compiles `examples/`, which is how the sample code stays
honest.

## Requirements

- **.NET 8.0 or later** (`net8.0` target).
- **Microsoft.Agents.AI ≥ 1.17.0** — and `Microsoft.Agents.AI.OpenAI` (or any other
  `Microsoft.Extensions.AI` chat client) to actually talk to a model.
- **A running Cortadel server**: hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` → `http://localhost:3001`. Self-hosted defaults to auth disabled, in which
  case `ApiKey` may be omitted.

## Links

- Cortadel — <https://cortadel.ai>
- Source and issues — <https://github.com/cortadel/cortadel>
- Microsoft Agent Framework — <https://github.com/microsoft/agent-framework>

Licensed under Apache-2.0.
