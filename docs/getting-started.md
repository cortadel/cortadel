# Getting started

This guide takes you from zero to storing and recalling a memory with the .NET SDK.

## 1. Run the server

The fastest way to a **fully working** server — graph DB, embeddings, and an LLM all included — is the
batteries-included compose. Everything runs on CPU (no GPU needed):

```bash
curl -O https://raw.githubusercontent.com/cortadel/cortadel/main/docker-compose.yml
docker compose up
```

**First run pulls a few GB** (images + models); then open the dashboard at <http://localhost:3001>
and check health:

```bash
curl http://localhost:3001/api/health
```

> Just the server, or your own backends? `docker run -p 3001:3001 ghcr.io/cortadel/cortadel:latest`
> runs the container alone — see [Self-hosting](self-hosting.md) to wire a graph DB + providers.

## 2. Install the SDK

```bash
dotnet add package Cortadel.Sdk
```

> Prefer Python or TypeScript? `pip install cortadel` — see the [Python SDK reference](sdk-python.md)
> — or `npm install @cortadel/sdk` — see the [TypeScript SDK reference](sdk-typescript.md) — for the
> equivalent walkthrough.

## 3. Store and recall

```csharp
using Cortadel.Sdk;

using var cortadel = new CortadelClient("http://localhost:3001", userId: "alice");

// Store a memory. Entities and categories are extracted in the background.
var created = await cortadel.AddAsync("Alice prefers dark mode and ships on Fridays.");
Console.WriteLine($"stored {created.Id} ({created.Event})");

// Recall with hybrid search.
var hits = await cortadel.SearchAsync("what are alice's working preferences?", new() { TopK = 5 });
foreach (var h in hits.Results)
    Console.WriteLine($"{h.RrfScore:F2}  {h.Content}");
```

## 4. Ingest a whole conversation

Let the server distill atomic facts from a transcript instead of writing them yourself:

```csharp
await cortadel.AddConversationAsync(new[]
{
    new ChatMessage("user", "I just moved to Berlin and I'm vegetarian."),
    new ChatMessage("assistant", "Got it — Berlin, vegetarian. I'll keep that in mind."),
});
```

## 5. Browse, fetch, delete

```csharp
var page = await cortadel.ListAsync(new() { Page = 1, Size = 20 });
Console.WriteLine($"{page.Total} memories across {page.Pages} pages");

var detail = await cortadel.GetAsync(page.Items[0].Id);   // null if not found
await cortadel.DeleteAsync(new[] { page.Items[0].Id });
```

## Next steps

- [Authentication](authentication.md) — turn on API keys and scope users.
- [MCP integration](mcp.md) — connect Claude, Cursor, or any MCP client with no code.
- [.NET SDK reference](sdk-dotnet.md) — every method, option, and model.
- [Python SDK reference](sdk-python.md) — every method, option, and model.
- [TypeScript SDK reference](sdk-typescript.md) — every method, option, and model.
