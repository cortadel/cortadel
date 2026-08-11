# Cortadel.Sdk

Official .NET SDK for [**Cortadel**](https://github.com/cortadel/cortadel) — self-hosted long-term
temporal graph memory for AI agents. A thin, typed client over the Cortadel REST API.

```bash
dotnet add package Cortadel.Sdk
```

## Usage

```csharp
using Cortadel.Sdk;

var cortadel = new CortadelClient("http://localhost:3001", userId: "alice", apiKey: null);

// Store
await cortadel.AddAsync("Alice prefers dark mode and ships on Fridays.");

// Recall (hybrid BM25 + vector + RRF)
var hits = await cortadel.SearchAsync("what are alice's preferences?", new() { TopK = 5 });
foreach (var h in hits.Results)
    Console.WriteLine($"{h.RrfScore:F2}  {h.Content}");

// Ingest a conversation
await cortadel.AddConversationAsync(new[]
{
    new ChatMessage("user", "I'm allergic to peanuts."),
    new ChatMessage("assistant", "Noted — I'll avoid peanut recipes."),
});

// List / get / delete
var page = await cortadel.ListAsync(new() { Page = 1, Size = 20 });
var one  = await cortadel.GetAsync(page.Items[0].Id);
await cortadel.DeleteAsync(new[] { page.Items[0].Id });
```

## Errors

Non-success responses throw `CortadelException` with `.StatusCode` and `.Code`.

```csharp
try { await cortadel.AddAsync(""); }
catch (CortadelException ex) { Console.WriteLine($"{ex.StatusCode} {ex.Code}: {ex.Message}"); }
```

## Notes

- Reuse a single `CortadelClient` (it wraps one `HttpClient`). Optionally pass your own `HttpClient`.
- Every call is scoped to the `userId` you construct the client with.
- The `Cortadel.Sdk.Generated` namespace is Kiota-generated transport plumbing, not part of this
  package's supported API. It's `public` today (a limitation of how it's generated, not a design
  choice) but unversioned: a future contract regeneration can rename or remove any type in it
  without that counting as a breaking change to `Cortadel.Sdk`. Only `Cortadel.Sdk.CortadelClient`
  and the types in `Cortadel.Sdk` (this namespace) are covered by SemVer.
- Full guide: [.NET SDK reference](https://github.com/cortadel/cortadel/blob/main/docs/sdk-dotnet.md).

Licensed under **Apache-2.0**. The Cortadel server is a separate commercial product — see
[cortadel.ai](https://cortadel.ai).
