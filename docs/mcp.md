# MCP integration

Cortadel exposes a **Model Context Protocol** endpoint, so any MCP-capable client (Claude Desktop,
Cursor, your own agent) can read and write memory with **no glue code**.

## Endpoint

A single Streamable-HTTP endpoint — there is **no `/sse` segment**:

```
http://<host>:3001/mcp/{clientName}/{userId}
```

- `{clientName}` — a label for the calling app; it becomes the memory's **app name**.
- `{userId}` — the memory namespace. It must match the user your API key was minted for.

Example:

```
http://localhost:3001/mcp/claude/alice
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

```json
{
  "mcpServers": {
    "cortadel": {
      "url": "http://localhost:3001/mcp/claude/alice",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Once connected, the agent can call `search_memory` before answering and `add_memories` after — giving
it durable recall across sessions.

## Claude Code plugin

For Claude Code specifically, this repo ships a zero-dependency hooks plugin (`cortadel-memory`)
that auto-recalls on each prompt, bootstraps context at session start, and auto-captures at the
end of a turn:

```
claude --plugin-dir <repo>/clients/claude-code-plugin
```

Configure it with `CORTADEL_URL`, `CORTADEL_API_KEY`, and `CORTADEL_USER_ID` — full setup, all
environment variables, and troubleshooting are in the plugin's own
[`clients/claude-code-plugin/README.md`](https://github.com/cortadel/cortadel/tree/main/clients/claude-code-plugin).
