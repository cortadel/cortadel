# TypeScript SDK reference

`@cortadel/sdk` is a thin, typed client over the Cortadel REST API. ESM-only, targets **Node ≥ 20**.

```bash
npm install @cortadel/sdk
```

## Construct a client

Reuse a single `CortadelClient`. Every call is scoped to the `userId` you pass in.

```ts
import { CortadelClient } from "@cortadel/sdk";

const cortadel = new CortadelClient({
  baseUrl: "http://localhost:3001",
  userId: "alice",
  apiKey: "<token>",          // omit when auth is disabled
  appName: "my-app",          // recorded on searches
  timeoutMs: 100_000,         // default: 100s
  fetch: myFetch,             // optional — defaults to the global fetch, never mutated
});
```

`CortadelOptions`

| Property | Default | Notes |
|---|---|---|
| `baseUrl` *(required)* | — | e.g. `http://localhost:3001` |
| `userId` *(required)* | — | memory namespace / access scope |
| `apiKey` | `undefined` | bearer token; omit when auth is off |
| `appName` | `cortadel-typescript` | app label on searches |
| `fetch` | global `fetch` | never mutated — the client wraps this reference in its own request handling instead of attaching headers or state to it, so the same `fetch` (or one already bound to your own defaults) can safely be shared across multiple `CortadelClient`s or other callers |
| `timeoutMs` | 100 000 (100s) | per-request timeout; composed with any `signal` you pass to an individual call — whichever fires first wins. Set to `0` to disable |

## Methods

### `add(text, AddOptions?)` → `MemoryCreated`

Store a memory. The server extracts entities/categories in the background and runs dedup.

```ts
const created = await cortadel.add("Alice prefers dark mode.", {
  app: "my-app",
  metadata: { source: "settings" },
  infer: true,             // false = store verbatim, skip extraction
  memoryType: "semantic",  // episodic | semantic | procedural
});

console.log(created.id, created.event);   // e.g. ADD or SKIP_DUPLICATE
```

### `addConversation(messages, ConversationOptions?)` → `ConversationResult`

Distill atomic facts from a transcript.

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

### `search(query, SearchOptions?)` → `SearchResults`

Hybrid search (BM25 + vector fused with RRF).

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

### `list(ListOptions?)` → `MemoryList`

Paginated, newest-first.

```ts
const page = await cortadel.list({
  page: 1,
  size: 20,
  categories: "preferences",
  includeSuperseded: false,
});
console.log(page.total, "total,", page.pages, "pages");
```

### `get(id)` → `MemoryDetail | null`

Returns `null` when the memory doesn't exist. The content field is `.text`.

```ts
const m = await cortadel.get(id);
if (m) console.log(m.text);
```

### `delete(ids)` → `string`

```ts
const message = await cortadel.delete([id1, id2]);
```

### `health()` → `HealthResult`

```ts
const health = await cortadel.health();
console.log(health.status);   // ok | degraded
```

`health()` does **not** throw when the server reports itself degraded (HTTP 503 with a
`{"status":"degraded",...}` body) — it catches that response and returns it like any other, so a
degraded server is a normal return value, not an exception. `CortadelError` is still thrown for
every other non-success response (a transport failure, an unmapped status code, or a body the
generated client can't parse).

## Error handling

Any non-success response — **other than a degraded (503) health check, which `health()` returns
instead of throwing (see above)** — rejects with a `CortadelError`:

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

| Member | Meaning |
|---|---|
| `status` | HTTP status. `0` when the transport failed before a status was known |
| `code` | machine-readable error code |
| `message` | human-readable message — a `400` model-validation failure folds the per-field errors in, rather than the shipped-SDK's original opaque "An error occurred" |

Cancellation is never turned into a `CortadelError`: an aborted request (via an `AbortSignal` you
pass to a call, or the client's own `timeoutMs` expiring) propagates its `AbortError`/`TimeoutError`
untouched.

## Models at a glance

- `MemoryCreated` — `id`, `content`, `state`, `createdAt` (ISO 8601 string on this endpoint —
  list/detail return Unix seconds instead), `event`, `appName`.
- `SearchResults` — `query`, `results: SearchHit[]`, `total`.
- `SearchHit` — `id`, `content`, `rrfScore`, `categories`, `memoryType`, `tags`, `source`,
  `isGlobal` (wire name `global` on this schema — see the caveat below), plus `attributes`.
- `MemoryList` / `MemoryListItem` — paginated list (`createdAt` is Unix seconds; `isGlobal`'s wire
  name is `is_global` here, unlike `SearchHit.isGlobal`'s `global`).
- `MemoryDetail` — single memory; note the content field is `.text`, not `.content`.
- `ConversationResult` — `results: ConversationIngestItem[] | undefined`, `noFactsExtracted`. The
  two are mutually exclusive on the wire: the server sends `results` when it distilled facts,
  `noFactsExtracted: true` when it didn't, never both.
- `HealthResult` — `status` (`ok` | `degraded`), `checkedAt`, `checks` (a loosely-typed
  `Record<string, unknown>` keyed by dependency name — `memgraph`, `embeddings`, `indexes` today).

**`isGlobal`'s wire name is not consistent across schemas** — the single trap this SDK's conformance
suite exists to catch by name. `SearchHit.isGlobal` reads from the wire field `global`;
`MemoryListItem.isGlobal` and `MemoryDetail.isGlobal` both read from `is_global`. The facade
normalizes all three to the same `isGlobal` property name so you never have to remember which
schema uses which — but if you're cross-referencing the raw REST response body directly, the two
spellings are real and both present on the wire.

## Package layout & lifetime

`CortadelClient` is a plain class — construct one per base URL + user and keep it for your app's
lifetime; there's nothing to dispose. It holds no connection of its own (each call builds a
lightweight per-request adapter over whatever `fetch` you configured), so sharing one instance
across concurrent calls is safe.

## Supported surface

Only `CortadelClient` and the types exported from the package root (`@cortadel/sdk`, i.e.
`src/index.ts`) are covered by SemVer. The generated Kiota transport is not reachable from the
package at all: `package.json`'s `exports` map declares only `"."`, so
`import "@cortadel/sdk/dist/generated/..."` is a hard `ERR_PACKAGE_PATH_NOT_EXPORTED` at the
module-resolution level, not just an unsupported convention. It's unversioned regardless: expect it
to change shape (including type removals/renames) across any release, including patch releases.
