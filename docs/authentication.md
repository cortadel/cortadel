# Authentication

## Default: open

Out of the box the server runs with **auth disabled** — an empty auth secret leaves every REST and
MCP endpoint open. That's convenient for local development and trusted networks. **Do not expose an
open instance to the internet.**

## Turn on API keys

Set an auth secret on the server (see [Self-hosting](self-hosting.md) for where env vars go):

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

A key is bound to a **userId**. Memories are namespaced per user, and the server rejects requests
whose `user_id` doesn't match the key's user. Always construct the client with the same `userId`
the key was minted for. The MCP endpoint carries no user segment at all — it resolves identity
from the Bearer key alone.

## Health is always open

`GET /api/health` is unauthenticated by design so orchestrators can probe it. It never returns
memory content.

## MCP

The MCP endpoint uses the same credentials. See [MCP integration](mcp.md#authentication).
