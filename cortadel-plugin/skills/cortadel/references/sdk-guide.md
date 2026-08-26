# Cortadel SDK Guide

Complete reference for the three published SDKs — .NET, TypeScript, and Python — all thin, typed
clients over the same seven REST operations (`references/api-reference.md`). All three are
published at `1.1.0`.

## Installation

### .NET
```bash
dotnet add package Cortadel.Sdk
```
📦 [NuGet](https://www.nuget.org/packages/Cortadel.Sdk) · targets **.NET 8+**.

### TypeScript / JavaScript
```bash
npm install @cortadel/sdk
```
📦 [npm](https://www.npmjs.com/package/@cortadel/sdk) · **ESM-only**, targets **Node ≥ 20**.

### Python
```bash
pip install cortadel
# or: uv add cortadel / poetry add cortadel
```
📦 [PyPI](https://pypi.org/project/cortadel/) · targets **Python 3.10+**, ships two facades: a real
async client and a real blocking client.

## Initialization

### .NET — positional convenience constructor, or full options

```csharp
using Cortadel.Sdk;

// convenience
using var cortadel = new CortadelClient("http://localhost:3001", userId: "alice", apiKey: null);

// full options
using var client = new CortadelClient(new CortadelClientOptions
{
    BaseUrl  = "http://localhost:3001",
    UserId   = "alice",
    ApiKey   = "<token>",   // omit when auth is disabled
    AppName  = "my-app",    // recorded on searches
    Timeout  = TimeSpan.FromSeconds(100),
});

// bring your own HttpClient (e.g. from IHttpClientFactory)
var withHttp = new CortadelClient(options, httpClient);
```

`CortadelClientOptions`:

| Property | Default | Notes |
|---|---|---|
| `BaseUrl` *(required)* | — | e.g. `http://localhost:3001` |
| `UserId` *(required)* | — | memory namespace / access scope |
| `ApiKey` | `null` | bearer token; omit when auth is off |
| `AppName` | `cortadel-dotnet` | app label recorded on searches |
| `Timeout` | 100s | **only applies to the `HttpClient` the constructor creates for you** — a no-op if you pass your own `HttpClient`, since the facade never mutates `BaseAddress`, `Timeout`, or `DefaultRequestHeaders` on a client it doesn't own |

### TypeScript — options object, not positional

```ts
import { CortadelClient } from "@cortadel/sdk";

const cortadel = new CortadelClient({
  baseUrl: "http://localhost:3001",
  userId: "alice",
  apiKey: "<token>",   // omit when auth is disabled
  appName: "my-app",   // recorded on searches
  timeoutMs: 100_000,  // default: 100s
  fetch: myFetch,      // optional — defaults to global fetch, never mutated
});
```

`CortadelOptions`:

| Property | Default | Notes |
|---|---|---|
| `baseUrl` *(required)* | — | |
| `userId` *(required)* | — | |
| `apiKey` | `undefined` | bearer token; omit when auth is off |
| `appName` | `cortadel-typescript` | app label recorded on searches |
| `fetch` | global `fetch` | never mutated — the client wraps the reference in its own request handling, so the same `fetch` (or one already bound to your own defaults) is safe to share across multiple `CortadelClient`s |
| `timeoutMs` | `100_000` | per-request timeout; composed with any `signal` you pass to an individual call — whichever fires first wins. `0` disables it |

### Python — async by default, or a real blocking client

```python
from cortadel import CortadelClient

# as a context manager (recommended)
async with CortadelClient("http://localhost:3001", "alice") as cortadel:
    ...

# or manually
cortadel = CortadelClient(
    "http://localhost:3001", "alice",
    api_key=None,        # omit when auth is disabled
    app_name="my-app",   # recorded on searches
    timeout=100.0,       # seconds; default 100
)
...
await cortadel.aclose()

# bring your own httpx.AsyncClient (e.g. custom proxy/TLS)
import httpx
async with httpx.AsyncClient(proxy="http://proxy.internal:8080") as http_client:
    cortadel = CortadelClient("http://localhost:3001", "alice", http_client=http_client)
```

Need a blocking client instead (e.g. a plain script)? `SyncCortadelClient` exposes the same seven
methods without `async`/`await`:

```python
from cortadel import SyncCortadelClient

with SyncCortadelClient("http://localhost:3001", "alice") as cortadel:
    cortadel.add("Alice prefers dark mode.")
```

Constructor parameters (identical for both clients): `base_url` *(required)*, `user_id`
*(required)*, `api_key` (default `None`), `app_name` (default `cortadel-python`), `http_client`
(bring your own `httpx.AsyncClient`; **never mutated** — the bearer token is attached per-request
rather than on shared headers), `timeout` (default `100.0`s, a no-op if you pass your own
`http_client`).

## Core Methods

All seven methods, per language. Method names differ in casing convention only; the underlying
call and options are the same.

### `add` — Store a Memory

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

```ts
const created = await cortadel.add("Alice prefers dark mode.", {
  app: "my-app",
  metadata: { source: "settings" },
  infer: true,             // false = store verbatim, skip extraction
  memoryType: "semantic",  // episodic | semantic | procedural
});

console.log(created.id, created.event);   // e.g. ADD or SKIP_DUPLICATE
```

```python
from cortadel import AddOptions

created = await cortadel.add(
    "Alice prefers dark mode.",
    AddOptions(app="my-app", metadata={"source": "settings"}, infer=True, memory_type="semantic"),
)
print(created.id, created.event)   # e.g. ADD or SKIP_DUPLICATE
```

Returns `MemoryCreated` (`id`, `content`, `state`, `createdAt`/`created_at`, `event`, `appName`/
`app_name`). Always check `event` — a successful call can still be `SKIP_DUPLICATE`.

### `add_conversation` — Distill a Transcript

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

```ts
const result = await cortadel.addConversation(
  [
    { role: "user", content: "I moved to Berlin.", uuid: "turn-1" },
    { role: "assistant", content: "Noted — Berlin." },
  ],
  { sessionId: "sess-42", tags: ["onboarding"] },
);

console.log(
  result.noFactsExtracted === true
    ? "no facts extracted"
    : `stored ${result.results?.length ?? 0} fact(s)`,
);
```

```python
from cortadel import ChatMessage, ConversationOptions

result = await cortadel.add_conversation(
    [
        ChatMessage(role="user", content="I moved to Berlin.", uuid="turn-1"),
        ChatMessage(role="assistant", content="Noted — Berlin."),
    ],
    ConversationOptions(session_id="sess-42", tags=["onboarding"]),
)
print("no facts extracted" if result.no_facts_extracted else f"stored {len(result.results or [])} fact(s)")
```

Returns `ConversationResult` (`results` / `Results` — nullable list, `noFactsExtracted` /
`NoFactsExtracted` / `no_facts_extracted` — nullable bool). Mutually exclusive on the wire: check
`no_facts_extracted` before assuming `results` is populated.

### `search` — Hybrid Search

Hybrid search (BM25 + vector fused with RRF), with an optional local cross-encoder rerank pass.

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

```ts
const hits = await cortadel.search("what are alice's preferences?", {
  topK: 10,
  mode: "hybrid",          // hybrid | text | vector
  rerank: "cross_encoder", // omit to skip reranking
  sessionId: undefined,
  memoryType: undefined,
});

for (const h of hits.results) console.log(h.rrfScore?.toFixed(2), h.content);
```

```python
from cortadel import SearchOptions

hits = await cortadel.search(
    "what are alice's preferences?",
    SearchOptions(top_k=10, mode="hybrid", rerank="cross_encoder"),  # omit rerank to skip it
)
for h in hits.results:
    print(h.rrf_score, h.content)
```

Returns `SearchResults` (`query`, `results: SearchHit[]`, `total`). `SearchHit` carries `id`,
`content`, `rrfScore`/`rrf_score`, `categories`, `memoryType`/`memory_type`, `tags`, `source`
(`"personal"` or `"global"`, per the TypeScript model comments), plus `isGlobal`/`is_global` and an
`attributes` bag. There is no `tags` parameter on the search request itself — you cannot filter
search by tag on this surface today.

**`SearchOptions` is a strict subset of the wire's `SearchMemoriesRequest`.** All three SDKs expose
only `top_k`/`TopK`/`topK`, `mode`, `session_id`/`SessionId`/`sessionId`,
`rerank`, and `memory_type`/`MemoryType`/`memoryType`. The wire contract also has `expand_query`,
`include_faded`, `include_session_arm`, and `token_budget` (`references/api-reference.md`) — none
of them are reachable through `search()`/`SearchAsync()` in `1.1.0` of any SDK. Call
`POST /api/v1/memories/search` directly if you need one of those four.

### `list` — Browse, Paginated

Newest-first, paginated — a different envelope from `search` (`{items, page, pages, size, total}`
vs. `{query, results, total}`).

```csharp
var page = await cortadel.ListAsync(new ListOptions
{
    Page = 1, Size = 20,
    Categories = "preferences",
    IncludeSuperseded = false,
});
Console.WriteLine($"{page.Total} total, {page.Pages} pages");
```

```ts
const page = await cortadel.list({
  page: 1,
  size: 20,
  categories: "preferences",
  includeSuperseded: false,
});
console.log(page.total, "total,", page.pages, "pages");
```

```python
from cortadel import ListOptions

page = await cortadel.list(ListOptions(page=1, size=20, categories="preferences"))
print(page.total, "total,", page.pages, "pages")
```

The Python SDK's `list()` default `size` is **20**, kept in sync with the .NET/TypeScript SDKs —
the REST contract's own server-side default is 10 when the parameter is omitted entirely
(`Memories_List`'s `size` query parameter defaults to `10` per `spec/openapi.json`); all three SDKs
send an explicit 20 unless you override it, so relying on the wire default only matters if you call
the REST API directly.

**`ListOptions` doesn't expose the wire's `as_of` parameter either.** `Memories_List` accepts an
`as_of` temporal filter for browsing history as of a past date (`references/api-reference.md`), but
none of the three SDKs' `ListOptions` types declare it — like the search gaps above, it's reachable
only via `GET /api/v1/memories` directly.

### `get` — Fetch One Memory

Returns `null`/`None` when the memory doesn't exist. **The content field is `Text`/`.text`, not
`.content`** — `Memories_Get`'s response schema uses a different field name than list/search.

```csharp
var m = await cortadel.GetAsync(id);
if (m is not null) Console.WriteLine(m.Text);
```

```ts
const m = await cortadel.get(id);
if (m) console.log(m.text);
```

```python
m = await cortadel.get(memory_id)
if m is not None:
    print(m.text)
```

### `delete` — Bulk Delete by ID

```csharp
var message = await cortadel.DeleteAsync(new[] { id1, id2 });
```

```ts
const message = await cortadel.delete([id1, id2]);
```

```python
message = await cortadel.delete([id1, id2])
```

Returns a plain confirmation string (`DeleteMemoriesResponse.message` — no structured delete
count).

### `health` — Server Health

```csharp
var health = await cortadel.HealthAsync();
Console.WriteLine(health.Status);   // ok | degraded
```

```ts
const health = await cortadel.health();
console.log(health.status);   // ok | degraded
```

```python
health = await cortadel.health()
print(health.status)   # ok | degraded
```

**None of the three throw/raise on a degraded response.** A degraded server (HTTP 503 with a
`{"status":"degraded",...}` body) is caught and returned like any other value — the exception type
(`CortadelException`/`CortadelError`) is reserved for every *other* non-success response (a
transport failure, an unmapped status code, or an unparseable body).

## Error Handling

### .NET
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
`CortadelException` members: `StatusCode`, `Code` (machine-readable), `Message` (human-readable).

### TypeScript
```ts
import { CortadelError } from "@cortadel/sdk";

try {
  await cortadel.add("");
} catch (err) {
  if (err instanceof CortadelError) {
    console.log(`${err.status} ${err.code}: ${err.message}`);
  } else {
    throw err;
  }
}
```
`CortadelError` members: `status` (`0` when the transport failed before a status was known),
`code`, `message` — a `400` model-validation failure folds the per-field errors into `message`
rather than an opaque generic string. **Cancellation never becomes a `CortadelError`** — an
aborted request (via a passed `AbortSignal`, or `timeoutMs` expiring) propagates its own
`AbortError`/`TimeoutError` untouched.

### Python
```python
from cortadel import CortadelError

try:
    await cortadel.add("")
except CortadelError as err:
    print(err.status, err.code, err.message)
```
`CortadelError` attributes: `status` (`0` on a pre-status transport failure), `code`, `message`.
`asyncio.CancelledError` is a `BaseException`, not caught by the SDK's error handling, so it always
propagates untouched instead of becoming a `CortadelError`.

## Models at a Glance

### .NET
- `MemoryCreated` — `Id`, `Content`, `State`, `CreatedAt`, `Event`, `AppName`.
- `SearchResults` — `Query`, `Results: List<SearchHit>`, `Total`.
- `SearchHit` — `Id`, `Content`, `RrfScore`, `Categories`, `MemoryType`, `Tags`, `Source`, plus an
  `Extra` member (see the caveat below).
- `MemoryList` / `MemoryListItem` — paginated list (`CreatedAt` is Unix seconds).
- `MemoryDetail` — single memory; content field is `Text`, and `Metadata` maps `metadata_`.
- `ConversationResult` — `Results: List<ConversationIngestItem>?`, `NoFactsExtracted`, plus `Raw`
  (see the caveat below).
- `HealthResult` — `Status` (`ok`\|`degraded`), `CheckedAt`, plus `Checks` (see the caveat below).

### TypeScript
- `MemoryCreated` — `id`, `content`, `state`, `createdAt` (ISO 8601 string on this endpoint —
  list/detail return Unix seconds instead), `event`, `appName`.
- `SearchResults` — `query`, `results: SearchHit[]`, `total`.
- `SearchHit` — `id`, `content`, `rrfScore`, `categories`, `memoryType`, `tags`, `source`,
  `isGlobal` (wire name `global` on this schema — see the caveat below), plus `attributes`.
- `MemoryList` / `MemoryListItem` — paginated list (`createdAt` is Unix seconds; `isGlobal`'s wire
  name is `is_global` here, unlike `SearchHit.isGlobal`'s `global`).
- `MemoryDetail` — single memory; content field is `.text`, not `.content`.
- `ConversationResult` — `results: ConversationIngestItem[] | undefined`, `noFactsExtracted`.
- `HealthResult` — `status`, `checkedAt`, `checks` (a loosely-typed `Record<string, unknown>` keyed
  by dependency name — `memgraph`, `embeddings`, `indexes` today).

### Python
- `MemoryCreated` — `id`, `content`, `state`, `created_at` (ISO 8601 string here — list/detail
  return Unix seconds instead), `event`, `app_name`.
- `SearchResults` — `query`, `results: list[SearchHit]`, `total`.
- `SearchHit` — `id`, `content`, `rrf_score`, `categories`, `memory_type`, `tags`, `source`,
  `is_global`, plus `attributes`.
- `MemoryList` / `MemoryListItem` — paginated list (`created_at` is Unix seconds).
- `MemoryDetail` — single memory; content field is `.text`. **`.metadata` is always `None` from
  `CortadelClient`** — see the caveat below.
- `ConversationResult` — `results: list[ConversationIngestItem] | None`, `no_facts_extracted`.
- `HealthResult` — `status`, `checked_at`, `checks` (a loosely-typed dict keyed by dependency name).

## Caveats — Read Before Relying on Any of These

These are real gaps in the current `1.1.0` surface, not hypothetical edge cases. Cite them rather
than assuming forward compatibility:

- **Python — `MemoryDetail.metadata` / `MemoryListItem.metadata` are always `None`.** The wire's
  `metadata_` field has no declared type in the OpenAPI schema (it's `{"nullable": true}` with no
  `type`), and Kiota's Python generator drops properties with no declared type rather than falling
  back to an untyped node the way the .NET/TypeScript generators do. This is a known generator gap,
  not a mapping bug — the .NET and TypeScript SDKs *do* surface this field correctly.
- **.NET — `SearchHit.Extra`, `ConversationResult.Raw`, and `HealthResult.Extra` are always
  `null`** from `CortadelClient`, even though the DTOs declare `[JsonExtensionData]` bags that
  work as documented if you deserialize the DTOs directly with `System.Text.Json`, bypassing
  `CortadelClient`. Every value `CortadelClient` itself returns goes through a Kiota-generated type
  first (`HybridSearchResult`, `ConversationIngestResponse`, `HealthResponse`), none of which
  implement Kiota's `IAdditionalDataHolder`, and only *then* gets mapped into the DTO — so from
  `CortadelClient`, all three extension-data members read as `null`, always.
- **.NET — `HealthResult.Checks` silently drops undeclared check keys/fields.** One level deeper
  than the `Extra` gap above: the OpenAPI contract marks the checks map (and each individual check)
  `additionalProperties: false`, so the Kiota-generated types the pipeline deserializes through
  drop an undeclared dependency check, or an undeclared field on a known check, before that data
  ever reaches `Checks`. `Checks` itself is a plain `Dictionary<string, JsonElement>` with no such
  restriction — deserializing `HealthResult` directly with `System.Text.Json` *does* preserve
  arbitrary keys there. None of these four .NET members were removed (the public surface is
  frozen); they just don't carry a field the SDK doesn't already know about when the value came
  from `CortadelClient`.
- **TypeScript — `isGlobal`'s wire name is inconsistent across schemas.** `SearchHit.isGlobal`
  reads from the wire field `global`; `MemoryListItem.isGlobal` and `MemoryDetail.isGlobal` both
  read from `is_global`. The TypeScript facade normalizes all three to the same `isGlobal` property
  name — but if you're cross-referencing a raw REST response body directly, both spellings are real
  and both present on the wire, depending which endpoint you called.
- **No `detail=summary|headline` search tier on any SDK.** `SearchOptions`/search request has no
  `detail` field in any of the three SDKs or in `spec/openapi.json` itself — `HybridSearchResult`
  exposes one text field (`content`), full length, always.

## Thread-Safety & Lifetime

- **.NET**: `CortadelClient` is safe to share across threads. Create one per base URL + user and
  keep it for the app's lifetime. Call `Dispose()` only if the client created its own `HttpClient`
  (i.e. you didn't pass one in).
- **TypeScript**: `CortadelClient` is a plain class with nothing to dispose — it holds no
  connection of its own (each call builds a lightweight per-request adapter over whatever `fetch`
  you configured), so sharing one instance across concurrent calls is safe.
- **Python**: `SyncCortadelClient` is a *real* blocking client, not `asyncio.run(...)` called once
  per method — a single dedicated background thread runs one persistent event loop for the
  client's entire lifetime, so keep-alive connections are reused across calls exactly like the
  async client. `close()` (or exiting the `with` block) closes the client on its own loop first,
  then stops the loop and joins the background thread.

## Supported Surface (SemVer Boundary)

- **.NET**: only `CortadelClient` and the types declared directly in the `Cortadel.Sdk` namespace
  are covered by SemVer. `Cortadel.Sdk.Generated` is Kiota-generated transport, generated
  `internal` (`--type-access-modifier Internal`) — not visible outside the assembly, and
  unversioned regardless of release type.
- **TypeScript**: only `CortadelClient` and the types exported from the package root
  (`@cortadel/sdk`, i.e. `src/index.ts`) are covered by SemVer. The generated Kiota transport isn't
  reachable at all — `package.json`'s `exports` map declares only `"."`, so importing a generated
  subpath is a hard `ERR_PACKAGE_PATH_NOT_EXPORTED` at module-resolution time.
- **Python**: only `CortadelClient`, `SyncCortadelClient`, and the types exported from
  `cortadel/__init__.py` are covered by SemVer. `cortadel._generated` is unversioned Kiota-generated
  transport and can change shape (including type removals/renames) across any release, including
  patch releases.
