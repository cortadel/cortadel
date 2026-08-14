# Cortadel × Microsoft Agent Framework

Long-term memory for [Microsoft Agent Framework](https://learn.microsoft.com/agent-framework/)
agents, in .NET. Attach one `AIContextProvider` and the agents you already have recall what they
learned in earlier conversations before every model call, and file the finished turn away after it —
no bookkeeping in your own code, and nothing lost when the session ends. The package implements the
framework's **own** memory seam rather than bolting a callback onto the side, so recall and
persistence happen whether or not the agent (or the model) cooperates.

## Install

```bash
dotnet add package Cortadel.AgentFramework
```

That brings [`Cortadel.Sdk`](https://www.nuget.org/packages/Cortadel.Sdk) and
`Microsoft.Agents.AI` with it. You still need a `Microsoft.Extensions.AI` chat client to reach a
model — for the OpenAI path used below:

```bash
dotnet add package Microsoft.Agents.AI.OpenAI
```

## Quickstart

```csharp
using Cortadel.AgentFramework;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

// A Cortadel client is bound to one user id at construction — no call takes a user id — so a
// provider instance *is* the per-user object. Build one per end user and cache it; never share one.
// `await using` matters: the framework never disposes a provider, and disposal is what closes the
// client this provider built (and drains any background write).
await using var memory = new CortadelContextProvider(new CortadelContextProviderOptions
{
    BaseUrl = "http://localhost:3001",   // or https://app.cortadel.ai
    UserId = "e2e-alice",
    ApiKey = Environment.GetEnvironmentVariable("CORTADEL_API_KEY"), // omit when auth is disabled
    TopK = 5,
    IncludeMemoryTools = true,           // also hand the model search_memory / add_memories
    OnError = exception => Console.Error.WriteLine($"[cortadel] {exception.Message}"),
});

AIAgent agent = new OpenAIClient(Environment.GetEnvironmentVariable("OPENAI_API_KEY"))
    .GetChatClient("gpt-4o-mini")
    .AsAIAgent(new ChatClientAgentOptions
    {
        Name = "Memory Assistant",

        // The system prompt lives on ChatOptions.Instructions, not on ChatClientAgentOptions.
        ChatOptions = new ChatOptions
        {
            Instructions = "You are a helpful assistant. Use what you remember; never invent memories.",
        },
        AIContextProviders = [memory],
    });

var first = await agent.CreateSessionAsync();
Console.WriteLine((await agent.RunAsync("I'm Alex. I ship on Fridays.", first)).Text);

// Cortadel distils facts off the request path, so give the server a moment before asking for them
// back. In a real app there is a human between the turns and this is a non-issue.
await Task.Delay(TimeSpan.FromSeconds(3));

// A brand-new session, no chat history — whatever it knows here came out of Cortadel.
var later = await agent.CreateSessionAsync();
Console.WriteLine((await agent.RunAsync("When do I usually ship?", later)).Text);
```

A complete, runnable version lives in
[`examples/BasicMemoryAgent`](https://github.com/cortadel/cortadel/tree/main/integrations/microsoft-agent-framework/examples/BasicMemoryAgent).
It is a real project in the package's solution, so `dotnet build` type-checks it.

## What you get

**Automatic memory — `CortadelContextProvider`.** A real
`Microsoft.Agents.AI.AIContextProvider`, attached through `ChatClientAgentOptions.AIContextProviders`.
It overrides the two members the base class defines for exactly this:

| Seam | What it does |
|---|---|
| `ProvideAIContextAsync` | Hybrid-searches Cortadel with the current turn's input and returns an `AIContext` the framework merges into the invocation — as a user-role context message by default, or as system instructions (`InjectAs`). |
| `StoreAIContextAsync` | Hands the completed turn to Cortadel's `add_conversation` pipeline, which distils durable facts out of it off the request path. |

Per-session state (the ids already injected, the Cortadel session id) lives in
`AgentSession.StateBag` under the provider's declared `StateKeys`, so one provider instance safely
serves many sessions and the state survives `SerializeSessionAsync` / `DeserializeSessionAsync`.

**Memory tools — `CortadelMemoryTools`.** `search_memory` and `add_memories` as
`Microsoft.Extensions.AI.AIFunction`s. Where the provider gives an agent memory it never has to ask
for, these give it memory it can *choose* to use — recalling on demand mid-reasoning, or
deliberately committing something worth keeping:

```csharp
using Microsoft.Extensions.AI;

var cortadel = CortadelMemoryClient.Create("http://localhost:3001", "e2e-alice");

AIAgent agent = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    ChatOptions = new ChatOptions { Tools = CortadelMemoryTools.CreateAll(cortadel) },
});
```

`CreateAll` returns both; `CreateSearchMemoryTool` and `CreateAddMemoriesTool` build them
individually. Both are bound to a client at build time, so they are already scoped to that client's
user — the model cannot reach another user's memories by asking for them. Setting
`IncludeMemoryTools = true` on the provider gets both capabilities from a single attachment.

**Graceful degradation.** Every Cortadel call fails open. If the server is unreachable the agent
still answers, just without long-term memory: the provider returns no context, and the tools reply
`"Memory is temporarily unavailable; answer without it."` rather than throwing at the model.
`OnError` observes those failures, `ThrowOnError = true` propagates them instead, and a failure that
is neither observed nor propagated is logged as a warning (falling back to `Console.Error` when no
`ILogger` is set). `OperationCanceledException` is always rethrown untouched — cancellation is your
intent, not a Cortadel failure.

## Configuration

`CortadelContextProviderOptions`. Either set `BaseUrl` and `UserId` and let the provider build (and
own) a Cortadel client, or set `Client` to one you own yourself; anything else throws
`ArgumentException` at construction.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `BaseUrl` | `string?` | `null` | Cortadel server URL, e.g. `https://app.cortadel.ai` or `http://localhost:3001`. Required unless `Client` is set. |
| `UserId` | `string?` | `null` | The user whose memories this provider reads and writes. Required unless `Client` is set. Every call is scoped to it. |
| `ApiKey` | `string?` | `null` | Bearer token. Omit when the server runs with auth disabled. |
| `AppName` | `string` | `"Cortadel.AgentFramework"` | App name Cortadel records for access logging on searches. Defaults to the published package id. |
| `Client` | `ICortadelMemory?` | `null` | A pre-built client. When set, `BaseUrl` / `UserId` / `ApiKey` / `AppName` are ignored and you own its lifetime — the provider never disposes it. |
| `TopK` | `int` | `5` | Maximum memories to recall per turn (Cortadel accepts 1–50). Lower than the search *tool*'s 10, because this runs on every turn whether the agent wanted memories or not. |
| `SearchMode` | `string` | `"hybrid"` | `hybrid`, `text` or `vector`. |
| `Rerank` | `string?` | `null` | Set to `cross_encoder` to rerank with the server's cross-encoder. Cortadel accepts no other value; omit to skip. |
| `MemoryType` | `string?` | `null` | Restrict recall to one cognitive type: `episodic`, `semantic` or `procedural`. |
| `ContextPrompt` | `string` | a generic `## Memories` header | Header placed above the injected memories. Deliberately domain-agnostic. |
| `InjectAs` | `MemoryInjectionMode` | `MemoryInjectionMode.Message` | `Message` injects a user-role context message; `Instructions` appends the block to the invocation's system instructions instead. |
| `ScopeRecallToSession` | `bool` | `false` | Recall only what was stored under this session. Off by default — cross-session recall is the point of long-term memory. |
| `DeduplicateAcrossTurns` | `bool` | `true` | Skip memories already injected earlier in this session, so a long conversation does not re-pay for the same context every turn. |
| `MaxRememberedIds` | `int` | `256` | Cap on remembered ids per session, bounding session-state growth. `0` remembers nothing, so every hit stays eligible for re-injection each turn. |
| `StoreTurns` | `bool` | `true` | Persist each completed turn. Set `false` for a read-only agent. |
| `AwaitPersist` | `bool` | `true` | Await the write before the turn returns. Deviates from the repo-wide default — see below. |
| `IsAgentMemory` | `bool` | `false` | Extract facts about the *assistant* rather than the user. |
| `Tags` | `IReadOnlyList<string>?` | `null` | Tags applied to every fact extracted from stored turns. |
| `Project` | `string?` | `null` | Project scope (e.g. a repo name) applied to stored turns. |
| `IncludeMemoryTools` | `bool` | `false` | Also offer `search_memory` / `add_memories` for the invocation, so one attachment gives both automatic and deliberate memory. |
| `ThrowOnError` | `bool` | `false` | Propagate a Cortadel failure to the caller instead of swallowing it. |
| `OnError` | `Action<Exception>?` | `null` | Callback handed the exception when a Cortadel call fails. Replaces the warning log; a callback that itself throws is logged and swallowed. |
| `Logger` | `ILogger?` | `null` | Logger for swallowed, unobserved failures. Falls back to `Console.Error`. |
| `StateKeyPrefix` | `string?` | `null` | Prefix for this provider's `AgentSession.StateBag` keys. Defaults to `CortadelContextProvider`. Give each one a distinct prefix when attaching more than one provider to the same agent. |

> **Why `AwaitPersist` defaults to `true` here**, against the repo-wide fire-and-forget default: the
> framework never disposes a provider, so a program that returns from `RunAsync` and exits would drop
> an in-flight write. Set it to `false` to take the write off the turn's critical path — then you
> must dispose the provider (`await using` / `DisposeAsync`) to flush it, and a failed write can only
> be seen through `OnError`, never propagated, because by then there is no caller left to throw into.

### Tool options

`CortadelMemoryToolOptions`, accepted by `CortadelMemoryTools.CreateAll`, `CreateSearchMemoryTool`
and `CreateAddMemoriesTool`. When the provider builds the tools itself (`IncludeMemoryTools = true`)
it forwards only `ThrowOnError`, `OnError` and `Logger` — the rest keep their own defaults.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `SearchToolName` | `string` | `"search_memory"` | Name the search tool is exposed under to the model. |
| `AddToolName` | `string` | `"add_memories"` | Name the write tool is exposed under to the model. |
| `TopK` | `int` | `10` | Result count `search_memory` uses when the model does not ask for one, matching the Cortadel SDK's own `SearchOptions` default for an explicit search. |
| `Rerank` | `string?` | `null` | Set to `cross_encoder` to rerank search results server-side. |
| `Infer` | `bool?` | `null` | Forwarded to `add_memories`; `false` stores the text verbatim and skips background entity/category extraction (dedup still applies). Defaults to the server's `true`. |
| `MemoryType` | `string?` | `null` | Pin the cognitive type written by `add_memories`. |
| `ThrowOnError` | `bool` | `false` | Propagate a Cortadel failure to the framework's function-invocation machinery instead of answering the model with a graceful note. |
| `OnError` | `Action<Exception>?` | `null` | Callback handed the exception when a tool call fails. The model still gets the graceful note unless `ThrowOnError` is set. |
| `Logger` | `ILogger?` | `null` | Logger for swallowed, unobserved failures. Falls back to `Console.Error`. |

## How it works

**The extension point is `Microsoft.Agents.AI.AIContextProvider`** — the framework's own memory
abstraction, not a generic callback. `CortadelContextProvider` derives from it and overrides exactly
two protected members, `ProvideAIContextAsync(InvokingContext, …)` and
`StoreAIContextAsync(InvokedContext, …)`, which the base class invokes from its public
`InvokingAsync` / `InvokedAsync` lifecycle. Everything else is the framework's machinery, and the
package leans on it deliberately:

**Before the model call.** The base class hands `ProvideAIContextAsync` the turn's input messages
already filtered by `ProvideInputMessageFilter` (user-role by default). The provider joins their
text into one query, calls `SearchAsync`, renders each hit as a single line — preferring the
server's distilled `Gist` over the raw `Content`, and flattening newlines so one memory stays one
line — and returns an `AIContext` carrying either `Messages` (a user-role block under
`ContextPrompt`) or `Instructions`. The framework merges that into the invocation and stamps the
returned messages with `AgentRequestMessageSourceType.AIContextProvider` and a source id of
`typeof(CortadelContextProvider).FullName`. When `IncludeMemoryTools` is on, the same `AIContext`
carries `Tools` — built once in the constructor, since an `AIFunction` is stateless and reflecting a
schema per turn would be pure waste.

**After the turn.** The base class calls `StoreAIContextAsync` only when the invocation *succeeded*,
and only with request messages that passed `StoreInputRequestMessageFilter` — which by default keeps
just the caller's own new input. The provider re-checks the attribution anyway: a message is
ingestible only if `GetAgentRequestMessageSourceType()` is `External` and its role is user,
assistant or system with non-blank text. That check is the feedback-loop guard. Without it, a memory
this provider recalled would be written back as if the user had said it, amplifying it a little more
every turn; replayed `ChatHistory` would be re-ingested on every turn too. Surviving messages become
Cortadel `ChatMessage`s (the framework's `MessageId` carried across as the Cortadel `Uuid`) and go
to `AddConversationAsync` with `Tags`, `Project`, `IsAgentMemory` and the session id.

**Sessions.** Cortadel's `SessionId` comes from `ChatClientAgentSession.ConversationId` when the
chat service manages the thread. For a client-managed session — where that id is `null` — the
provider mints one and keeps it in `AgentSession.StateBag`, so it survives session serialization.
Turns are *written* tagged with the session but *recalled* across every session by default, which is
what makes this long-term memory rather than a transcript buffer; `ScopeRecallToSession` restricts
recall to the live session.

**Session state, not provider state.** `StateKeys` declares `<prefix>.InjectedMemoryIds` and
`<prefix>.SessionId`, and both live in the session's state bag rather than in fields on the provider,
because one provider serves many sessions. `ChatClientAgent` treats duplicate state keys as a
construction-time error, which is why a second provider on the same agent needs its own
`StateKeyPrefix`.

**The tools** are built with the framework's own tool primitive, `AIFunctionFactory.Create`, which
derives the JSON schema from the delegate's signature and turns each parameter's
`[Description]` into that parameter's schema description. The result is an `AIFunction` — an
`AITool`, exactly what `ChatClientAgentOptions.ChatOptions.Tools` and `AIContext.Tools` accept. The
model-facing search parameter is deliberately spelled `top_k`, matching Cortadel's own vocabulary,
and is clamped into the 1–50 range the server accepts; the `CancellationToken` parameter is
plumbing and never appears in the schema. `add_memories` reports what the store pipeline actually
decided rather than assuming a 2xx meant a new memory — a `SKIP_DUPLICATE` verdict comes back to the
model as `"Already remembered; nothing new was stored."`

**Failures** funnel through one internal reporter, so the provider and the tools behave identically:
observe via `OnError`, propagate via `ThrowOnError`, otherwise warn. Background writes
(`AwaitPersist = false`) are tracked in a strong reference set and drained by `DisposeAsync`, and
they never propagate — an unobserved `Task` exception is not a failure mode worth shipping.

## Known limits

- **.NET only.** This is the Microsoft Agent Framework's .NET flavour; its Python flavour has no
  Cortadel package.
- **`AwaitPersist` defaults to `true`**, deviating from the repo-wide fire-and-forget default,
  because the framework never disposes a provider (reason and trade-off above).
- **One provider instance per end user.** A Cortadel client is bound to a single user id at
  construction — no method takes a user id per call — so a provider *is* a per-user object. Sharing
  one across users mixes their memories.
- **Two providers on one agent need distinct `StateKeyPrefix` values**, or `ChatClientAgent` rejects
  the pair at construction over colliding state keys.
- **Streaming runs are not driven by a test.** The offline suite's stub chat client implements the
  streaming path, but every end-to-end test goes through `RunAsync`; nothing exercises
  `RunStreamingAsync`.
- **Nothing runs against a live Cortadel server in CI.** The suite stubs `ICortadelMemory` — the
  interface the package's three Cortadel calls (`SearchAsync`, `AddConversationAsync`, `AddAsync`)
  go through — so wire-level behaviour rests on the [.NET SDK](../sdk-dotnet.md) and its own
  conformance suite.
- **`TopK` is validated, not clamped.** The constructor rejects `TopK < 1` (and a negative
  `MaxRememberedIds`) but does not cap the upper end, so a `TopK` above 50 reaches the server and is
  the server's to reject. Only the *tool*'s model-supplied `top_k` is clamped into 1–50.
- **`AppName` is a search-side label.** The SDK sends it on searches only: `add_conversation` sends
  no app name at all, and the `add_memories` tool writes with the app fixed to
  `Cortadel.AgentFramework` — a custom `AppName` does not change what that tool records.
- **Recalled memories are trusted content.** The framework documents context providers as trusted:
  whatever the provider returns is merged into the request as-is. Memories are user-authored text
  from an earlier conversation, so treat a Cortadel instance you do not control as an
  indirect-prompt-injection source, exactly as you would any retrieval corpus.
- **Recall costs one search per turn** on the request path, with the query built by concatenating
  the turn's filtered input text — there is no query rewriting or recall gating. `StoreTurns = false`
  gives a read-only agent; `AwaitPersist = false` moves the write off the critical path.

## Requirements

- **.NET 8.0 or later** — the package targets `net8.0`.
- **`Microsoft.Agents.AI` ≥ 1.17.0**, plus a `Microsoft.Extensions.AI` chat client to actually
  reach a model (`Microsoft.Agents.AI.OpenAI` in the quickstart above). `Cortadel.Sdk` and
  `Microsoft.Extensions.AI.Abstractions` come in transitively.
- **A running Cortadel server** — the hosted service at `https://app.cortadel.ai`, or your own via
  `docker compose up` → `http://localhost:3001` (see [Self-hosting](../self-hosting.md)). A
  self-hosted server defaults to auth disabled, in which case `ApiKey` may be omitted; otherwise
  mint a key (see [Authentication](../authentication.md)).

## Links

- Package — [`Cortadel.AgentFramework` on NuGet](https://www.nuget.org/packages/Cortadel.AgentFramework)
- Source — [`integrations/microsoft-agent-framework`](https://github.com/cortadel/cortadel/tree/main/integrations/microsoft-agent-framework)
- All twelve packages — [Integrations](../integrations.md)
- Microsoft Agent Framework — <https://github.com/microsoft/agent-framework>
