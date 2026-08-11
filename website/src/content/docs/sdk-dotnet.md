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
| `Timeout` | 100 s | generous for reranked search. **No-op if you pass your own `HttpClient`** (see below) — the facade never mutates a caller-supplied client, so set the timeout on that `HttpClient` yourself instead. |

`Timeout` only applies to the `HttpClient` the constructor creates for you. When you bring your own
(`new CortadelClient(options, httpClient)`, e.g. from `IHttpClientFactory`), `Timeout` is silently
ignored — the facade never touches `BaseAddress`, `Timeout`, or `DefaultRequestHeaders` on a client
it doesn't own.

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

Console.WriteLine(result.NoFactsExtracted == true
    ? "no facts extracted"
    : $"stored {result.Results?.Count ?? 0} fact(s)");
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
Console.WriteLine(health.Status);   // ok | degraded
```

`HealthAsync` does **not** throw when the server reports itself degraded (HTTP 503 with an
`{"status":"degraded",...}` body) — it catches that response and returns it like any other, so a
degraded server is a normal return value, not an exception. `CortadelException` is still thrown for
every other non-success response (a transport failure, an unmapped status code, or a body the
generated client can't parse).

## Error handling

Any non-success response — **other than a degraded (503) health check, which `HealthAsync` returns
instead of throwing (see above)** — throws `CortadelException`:

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
- `SearchHit` — `Id`, `Content`, `RrfScore`, `Categories`, `MemoryType`, `Tags`, `Source`, plus an
  `Extra` member (see caveat below).
- `MemoryList` / `MemoryListItem` — paginated list (`CreatedAt` is Unix seconds).
- `MemoryDetail` — single memory; note the content field is `Text`, and `Metadata` maps `metadata_`.
- `ConversationResult` — `Results: List<ConversationIngestItem>?`, `NoFactsExtracted`, plus a `Raw`
  member (see caveat below). The two are mutually exclusive on the wire: the server sends `Results`
  when it distilled facts, `NoFactsExtracted = true` when it didn't, never both.
- `HealthResult` — `Status` (`ok` | `degraded`), `CheckedAt`, plus `Checks` (see caveat below).

**Not actually forward-compatible today, from `CortadelClient`.** `SearchHit.Extra`,
`ConversationResult.Raw`, and `HealthResult.Extra` are `[JsonExtensionData]` bags that work as
documented only if you deserialize these DTOs directly with `System.Text.Json`, bypassing
`CortadelClient` entirely. Every value `CortadelClient` itself returns took a different path: its
pipeline deserializes the response via a Kiota-generated type first (`HybridSearchResult`,
`ConversationIngestResponse`, `HealthResponse`), none of which implement Kiota's
`IAdditionalDataHolder`, and only then maps that into the DTO — so from `CortadelClient`, all three
read as `null`, always. `HealthResult.Checks` is the same story, one level deeper: the contract
marks the checks map (and each individual check) `additionalProperties: false`, so the
Kiota-generated types `CortadelClient`'s pipeline deserializes through drop an undeclared dependency
check or an undeclared field on a known check *before* that data ever reaches `Checks` — again, only
true for a value that came from `CortadelClient`. `Checks` itself is a plain
`Dictionary<string, JsonElement>` with no such restriction, so deserializing `HealthResult` directly
with `System.Text.Json` does preserve arbitrary keys there. None of the four members were removed
(the public surface is frozen), but don't rely on any of them to carry a field this SDK doesn't
already know about when the value came from `CortadelClient`.

## Thread-safety & lifetime

`CortadelClient` is safe to share across threads. Create one per base URL + user and keep it for the
app's lifetime. Call `Dispose()` only if the client created its own `HttpClient` (i.e. you didn't
pass one in).

## Supported surface

Only `CortadelClient` and the types declared directly in the `Cortadel.Sdk` namespace (this
reference) are covered by SemVer. The `Cortadel.Sdk.Generated` namespace is Kiota-generated
transport code, generated `internal` (`--type-access-modifier Internal`) — it isn't visible outside
the `Cortadel.Sdk` assembly, so you cannot reference it even if you wanted to. It's unversioned
regardless: expect it to change shape (including type removals/renames) across any release,
including patch releases.
