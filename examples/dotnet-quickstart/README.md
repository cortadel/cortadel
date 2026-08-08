# .NET quickstart

A minimal console app that stores memories, ingests a conversation, and searches — using
[`Cortadel.Sdk`](../../sdk/dotnet/Cortadel.Sdk).

## Run

Start a Cortadel server first (see [Self-hosting](../../docs/self-hosting.md)), then:

```bash
cd examples/dotnet-quickstart
dotnet run
```

Configure via environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `CORTADEL_URL` | `http://localhost:3001` | server base URL |
| `CORTADEL_USER` | `demo-user` | user id / memory scope |
| `CORTADEL_API_KEY` | — | bearer token, if auth is enabled |

This example uses a local `ProjectReference` to the SDK. In your own app, install the package
instead:

```bash
dotnet add package Cortadel.Sdk
```
