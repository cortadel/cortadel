# @cortadel/sdk

Official TypeScript SDK for [**Cortadel**](https://github.com/cortadel/cortadel) — self-hosted
long-term temporal graph memory for AI agents. A thin, typed client over the Cortadel REST API.

```bash
npm install @cortadel/sdk
# or: pnpm add @cortadel/sdk / yarn add @cortadel/sdk
```

ESM-only, Node ≥ 20.

## Quickstart

```ts
import { CortadelClient } from "@cortadel/sdk";

const cortadel = new CortadelClient({
  baseUrl: "http://localhost:3001",
  apiKey: "<token>",     // omit when the server runs with auth disabled
  // userId: "alice",    // optional — see "Identity" below
});

// Store
await cortadel.add("Alice prefers dark mode and ships on Fridays.");

// Recall (hybrid BM25 + vector + RRF)
const hits = await cortadel.search("what are alice's preferences?", { topK: 5 });
for (const h of hits.results) console.log(h.rrfScore, h.content);

// Ingest a conversation
await cortadel.addConversation([
  { role: "user", content: "I'm allergic to peanuts." },
  { role: "assistant", content: "Noted — I'll avoid peanut recipes." },
]);

// List / get / delete
const page = await cortadel.list({ page: 1, size: 20 });
const one = await cortadel.get(page.items[0].id);
await cortadel.delete([page.items[0].id]);
```

## Auth

Pass `apiKey` in the constructor options and every request carries `Authorization: Bearer <key>`.
Omit it (or leave it `undefined`) when the server runs with auth disabled — no header is sent, and
the client never mutates a `fetch` you bring in either way.

```ts
const cortadel = new CortadelClient({
  baseUrl: "https://my-box:3001",
  apiKey: process.env.CORTADEL_API_KEY,
});
```

## Identity (`userId`)

`userId` is **optional**.

| | What goes on the wire | When to use it |
|---|---|---|
| **Omitted** | No `user_id` at all — no body field, no query parameter. | Auth **enabled**. The API key already names the user; the server resolves identity from it. |
| **Provided** | `user_id` on every request, exactly as in earlier releases. | Auth **disabled** — required in practice, since with no key there is nothing else selecting a namespace. Also fine with auth enabled. |

Passing `userId` explicitly blank (`""` or whitespace) throws. *Omitting* it does not — that is the
supported way to say "let the server decide."

```ts
// Auth enabled: the key is the identity.
const cortadel = new CortadelClient({
  baseUrl: "https://my-box:3001",
  apiKey: process.env.CORTADEL_API_KEY,
});

// Auth disabled: userId is the only namespace anchor, so pass it.
const local = new CortadelClient({ baseUrl: "http://localhost:3001", userId: "alice" });
```

### Server requirement

**Omitting `userId` needs a server that includes commit `30b70ea4`** — the one that fills a missing
`user_id` rather than rejecting it. Against an older server, omitting it comes back as a `400` with
`{"errors":{"UserId":["The UserId field is required."]}}`.

Check what you're pointed at with `GET /api/health`: the `version` field embeds the server's commit
SHA, e.g. `"1.0.0+44be8adfc376d19cf6999a379cc8519331def7e6"`. (Cortadel's `VERSION` file is not
bumped per change, so the leading `1.0.0` says nothing about whether a given commit is in — the SHA
is the part that answers the question.) Passing `userId` explicitly works against every server
version.

`userId` is **not deprecated**. When a key *is* present the server is authoritative: a `user_id` in
a request body is silently rescoped to the key's user, and one in a query string is rejected with a
`403`. So if you pass it alongside a key, pass the id that key was minted for.

Reuse a single `CortadelClient` per base URL (per user, when you scope by `userId`).

## Methods

`CortadelClient` has seven methods, all `async`, all accepting an optional trailing `AbortSignal`:

| Method | Returns | Notes |
|---|---|---|
| `add(text, options?)` | `MemoryCreated` | Store a memory. `options.infer` (default `true`) runs background entity/category extraction; `false` stores verbatim (dedup still applies). |
| `addConversation(messages, options?)` | `ConversationResult` | Distill atomic facts from a transcript and store each one. |
| `search(query, options?)` | `SearchResults` | Hybrid search (BM25 + vector fused with RRF); set `options.rerank = "cross_encoder"` to rerank. |
| `list(options?)` | `MemoryList` | Paginated, newest-first. `options.size` defaults to **20** (a deliberate SDK-wide choice — see below). |
| `get(memoryId)` | `MemoryDetail \| null` | `null` when the memory doesn't exist; never throws for a 404. Content field is `.text`. |
| `delete(memoryIds)` | `string` | Deletes one or more memories; returns the server's confirmation message. |
| `health()` | `HealthResult` | Database + embedding provider reachability. Does **not** throw when the server reports itself `degraded` — a degraded server is a normal return value (`status === "degraded"`), not an exception. |

`ListOptions.size` defaults to **20**, not the REST contract's own default of 10 — kept in sync with
the .NET and Python SDKs so every Cortadel SDK behaves identically regardless of which one you're
reading examples for.

## Errors

Any non-success response — **other than a degraded health check, which `health()` returns instead of
throwing** — rejects with a `CortadelError`:

```ts
import { CortadelClient, CortadelError } from "@cortadel/sdk";

try {
  await cortadel.add("");
} catch (err) {
  if (err instanceof CortadelError) {
    console.error(err.status, err.code, err.message);
  } else {
    throw err; // an aborted request (AbortSignal) propagates its own AbortError/TimeoutError instead
  }
}
```

| Property | Meaning |
|---|---|
| `status` | HTTP status code. `0` when the transport failed before a status was known. |
| `code` | Machine-readable error code (e.g. `not_found`, `validation_error`). |
| `message` | Human-readable message — for a `400` model-validation failure, includes the per-field errors the server returned, not just a generic string. |

Cancellation (your own `AbortSignal` firing, or the client's own per-request timeout expiring) is
never turned into a `CortadelError` — it propagates as the underlying `AbortError`/`TimeoutError` so
you can tell "the server said no" apart from "the request never got an answer."

## Not part of the supported API

Everything under `@cortadel/sdk`'s generated transport (`src/generated` in the source tree) is
Kiota-generated plumbing, not a documented API. It is unreachable from the package on purpose:
`package.json` declares only the `"."` export, so `import "@cortadel/sdk/dist/generated/..."` fails
with `ERR_PACKAGE_PATH_NOT_EXPORTED` at the module-resolution level — there is no supported way to
reach it from outside this package, even by accident. It can change shape (types renamed or removed)
in any release, including a patch release, without that counting as a breaking change. Only
`CortadelClient` and the types re-exported from the package root (this reference) are covered by
SemVer.

Full guide: [TypeScript SDK reference](https://github.com/cortadel/cortadel/blob/main/docs/sdk-typescript.md).

Licensed under **Apache-2.0**. The Cortadel server is a separate commercial product — see
[cortadel.ai](https://cortadel.ai).
