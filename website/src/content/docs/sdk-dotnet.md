---
title: .NET SDK reference
description: Every method, option, and model in the Cortadel.Sdk .NET client.
---

`Cortadel.Sdk` is a thin, typed client over the Cortadel REST API. It targets **.NET 8+**.

```bash
dotnet add package Cortadel.Sdk
```

## Construct a client

Reuse a single `CortadelClient` — it wraps one `HttpClient`. Every call is scoped to the `userId` you
pass in.

```csharp
using Cortadel.Sdk;

// convenience
using var cortadel = new CortadelClient("http://localhost:3001", userId: "alice", apiKey: null);

// full options
using var client = new CortadelClient(new CortadelClientOptions
{
    BaseUrl  = "http://localhost:3001",
    UserId   = "alice",
    ApiKey   = "<token>",              // omit when auth is disabled
    AppName  = "my-app",               // recorded on searches
    Timeout  = TimeSpan.FromSeconds(100),
});

// bring your own HttpClient (e.g. from IHttpClientFactory)
var withHttp = new CortadelClient(options, httpClient);
```

`CortadelClientOptions`

| Property | Default | Notes |
|---|---|---|
| `BaseUrl` *(required)* | — | e.g. `http://localhost:3001` |
| `UserId` *(required)* | — | memory namespace / access scope |
| `ApiKey` | `null` | bearer token; omit when auth is off |
| `AppName` | `cortadel-dotnet` | app label on searches |
| `Timeout` | 100 s | generous for reranked search |

## Methods

### `AddAsync(text, AddOptions?)` → `MemoryCreated`

Store a memory. The server extracts entities/categories in the background and runs dedup.

```csharp
var created = await cortadel.AddAsync(
    "Alice prefers dark mode.",
    new AddOptions
    {
        App        = "my-app",
        Metadata   = new Dictionary<string, object?> { ["source"] = "settings" },
        Infer      = true,          // false = store verbatim, skip extraction
        MemoryType = "semantic",    // episodic | semantic | procedural
    });

Console.WriteLine($"{created.Id} — {created.Event}");   // e.g. ADD or SKIP_DUPLICATE
```

### `AddConversationAsync(messages, ConversationOptions?)` → `ConversationResult`

Distill atomic facts from a transcript.

```csharp
var result = await cortadel.AddConversationAsync(
    new[]
    {
        new ChatMessage("user", "I moved to Berlin.", Uuid: "turn-1"),
        new ChatMessage("assistant", "Noted — Berlin."),
    },
    new ConversationOptions { SessionId = "sess-42", Tags = new[] { "onboarding" } });

Console.WriteLine($"stored {result.Stored}");
```

### `SearchAsync(query, SearchOptions?)` → `SearchResults`

Hybrid search (BM25 + vector fused with RRF).

```csharp
var hits = await cortadel.SearchAsync(
    "what are alice's preferences?",
    new SearchOptions
    {
        TopK       = 10,
        Mode       = "hybrid",         // hybrid | text | vector
        Rerank     = "cross_encoder",  // omit to skip reranking
        Detail     = "full",           // full | summary | headline
        SessionId  = null,
        MemoryType = null,
    });

foreach (var h in hits.Results)
    Console.WriteLine($"{h.RrfScore:F2}  {h.Content}");
```

### `ListAsync(ListOptions?)` → `MemoryList`

Paginated, newest-first.

```csharp
var page = await cortadel.ListAsync(new ListOptions
{
    Page = 1, Size = 20,
    Categories = "preferences",
    IncludeSuperseded = false,
});
Console.WriteLine($"{page.Total} total, {page.Pages} pages");
```

### `GetAsync(id)` → `MemoryDetail?`

Returns `null` when the memory doesn't exist. The content field is `Text`.

```csharp
var m = await cortadel.GetAsync(id);
if (m is not null) Console.WriteLine(m.Text);
```

### `DeleteAsync(ids)` → `string`

```csharp
var message = await cortadel.DeleteAsync(new[] { id1, id2 });
```

### `HealthAsync()` → `HealthResult`

```csharp
var health = await cortadel.HealthAsync();
Console.WriteLine(health.Status);   // healthy | degraded
```

## Error handling

Any non-success response throws `CortadelException`:

```csharp
try
{
    await cortadel.AddAsync("");
}
catch (CortadelException ex)
{
    Console.WriteLine($"{ex.StatusCode} {ex.Code}: {ex.Message}");
}
```

| Member | Meaning |
|---|---|
| `StatusCode` | HTTP status |
| `Code` | machine-readable error code |
| `Message` | human-readable message |

## Models at a glance

- `MemoryCreated` — `Id`, `Content`, `State`, `CreatedAt`, `Event`, `AppName`.
- `SearchResults` — `Query`, `Results: List<SearchHit>`, `Total`.
- `SearchHit` — `Id`, `Content`, `RrfScore`, `Categories`, `MemoryType`, `Tags`, `Source`, plus
  `Extra` for any extra server fields.
- `MemoryList` / `MemoryListItem` — paginated list (`CreatedAt` is Unix seconds).
- `MemoryDetail` — single memory; note the content field is `Text`, and `Metadata` maps `metadata_`.
- `ConversationResult` — `Stored`, `Skipped`, `Ids`, plus `Raw`.
- `HealthResult` — `Status`, `CheckedAt`, plus `Checks`.

Forward-compatible: responses expose a `[JsonExtensionData]` bag (`Extra` / `Raw` / `Checks`) so new
server fields are never lost.

## Thread-safety & lifetime

`CortadelClient` is safe to share across threads. Create one per base URL + user and keep it for the
app's lifetime. Call `Dispose()` only if the client created its own `HttpClient` (i.e. you didn't
pass one in).
