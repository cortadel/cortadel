---
title: Claude Code & Codex plugin
description: Install the cortadel-memory plugin, the four config values, hook behaviour, and the data-flow/privacy tradeoffs of enabling it.
---

This repo ships a packaged plugin — `cortadel-memory` — under
[`cortadel-plugin/`](https://github.com/cortadel/cortadel/tree/main/cortadel-plugin),
built once from a single metadata source ([`packaging/plugin.metadata.json`](https://github.com/cortadel/cortadel/blob/main/packaging/plugin.metadata.json))
and generated for two hosts:

| Host | What you get |
| --- | --- |
| **Claude Code** | Full: three hooks (push-recall, session bootstrap, auto-capture) + an inline MCP server (`search_memory`, `add_memories`, …) + the `cortadel` skill. |
| **Codex** | Skills only. Codex's plugin format has no user-config templating (no `${user_config.*}` substitution), so it cannot express a configurable base URL or carry your API key — the MCP server and hooks are Claude-Code-only. Wire Codex to the MCP endpoint manually per [MCP integration](/mcp/), using `codex` as the `{clientName}` segment: `<base_url>/mcp/codex`. |

The plugin is **zero-dependency Node** (18+ built-in `fetch`, ESM, no build step) and
**enabled by default** once installed — see [Data flow & privacy](#data-flow--privacy) before you
point it at a server.

## Install

### Claude Code — via marketplace (recommended)

```
/plugin marketplace add cortadel/cortadel
/plugin install cortadel-memory@cortadel
```

This reads the root [`.claude-plugin/marketplace.json`](https://github.com/cortadel/cortadel/blob/main/.claude-plugin/marketplace.json),
which points at `cortadel-plugin`. On install, Claude Code prompts for the four
configuration values below and stores them (the `api_key` value goes to secure storage, since the
option is marked `sensitive`).

### Claude Code — trial run / dev flow, no install

```bash
claude --plugin-dir <repo>/cortadel-plugin
```

This skips the marketplace `userConfig` prompt entirely, so configure via the `CORTADEL_*`
environment variables instead (see [Configuration](#configuration) — every option has both a
`user_config` name and a `CORTADEL_*` env var name).

### Codex — skills only

Codex discovers the same repo at its own marketplace path,
[`.agents/plugins/marketplace.json`](https://github.com/cortadel/cortadel/blob/main/.agents/plugins/marketplace.json),
pointing at the same `cortadel-plugin` directory. Its manifest
(`cortadel-plugin/.codex-plugin/plugin.json`) declares only the `cortadel` skill — no
hooks, no MCP server, no config prompt. Install it the way your Codex client documents installing
a skill-only plugin from a marketplace entry.

## Configuration

Four values, declared once in `packaging/plugin.metadata.json` and generated into both the
Claude Code `userConfig` schema and this table:

| Option | Required | Sensitive | Default | Meaning |
| --- | --- | --- | --- | --- |
| `base_url` | yes | no | `https://app.cortadel.ai` | Base URL of the Cortadel server to use. No trailing slash. |
| `user_id` | yes | no | — | The user id your API key was minted for. Used by the **hooks** in their REST payloads — it is **not** part of the MCP URL, which carries no user segment. It must match the key's user or the server responds 403. |
| `api_key` | yes | yes | — | API key for your user. **Hosted** (`https://app.cortadel.ai`): the dashboard there issues keys. **Self-hosted**: mint one on the server: `dotnet Cortadel.Api.dll mint-key <user>` (in Docker: `docker exec <container> dotnet Cortadel.Api.dll mint-key <user>`). |
| `client_name` | no | no | `claude` | Label for this client. Becomes the sole `{clientName}` path segment of the MCP endpoint (`<base_url>/mcp/{clientName}`, so the default resolves to `<base_url>/mcp/claude`) and the `app_name` the `UserPromptSubmit` hook sends on its *search* requests, which the server uses for access logging only. It is **not** recorded on memories the hooks capture — see [MCP tool naming](#mcp-tool-naming). |

### Hosted vs self-hosted

`base_url` is the only thing that changes between the two — everything else about the plugin
(hooks, MCP tools, `user_id`/`client_name` semantics) is identical either way — only the origin in
front of the same `/mcp/{clientName}` path differs:

- **Hosted** (default) — leave `base_url` at `https://app.cortadel.ai`, the live Cortadel service.
  Get an API key from its dashboard.
- **Self-hosted** — replace `base_url` with your own server's origin, e.g. `http://localhost:3001`
  for a local `docker compose up` (see [Self-hosting](/self-hosting/)), no trailing slash.

### Two ways to set these

- **Installed from the marketplace** — Claude Code resolves `userConfig` and injects each value
  into every hook process as `CLAUDE_PLUGIN_OPTION_<KEY>` (e.g. `CLAUDE_PLUGIN_OPTION_BASE_URL`).
  This tier always wins.
- **`--plugin-dir` / manual** — set the matching `CORTADEL_*` environment variable
  (`CORTADEL_URL`, `CORTADEL_USER_ID`, `CORTADEL_API_KEY`, `CORTADEL_CLIENT_NAME`). Read only when
  the `CLAUDE_PLUGIN_OPTION_*` name is unset, per option — you can mix both (e.g. install from the
  marketplace for `base_url`/`user_id`/`api_key` but still override `client_name` via env var).

`cortadel-plugin/scripts/lib.mjs`'s `cfg()` is the single place this resolution happens;
see that file's `readOption()` for the exact precedence.

Seven more environment-variable-only options exist beyond the four `userConfig` fields above
(`CORTADEL_RECALL_TOPK`, `CORTADEL_RECALL_MIN_SCORE`, `CORTADEL_MIN_PROMPT_CHARS`,
`CORTADEL_RECALL_RERANK`, `CORTADEL_CAPTURE_MAX_CHARS`, `CORTADEL_HOOKS_DISABLE`,
`CORTADEL_HOOKS_LOG`) — see
[`cortadel-plugin/README.md`](https://github.com/cortadel/cortadel/blob/main/cortadel-plugin/README.md#configuration-environment-variables)
for the full table.

## Hook behaviour

| Hook | What it does | Budget |
| --- | --- | --- |
| `UserPromptSubmit` | Push-recall: searches Cortadel with your prompt (hybrid mode) and injects the top hits as context on **every** prompt. | 12 s request budget inside a 15 s hook timeout. |
| `SessionStart` | Bootstrap: injects a short "memory is active" notice plus your most recent memories. | 7 s budget / 10 s timeout. |
| `Stop` | Auto-capture: sends the last user→assistant exchange of the session transcript to `POST /api/v1/memories/from-conversation` for fact extraction. Runs **async** — never blocks the UI. | 110 s budget / 120 s timeout. |

Everything fails open: missing config, server errors, timeouts, or malformed input all exit `0`
with no output. The plugin can slow a prompt down by at most its request budget; it can never
break a Claude Code session.

## Data flow & privacy

**The plugin is enabled by default as soon as it's installed and configured** — there is no
opt-in step beyond installing it. Concretely, once `base_url`/`user_id`/`api_key` are set:

- **Every prompt you type** is sent (first 4000 chars) to your configured `base_url` as a search
  query, on the `UserPromptSubmit` hook.
- **Every final exchange of a session** (the last user + assistant turn) is sent to your
  configured `base_url` for fact extraction, on the `Stop` hook.

Point the plugin only at a `base_url` you trust with that content. The default is the hosted
Cortadel service at `https://app.cortadel.ai`; pointing `base_url` at your own self-hosted instance
instead keeps this content on infrastructure you control. Either way, the plugin itself does not
filter or redact anything before sending it.

### Off switch

Set `CORTADEL_HOOKS_DISABLE=1` (env var, not a `userConfig` option — see
[Configuration](#configuration)) to silence all three hooks without uninstalling the plugin. The
MCP server (if you've also wired it into an agent) is unaffected — only the automatic hooks are
gated by this variable. To stop everything, disable or uninstall the plugin via `/plugin`.

## MCP tool naming

The inline MCP server is named `cortadel` in `mcpServers` (visible as `mcp__cortadel__<tool>` in
tool-use output) and exposes all eight Cortadel MCP tools — `add_memories`, `add_conversation`,
`search_memory`, `get_skill`, `add_media`, `reconcile_memories`, `reconcile_status`,
`list_merge_suggestions`. Its URL is templated from your `userConfig`:

```
${user_config.base_url}/mcp/${user_config.client_name}
```

`client_name` is what the *server* sees as the calling app's name — the `{clientName}` path
segment (see [MCP integration](/mcp/)), and the `app_name` field the `UserPromptSubmit` hook
sends on its search requests, where the spec defines it as "application name for access logging".
It does **not** filter search results, and it is **not** stamped on memories the hooks capture:
the capture endpoint (`POST /api/v1/memories/from-conversation`) has no `app_name` field at all,
so `app_name` on a stored memory reflects whatever wrote it — the MCP server, an SDK, or the
dashboard.

## Troubleshooting

The hooks are deliberately silent on failure, so "nothing happens" is the main failure mode.
Start with the bundled diagnostic, which resolves the same config the hooks use, checks health,
auth, and a live read, and reports every check rather than stopping at the first failure:

```bash
node "<plugin-dir>/scripts/doctor.mjs"     # or run the /doctor skill inside Claude Code
```

It exits 0 when everything passes, 1 otherwise, and never prints your API key. Crucially it reads
the config Claude Code persisted on disk as well as the environment — a marketplace install
resolves **nothing** from the environment of an ordinary shell, because `CLAUDE_PLUGIN_OPTION_*`
is injected into hook *subprocesses* only.

- **401** — missing/invalid API key.
- **403** — the key is valid but `user_id` doesn't match the user the key was minted for.
- **No memories injected** — prompt too short (`CORTADEL_MIN_PROMPT_CHARS`, default 10), a
  slash/`!` command, an empty search result, everything below `CORTADEL_RECALL_MIN_SCORE`, or the
  request exceeded its budget.
- **Stop captures "nothing"** — tool-only or trivial (<80 chars combined) exchanges are skipped;
  `{"no_facts_extracted":true}` from the server is a normal outcome, not an error. Conversations
  *about* tooling, debugging sessions, and facts already in the store all legitimately extract
  nothing — a healthy install can genuinely capture zero facts for a whole session.
- **"Is it even running?"** — set `CORTADEL_HOOKS_LOG` to a file path. Each hook then appends one
  JSON line per invocation recording its outcome (`stored`/`no-facts`/`error`/`skip`, with the
  status code or guard reason), which is the only way to tell "the extractor found nothing" apart
  from "the server said 401" — both are silent otherwise. It records outcomes and counts only,
  never prompt text, memory content, or the key.
- **`claude plugin validate` fails after editing the plugin** — you likely hand-edited a generated
  file. `cortadel-plugin/.claude-plugin/plugin.json`, `cortadel-plugin/.codex-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, and `.agents/plugins/marketplace.json` are all generated by
  `node packaging/generate.mjs` from `packaging/plugin.metadata.json` — edit the source and
  regenerate, never the output.
- **Upgraded and hooks stopped finding a server** — check stderr for a
  `[cortadel-memory] MEMFORGE_* is set, but ...` diagnostic; the plugin's env vars were renamed
  from `MEMFORGE_*` to `CORTADEL_*` with no backward-compatible fallback.

See also [`cortadel-plugin/README.md`](https://github.com/cortadel/cortadel/blob/main/cortadel-plugin/README.md)
for the full environment-variable reference and [MCP integration](/mcp/) for the underlying
endpoint contract.
