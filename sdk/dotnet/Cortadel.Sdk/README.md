# Cortadel.Sdk

Official .NET SDK for [**Cortadel**](https://github.com/cortadel/cortadel) — self-hosted long-term
temporal graph memory for AI agents. A thin, typed client over the Cortadel REST API.

```bash
dotnet add package Cortadel.Sdk
```

## Usage

```csharp
using Cortadel.Sdk;

// The API key identifies the user - the server resolves it from the key.
var cortadel = new CortadelClient("http://localhost:3001", apiKey: "ck_...");

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

Non-success responses throw `CortadelException` with `.StatusCode` and `.Code` — **except** a
degraded health check (HTTP 503 with a `{"status":"degraded",...}` body from `HealthAsync`), which
is returned like any other value (`Status == "degraded"`) instead of throwing.

```csharp
try { await cortadel.AddAsync(""); }
catch (CortadelException ex) { Console.WriteLine($"{ex.StatusCode} {ex.Code}: {ex.Message}"); }
```

## `userId` is optional

`userId` is optional in both constructors. **Omit it and the client sends no `user_id` at all** —
no body field, no query parameter — and the server resolves the user from your API key:

```csharp
// Identity comes from the key.
using var cortadel = new CortadelClient("http://localhost:3001", apiKey: "ck_...");

// Same thing with the options object.
using var viaOptions = new CortadelClient(new CortadelClientOptions
{
    BaseUrl = "http://localhost:3001",
    ApiKey  = "ck_...",
});
```

**Server requirement.** Omitting `userId` needs a server that includes commit **`30b70ea4`** (the
one that made the API fill a missing `user_id` from the key). Check what you're pointing at with
`GET /api/health` — its `version` field embeds the running commit SHA:

```bash
curl -s http://localhost:3001/api/health | jq -r .version
# 1.0.0+44be8adfc376d19cf6999a379cc8519331def7e6
```

```csharp
Console.WriteLine((await cortadel.HealthAsync()).Status);   // "ok"
```

Against an older server, omitting `userId` comes back as HTTP 400 —
`CortadelException` with `Code == "validation_error"` and `The UserId field is required` in the
message. Pass `userId` and it works against every server version.

**Still pass `userId` on an auth-disabled server.** With an empty `Auth:Secret` there is no key to
resolve an identity from, and `userId` is the only thing selecting a namespace — it is required in
practice there, and it is not deprecated:

```csharp
using var local = new CortadelClient("http://localhost:3001", userId: "alice");
```

Supplying `userId` as a blank or whitespace string throws `ArgumentException`. Omitting it does not.

## Notes

- Reuse a single `CortadelClient` (it wraps one `HttpClient`). Optionally pass your own `HttpClient`.
- Every call carries the `userId` you construct the client with, when you give one — and on an
  authenticated server the key still decides the namespace: a `user_id` that disagrees with the key
  is silently rescoped in a request body, and rejected with 403 in a query string. So `userId` is
  authoritative only on an auth-disabled server.
- The `Cortadel.Sdk.Generated` namespace is Kiota-generated transport plumbing, not part of this
  package's supported API. It's generated `internal` (`--type-access-modifier Internal`), so it
  isn't visible outside this assembly at all — it's unversioned: a future contract regeneration can
  rename or remove any type in it without that counting as a breaking change to `Cortadel.Sdk`. Only
  `Cortadel.Sdk.CortadelClient` and the types in `Cortadel.Sdk` (this namespace) are covered by
  SemVer.
- Full guide: [.NET SDK reference](https://github.com/cortadel/cortadel/blob/main/docs/sdk-dotnet.md).

Licensed under **Apache-2.0**. The Cortadel server is a separate commercial product — see
[cortadel.ai](https://cortadel.ai).
