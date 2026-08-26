---
title: Authentication
description: Turn on API keys and scope memories per user.
---

## Default: open

Out of the box the server runs with **auth disabled** — an empty auth secret leaves every REST and
MCP endpoint open. That's convenient for local development and trusted networks. **Do not expose an
open instance to the internet.**

## Turn on API keys

Set an auth secret on the server (see [Self-hosting](/self-hosting/) for where env vars go):

```bash
MEMFORGE_Auth__Secret=<a-long-random-string>
```

Then mint a key for a user with the bundled CLI inside the container:

```bash
docker exec -it <container> dotnet Cortadel.Api.dll mint-key alice
# prints a bearer token bound to userId "alice"
```

## Send the key

The SDK sends the key as a bearer token — just pass it to the constructor:

```csharp
using var cortadel = new CortadelClient(
    "http://localhost:3001", userId: "alice", apiKey: "<token>");
```

Over raw HTTP, any of these work:

```http
Authorization: Bearer <token>
API_KEY: <token>
```

```
GET /api/v1/memories?user_id=alice&api_key=<token>
```

## User scoping

A key is bound to a **userId**, and memories are namespaced per user. When auth is enabled the
server — not the client — is authoritative over identity, and it enforces that in two different
ways depending on where the id appears:

| Where `user_id` appears | Which operations | If it disagrees with the key |
| --- | --- | --- |
| **Query string** (`?user_id=`) | list, get | **403 Forbidden** — rejected outright. |
| **Request body** (`{"user_id": …}`) | create, search, delete, conversation ingest | **Silently overwritten** with the key's user. The call succeeds, operating on *your* data — not the id you asked for. |

Either way you cannot reach another user's memories. The asymmetry matters only for debugging: a
body mismatch does not announce itself, so a client that passes the wrong `user_id` looks like it
is working.

`user_id` is still **required on the wire** — omit it and the server answers `400 The UserId field
is required`, because model validation runs before the identity filter. Always construct the client
with the same `userId` the key was minted for.

When auth is **disabled** (the default — an empty `Auth:Secret`) none of this applies: there is no
key, nothing is overwritten, and `user_id` is the only thing selecting a namespace.

The MCP endpoint carries no user segment at all — it resolves identity from the Bearer key alone.

## Health is always open

`GET /api/health` is unauthenticated by design so orchestrators can probe it. It never returns
memory content.

## MCP

The MCP endpoint uses the same credentials. See [MCP integration](/mcp/#authentication).
