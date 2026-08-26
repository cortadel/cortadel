# Cortadel Use Cases & Examples

Concrete integration patterns, each grounded in the operations documented in
`references/api-reference.md` and `references/sdk-guide.md`.

## Table of Contents

1. [Zero-Code Agent Memory via MCP](#1-zero-code-agent-memory-via-mcp)
2. [Backend Service with Per-User Memory](#2-backend-service-with-per-user-memory)
3. [Correcting or Forgetting a Fact](#3-correcting-or-forgetting-a-fact)
4. [Conversation-to-Memory Ingestion](#4-conversation-to-memory-ingestion)
5. [Multi-User / Multi-Tenant Scoping](#5-multi-user--multi-tenant-scoping)
6. [Browsing and Auditing History](#6-browsing-and-auditing-history)
7. [Health-Gated Startup](#7-health-gated-startup)
8. [Reranked Recall for a Chat Agent](#8-reranked-recall-for-a-chat-agent)

---

## 1. Zero-Code Agent Memory via MCP

Give any MCP-capable client durable memory by pointing it at one URL — no SDK, no server code. The
URL is `<base_url>/mcp/{clientName}`, where `<base_url>` is either the hosted service at
`https://app.cortadel.ai` (get a key from its dashboard) or your own self-hosted server's origin
(shown below):

```json
{
  "mcpServers": {
    "cortadel": {
      "type": "http",
      "url": "http://localhost:3001/mcp/claude",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

`clientName` (`claude` above) becomes the memory's app name; `userId` (`alice`) is the memory
namespace and must match the key's user. Once connected, the agent calls `search_memory` before
answering and `add_memories`/`add_conversation` after — durable recall across sessions with zero
glue code. For Claude Code specifically, this repo also ships a zero-dependency hooks plugin
(`cortadel-plugin`, package `cortadel-memory`) that automates exactly this push/recall
loop — see its own README for setup.

---

## 2. Backend Service with Per-User Memory

A typical pattern: a support or assistant backend that stores what it learns about a user, then
recalls it before generating a response.

```csharp
using Cortadel.Sdk;

public class SupportAssistant
{
    private readonly CortadelClient _cortadel;

    public SupportAssistant(string userId)
        => _cortadel = new CortadelClient("http://cortadel.internal:3001", userId: userId);

    public async Task<string> RespondAsync(string userMessage)
    {
        // 1. Recall relevant context before generating a response.
        var hits = await _cortadel.SearchAsync(userMessage, new SearchOptions { TopK = 5, Rerank = "cross_encoder" });
        var context = string.Join("\n", hits.Results.Select(h => $"- {h.Content}"));

        // 2. Generate a response with your own LLM call, feeding `context` into the prompt.
        var reply = await GenerateReplyAsync(userMessage, context);

        // 3. Store anything durable from this turn — the server classifies intent and dedups.
        await _cortadel.AddAsync($"User said: {userMessage}\nAssistant replied: {reply}",
            new AddOptions { App = "support-bot" });

        return reply;
    }
}
```

The same shape in Python, using the blocking client inside a synchronous request handler:

```python
from cortadel import SyncCortadelClient, SearchOptions, AddOptions

def respond(user_id: str, user_message: str, generate_reply) -> str:
    with SyncCortadelClient("http://cortadel.internal:3001", user_id) as cortadel:
        hits = cortadel.search(user_message, SearchOptions(top_k=5, rerank="cross_encoder"))
        context = "\n".join(f"- {h.content}" for h in hits.results)

        reply = generate_reply(user_message, context)

        cortadel.add(
            f"User said: {user_message}\nAssistant replied: {reply}",
            AddOptions(app="support-bot"),
        )
        return reply
```

---

## 3. Correcting or Forgetting a Fact

Cortadel's intent classification means you don't need a separate "delete" call for most
corrections — write the correction as plain language and let the server figure out it supersedes
or invalidates the old fact, then confirm via the returned `event`.

```ts
const stored = await cortadel.add("Alice's favorite editor is VS Code.");
console.log(stored.event); // ADD

// Later, a correction:
const corrected = await cortadel.add("Alice's favorite editor is now Neovim, not VS Code.");
console.log(corrected.event); // inspect this — don't assume it's a plain ADD

// Explicit forgetting:
const forgotten = await cortadel.add("Forget that Alice ever used VS Code.");
console.log(forgotten.event);
```

Because `event` is a plain string in the public contract (not a closed enum you can switch on with
compile-time exhaustiveness), always log or branch defensively on whatever value comes back rather
than assuming it's always `ADD` or `SKIP_DUPLICATE`. If you need to guarantee a memory is gone
regardless of how intent classification resolved it, use the explicit bulk-delete call instead:

```ts
await cortadel.delete([memoryId]);
```

---

## 4. Conversation-to-Memory Ingestion

Instead of hand-writing memory text, distill an entire transcript in one call. Useful at the end of
a session, or periodically during a long-running conversation.

```python
from cortadel import ChatMessage, ConversationOptions

messages = [
    ChatMessage(role="user", content="I just moved to Berlin and I'm vegetarian."),
    ChatMessage(role="assistant", content="Got it — Berlin, vegetarian. I'll keep that in mind."),
    ChatMessage(role="user", content="Also, please don't ping me before 9am."),
]

result = await cortadel.add_conversation(
    messages,
    ConversationOptions(session_id="session-2026-08-12", tags=["onboarding"]),
)

if result.no_facts_extracted:
    print("nothing storable in this transcript")
else:
    for item in result.results or []:
        print(item.event, "-", item.memory)
```

`tags` here apply to every fact distilled from this conversation — this is the one create-path
operation with a `tags` parameter; single-memory `add`/`AddAsync`/`add()` has no `tags` option at
all (`references/api-reference.md`). Use it to scope retrieval later, e.g. filtering by project or
integration source.

---

## 5. Multi-User / Multi-Tenant Scoping

Every client is bound to one `userId` at construction time — memories are strictly namespaced per
user, and when auth is enabled the server rejects any request whose user doesn't match the key.
Don't share one client across users; construct one per user (or per request, if user identity
varies per request) instead:

```ts
import { CortadelClient } from "@cortadel/sdk";

function clientFor(userId: string, apiKey: string) {
  return new CortadelClient({
    baseUrl: "http://cortadel.internal:3001",
    userId,
    apiKey,
    appName: "my-saas-app",
  });
}

// Per request:
const cortadel = clientFor(req.user.id, req.user.cortadelKey);
const hits = await cortadel.search(req.query.q, { topK: 10 });
```

For a fixed, small set of long-lived users (e.g. a handful of team members using an internal tool),
constructing one client per user up front and keeping them for the app's lifetime is fine — all
three SDKs document their clients as safe to reuse/share across calls (`references/sdk-guide.md`).

---

## 6. Browsing and Auditing History

`list` is the paginated browse endpoint — distinct from `search` — good for admin views, exports,
or auditing what a user's memory graph currently contains (or contained as of a past date).

```csharp
// Current, newest-first, 20 per page.
var page = await cortadel.ListAsync(new ListOptions { Page = 1, Size = 20 });

// Including superseded history — see what used to be true.
var withHistory = await cortadel.ListAsync(new ListOptions { Page = 1, Size = 20, IncludeSuperseded = true });

// Fetch one memory's full detail, including what superseded it (if anything).
var detail = await cortadel.GetAsync(page.Items[0].Id);
if (detail is not null)
    Console.WriteLine($"{detail.Text} (current: {detail.IsCurrent}, superseded_by: {detail.SupersededBy})");
```

`MemoryDetail`/`MemoryDetailResponse` carries `SupersededBy`/`superseded_by`, which the list-item
shape does not — fetch the detail record when you need to walk a supersession chain, not just the
list page.

---

## 7. Health-Gated Startup

`GET /api/health` is always unauthenticated and never returns memory content, so it's safe to use
as a container/orchestrator health probe or a startup readiness gate.

```python
from cortadel import CortadelClient

async def wait_until_ready(cortadel: CortadelClient) -> None:
    health = await cortadel.health()
    if health.status != "ok":
        # health() does not raise on a degraded (503) response — it's a normal return value.
        # Inspect health.checks (memgraph / embeddings / indexes) to see which dependency is down.
        raise RuntimeError(f"Cortadel is degraded: {health.checks}")
```

Remember `health()`/`HealthAsync()` only raises/throws `CortadelError`/`CortadelException` for
transport failures or unmapped statuses — a degraded server is a normal, non-exceptional return
value by design (`references/sdk-guide.md`).

---

## 8. Reranked Recall for a Chat Agent

For an agent that needs the sharpest possible top-k before it burns context window on it, combine
the cross-encoder rerank with a token budget so the result set fits your prompt:

```python
from cortadel import SearchOptions

hits = await cortadel.search(
    "what does the user want in their next release?",
    SearchOptions(top_k=20, mode="hybrid", rerank="cross_encoder"),
)

# Take the top few post-rerank results for the prompt.
context_block = "\n".join(f"- {h.content}" for h in hits.results[:5])
```

`rerank="cross_encoder"` runs entirely on the bundled local model — no external LLM call, so
latency stays predictable even under load. If you don't set it, results are ranked purely by
`rrf_score` (the BM25+vector fusion score), which is faster but less precise for ambiguous queries.

The wire-level `SearchMemoriesRequest` also has an `include_session_arm` flag — useful when
memories are fine-grained (per-turn) and the right context is more likely to be found by first
matching a session summary and expanding to its member memories — but **none of the three published
SDKs' `SearchOptions` expose it** (or `expand_query`, `include_faded`, `token_budget`); those four
wire fields are reachable only by calling `POST /api/v1/memories/search` directly
(`references/api-reference.md`), not through `search()`/`SearchAsync()` in this SDK version.
