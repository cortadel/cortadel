---
title: Getting started
description: From zero to storing and recalling a memory with the Cortadel .NET SDK.
---

This guide takes you from zero to storing and recalling a memory with the .NET SDK.

## 1. Run the server

Cortadel ships as a single container that serves the REST API, the MCP endpoint, and the dashboard
on port `3001`. The quickest way to try it (bring a graph DB) is Docker Compose; see
[Self-hosting](/self-hosting/) for the full compose file.

```bash
docker run -p 3001:3001 ghcr.io/cortadel/cortadel:latest
```

Open the dashboard at <http://localhost:3001> and check health:

```bash
curl http://localhost:3001/api/health
```

:::note
The server needs a graph database (FalkorDB or Memgraph) and an embedding provider reachable from
the container. [Self-hosting](/self-hosting/) wires both.
:::

## 2. Install the SDK

```bash
dotnet add package Cortadel.Sdk
```

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

- [Authentication](/authentication/) — turn on API keys and scope users.
- [MCP integration](/mcp/) — connect Claude, Cursor, or any MCP client with no code.
- [.NET SDK reference](/sdk-dotnet/) — every method, option, and model.
