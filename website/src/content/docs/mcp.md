---
title: MCP integration
description: Connect Claude, Cursor, or any MCP client to Cortadel with no glue code.
---

Cortadel exposes a **Model Context Protocol** endpoint, so any MCP-capable client (Claude Desktop,
Cursor, your own agent) can read and write memory with **no glue code**.

## Endpoint

A single Streamable-HTTP endpoint — there is **no `/sse` segment**:

```
<base_url>/mcp/{clientName}
```

- `{clientName}` — a label for the calling app; it becomes the memory's **app name**. It is the
  only path segment: the endpoint carries no user id, because the server resolves identity from
  the API key.

`<base_url>` is either of two things — the rest of this page (and the MCP shape itself) is
identical either way:

- **Hosted** — `https://app.cortadel.ai`, the live Cortadel service. Get an API key from its
  dashboard.
- **Self-hosted** — your own server's origin, e.g. `http://localhost:3001` for a local
  `docker compose up` (see [Self-hosting](/self-hosting/)).

Example (self-hosted):

```
http://localhost:3001/mcp/claude
```

Example (hosted):

```
https://app.cortadel.ai/mcp/claude
```

## Authentication

Same credentials as REST (see [Authentication](/authentication/)). Pass the key via the
`Authorization: Bearer <token>` header, the `API_KEY` header, or `?api_key=<token>`. The key alone
determines which user's memories the connection sees — there is no user id in the URL to disagree
with it. When auth is disabled, no credentials are needed.

Optional per-connection scoping: send a `Project` header to scope a connection to a project.

## Tools

**Exactly two tools.** Six earlier tools were folded into them on 2026-08-21; their capabilities
did not go away, they moved.

| Tool | What it does |
|---|---|
| `add_memories` | Store one or more memories (intent-aware: remember / forget / resolve). Every item in the `memories` array is auto-classified — plain text, a `"role: content"` conversation turn (distilled into atomic facts), or an image URL / data-URI / base64 (captured asynchronously). Mixed batches compose, and each kind reports its own result section. |
| `search_memory` | Hybrid search (BM25 + vector + RRF, optional rerank), or chronological browse when you omit the query. Procedural queries inline the best-matching learned skill as `primary_skill`; `ids: ["skill:<id>"]` expands one. |

Where the folded tools went:

| Was | Now |
|---|---|
| `add_conversation` | `add_memories` — pass `"role: content"` turns in the array |
| `add_media` | `add_memories` — pass an image URL / data-URI / base64 in the array |
| `get_skill` | `search_memory` — `primary_skill`, or `ids: ["skill:<id>"]` to expand |
| `reconcile_memories` · `reconcile_status` · `list_merge_suggestions` | Not MCP tools. Entity reconciliation is REST only: `POST`/`GET`/`DELETE /api/v1/entities/reconcile`, `GET /api/v1/entities/suggestions`. |

Tools only — the server exposes no MCP resources or prompts.

## Client configuration

### Claude Desktop / Cursor (HTTP MCP)

Self-hosted:

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

Hosted — same shape, just point `url` at `https://app.cortadel.ai` instead:

```json
{
  "mcpServers": {
    "cortadel": {
      "type": "http",
      "url": "https://app.cortadel.ai/mcp/claude",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Once connected, the agent can call `search_memory` before answering and `add_memories` after — giving
it durable recall across sessions.

## Claude Code & Codex plugin

For Claude Code and Codex specifically, this repo ships a packaged plugin (`cortadel-memory`) —
for Claude Code, a zero-dependency hooks plugin that auto-recalls on each prompt, bootstraps
context at session start, and auto-captures at the end of a turn, plus this same MCP server wired
in via inline `mcpServers`; for Codex, the `cortadel` skill only (Codex's plugin format can't
template a configurable base URL or carry an API key — hosted or self-hosted):

```
/plugin marketplace add cortadel/cortadel
/plugin install cortadel-memory@cortadel
```

or, for a trial run with no install: `claude --plugin-dir <repo>/cortadel-plugin`.

Configure it with the `base_url`, `user_id`, `api_key`, and `client_name` values (env var
equivalents: `CORTADEL_URL`, `CORTADEL_USER_ID`, `CORTADEL_API_KEY`, `CORTADEL_CLIENT_NAME`) —
full setup, the data-flow/privacy statement, and troubleshooting are in
[`docs/plugin.md`](/plugin/) and the plugin's own
[`cortadel-plugin/README.md`](https://github.com/cortadel/cortadel/tree/main/cortadel-plugin).
