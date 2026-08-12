# Cortadel Quickstart

Get a server running and store/recall your first memory in under five minutes.

## Step 1: Run the Server

The fastest path is the batteries-included compose — graph database, embeddings, and an LLM all
bundled, running on CPU (no GPU needed):

```bash
curl -O https://raw.githubusercontent.com/cortadel/cortadel/main/docker-compose.yml
docker compose up
```

**First run pulls a few GB** (images plus two models); then open the dashboard at
<http://localhost:3001> and check health:

```bash
curl http://localhost:3001/api/health
```

Just the server, bringing your own graph DB and providers? Run the container alone:

```bash
docker run -p 3001:3001 ghcr.io/cortadel/cortadel:latest
```

— then wire up FalkorDB or Memgraph plus an embedding/LLM provider; see `docs/self-hosting.md` in
this repo for the full environment-variable reference (`MEMFORGE_Database__Provider`,
`MEMFORGE_Embedding__Provider`, `MEMFORGE_Llm__Provider`, etc. — the config prefix is `MEMFORGE_`
even though the product is Cortadel).

## Step 2: Install an SDK

### .NET
```bash
dotnet add package Cortadel.Sdk
```
📦 [NuGet](https://www.nuget.org/packages/Cortadel.Sdk) — targets .NET 8+.

### TypeScript / JavaScript
```bash
npm install @cortadel/sdk
```
📦 [npm](https://www.npmjs.com/package/@cortadel/sdk) — ESM-only, targets Node ≥ 20.

### Python
```bash
pip install cortadel
```
📦 [PyPI](https://pypi.org/project/cortadel/) — targets Python 3.10+, ships both an async
(`CortadelClient`) and a blocking (`SyncCortadelClient`) facade.

## Step 3: Construct a Client

Every SDK call is scoped to the `userId`/`user_id` you construct the client with — memories are
namespaced per user, and (when auth is on) the server rejects any request whose user doesn't match
the API key.

### .NET (positional convenience constructor)
```csharp
using Cortadel.Sdk;

using var cortadel = new CortadelClient("http://localhost:3001", userId: "alice", apiKey: null);
```

### TypeScript (options object — not positional)
```ts
import { CortadelClient } from "@cortadel/sdk";

const cortadel = new CortadelClient({
  baseUrl: "http://localhost:3001",
  userId: "alice",
  apiKey: undefined, // omit when auth is disabled
});
```

### Python (as an async context manager)
```python
from cortadel import CortadelClient

async with CortadelClient("http://localhost:3001", "alice") as cortadel:
    ...
```

Or the blocking client for non-async scripts:
```python
from cortadel import SyncCortadelClient

with SyncCortadelClient("http://localhost:3001", "alice") as cortadel:
    cortadel.add("Alice prefers dark mode.")
```

## Step 4: Store and Recall

### .NET
```csharp
// Store a memory. Entities and categories are extracted in the background.
var created = await cortadel.AddAsync("Alice prefers dark mode and ships on Fridays.");
Console.WriteLine($"stored {created.Id} ({created.Event})");

// Recall with hybrid search.
var hits = await cortadel.SearchAsync("what are alice's working preferences?", new() { TopK = 5 });
foreach (var h in hits.Results)
    Console.WriteLine($"{h.RrfScore:F2}  {h.Content}");
```

### TypeScript
```ts
const created = await cortadel.add("Alice prefers dark mode and ships on Fridays.");
console.log(created.id, created.event);

const hits = await cortadel.search("what are alice's working preferences?", { topK: 5 });
for (const h of hits.results) console.log(h.rrfScore, h.content);
```

### Python
```python
from cortadel import SearchOptions

created = await cortadel.add("Alice prefers dark mode and ships on Fridays.")
print(created.id, created.event)

hits = await cortadel.search("what are alice's working preferences?", SearchOptions(top_k=5))
for h in hits.results:
    print(h.rrf_score, h.content)
```

`event` on the create response tells you what actually happened — `ADD` for a fresh memory,
`SKIP_DUPLICATE` when the dedup pipeline decided this fact already exists, and so on. A 200
response does not automatically mean a new memory was written; see `references/architecture.md`
for the full event vocabulary.

## Step 5: Ingest a Whole Conversation

Instead of writing memories yourself, let the server distill atomic facts from a transcript:

```csharp
await cortadel.AddConversationAsync(new[]
{
    new ChatMessage("user", "I just moved to Berlin and I'm vegetarian."),
    new ChatMessage("assistant", "Got it — Berlin, vegetarian. I'll keep that in mind."),
});
```

```ts
await cortadel.addConversation([
  { role: "user", content: "I just moved to Berlin and I'm vegetarian." },
  { role: "assistant", content: "Got it — Berlin, vegetarian. I'll keep that in mind." },
]);
```

```python
from cortadel import ChatMessage

await cortadel.add_conversation([
    ChatMessage(role="user", content="I just moved to Berlin and I'm vegetarian."),
    ChatMessage(role="assistant", content="Got it — Berlin, vegetarian. I'll keep that in mind."),
])
```

On empty extraction (nothing storable in the transcript) the response carries
`no_facts_extracted: true` instead of a `results` array — the two fields are mutually exclusive on
the wire, never both present.

## Step 6: Browse, Fetch, Delete

```csharp
var page = await cortadel.ListAsync(new() { Page = 1, Size = 20 });
Console.WriteLine($"{page.Total} memories across {page.Pages} pages");

var detail = await cortadel.GetAsync(page.Items[0].Id);   // null if not found
await cortadel.DeleteAsync(new[] { page.Items[0].Id });
```

`ListAsync`/`list()`/`list()` is a **separate, paginated envelope** from search —
`{items, page, pages, size, total}` — not the same shape as a search response
(`{query, results, total}`). Use `list` to browse newest-first with filters (`categories`,
`include_superseded`, `memory_type`); use `search` when you have a natural-language query. The
wire-level `GET /api/v1/memories` also accepts an `as_of` temporal filter, but no SDK's
`ListOptions` exposes it yet — reach for the REST API directly (`references/api-reference.md`) if
you need to browse as-of a past date.

## Step 7: Turn On Authentication (Optional)

Out of the box the server runs **open** — an empty auth secret leaves every REST and MCP endpoint
unauthenticated. That's fine for local development; **do not expose an open instance to the
internet.**

```bash
MEMFORGE_Auth__Secret=<a-long-random-string>
```

Then mint a key for a user with the bundled CLI inside the container:

```bash
docker exec -it <container> dotnet Cortadel.Api.dll mint-key alice
# prints a bearer token bound to userId "alice"
```

Pass it to the client constructor (`apiKey` / `api_key`), or over raw HTTP as
`Authorization: Bearer <token>`, the `API_KEY` header, or `?api_key=<token>`. `GET /api/health` is
always unauthenticated by design, for orchestrator health probes, and never returns memory content.

## Step 8: Connect an Agent via MCP (No Code)

Point any MCP-capable client at:

```
http://localhost:3001/mcp/{clientName}/{userId}
```

```json
{
  "mcpServers": {
    "cortadel": {
      "type": "http",
      "url": "http://localhost:3001/mcp/claude/alice",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

See `references/architecture.md` for the tool list and what each one does.

## Core Workflow Pattern

The standard round trip is the same across every surface:

1. **Store** memories as plain-language facts or whole conversations — let the server classify
   intent and extract entities in the background.
2. **Search** with a natural-language query before generating a response, so the agent's context
   includes durable facts, not just the current turn.
3. **List / get / delete** for browsing, auditing, or explicit cleanup outside the search path.

## Troubleshooting

**No results from search**
- Confirm you're searching with the same `userId`/`user_id` you stored with — memories are strictly
  namespaced per user.
- Background extraction and indexing happen asynchronously; a memory stored a moment ago may not be
  immediately searchable.

**403 on every request**
- The `userId` in the client (or the MCP path segment) must match the user the API key was minted
  for — a mismatch is rejected, not silently rescoped.

**Startup hard-fails on a dimension mismatch**
- The vector index dimension is fixed at first run. Switching to an embedding model with a
  different output dimension needs either `POST /api/v1/debug/reindex-vectors` to rebuild vectors,
  or `MEMFORGE_Embedding__SkipDimensionGuard=true` to boot past the guard on purpose.

**A 200 response but nothing new was stored**
- Check the `event` field on the response — `SKIP_DUPLICATE` means the dedup pipeline matched an
  existing memory; that's expected behavior, not a bug.

## Next Steps

- **SDK Reference**: `references/sdk-guide.md` — every method, option, model, and per-language caveat
- **API Reference**: `references/api-reference.md` — the raw REST contract
- **Architecture**: `references/architecture.md` — how the write and read pipelines actually work
- **Use Cases**: `references/use-cases.md` — concrete integration patterns
- **Self-hosting**: `docs/self-hosting.md` in this repo — full provider and env-var reference
