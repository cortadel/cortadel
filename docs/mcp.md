# MCP integration

Cortadel exposes a **Model Context Protocol** endpoint, so any MCP-capable client (Claude Desktop,
Cursor, your own agent) can read and write memory with **no glue code**.

## Endpoint

A single Streamable-HTTP endpoint — there is **no `/sse` segment**:

```
<base_url>/mcp/{clientName}
```

- `{clientName}` — a label for the calling app; it becomes the memory's **app name**.
- `{userId}` — the memory namespace. It must match the user your API key was minted for.

`<base_url>` is either of two things — the rest of this page (and the MCP shape itself) is
identical either way:

- **Hosted** — `https://app.cortadel.ai`, the live Cortadel service. Get an API key from its
  dashboard.
- **Self-hosted** — your own server's origin, e.g. `http://localhost:3001` for a local
  `docker compose up` (see [Self-hosting](self-hosting.md)).

Example (self-hosted):

```
http://localhost:3001/mcp/claude
```

Example (hosted):

```
https://app.cortadel.ai/mcp/claude
```

## Authentication

Same credentials as REST (see [Authentication](authentication.md)). Pass the key via the
`Authorization: Bearer <token>` header, the `API_KEY` header, or `?api_key=<token>`. If the
`{userId}` in the path doesn't match the key's user, the server returns 403. When auth is disabled,
no credentials are needed.

Optional per-connection scoping: send a `Project` header to scope a connection to a project.

## Tools

| Tool | What it does |
|---|---|
| `add_memories` | Store one or more memories (intent-aware: remember / forget / resolve). |
| `add_conversation` | Distill atomic facts from a transcript and store them. |
| `search_memory` | Hybrid search (BM25 + vector + RRF, optional rerank). |
| `get_skill` | Retrieve a learned procedural skill. |
| `add_media` | Ingest an image/document (multimodal). |
| `reconcile_memories` | Kick off entity reconciliation (merge/supersede duplicates). |
| `reconcile_status` | Poll a running reconciliation. |
| `list_merge_suggestions` | Review pending duplicate-entity suggestions. |

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
template this configurable, per-user MCP URL — hosted or self-hosted):

```
/plugin marketplace add cortadel/cortadel
/plugin install cortadel-memory@cortadel
```

or, for a trial run with no install: `claude --plugin-dir <repo>/cortadel-plugin`.

Configure it with the `base_url`, `user_id`, `api_key`, and `client_name` values (env var
equivalents: `CORTADEL_URL`, `CORTADEL_USER_ID`, `CORTADEL_API_KEY`, `CORTADEL_CLIENT_NAME`) —
full setup, the data-flow/privacy statement, and troubleshooting are in
[`docs/plugin.md`](plugin.md) and the plugin's own
[`cortadel-plugin/README.md`](https://github.com/cortadel/cortadel/tree/main/cortadel-plugin).
