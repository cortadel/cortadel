---
name: doctor
description: Diagnose a Cortadel plugin install end to end — config resolution, server health, auth, a live read, and what the hooks themselves last reported. Use when memory doesn't seem to be working (no recall injected, add_memories/search_memory erroring), or right after installing or reconfiguring the plugin. Reports every check rather than stopping at the first failure.
---

# Cortadel Doctor

End-to-end install diagnosis. The checks live in a script rather than in this file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

Run it, then relay its table to the user and interpret any non-PASS row using the
guidance below. It exits 0 when everything passes and 1 otherwise, and it prints no
secret values — only whether each one resolved, and from which source.

**Do not hand-roll these checks with `curl` and `$CORTADEL_*` instead.** That is what
this skill used to do, and it reported healthy installs as broken: the hooks receive
their configuration as `CLAUDE_PLUGIN_OPTION_*` variables injected into the hook
*subprocess*, which are **not** visible in a skill's own shell. A marketplace install
therefore resolves nothing from the environment. `doctor.mjs` checks the environment
tiers *and* the config Claude Code persisted on disk (`pluginConfigs` in
`~/.claude/settings.json`, `pluginSecrets` in `~/.claude/.credentials.json`), and
reports which tier each value came from.

## What each check means

| Check | PASS means | On failure |
| --- | --- | --- |
| Config resolution | `base_url`, `user_id`, and `api_key` all resolved | The plugin is unconfigured and **all three hooks are silent no-ops**. Re-run `/plugin` to set the missing values, or set the `CORTADEL_*` variables for a `--plugin-dir` dev run. |
| Server health | `GET /api/health` returned `status=ok` | `WARN status=degraded` names the failing subsystem (`memgraph`, `embeddings`, `indexes`) — that subsystem, not the plugin, is the problem. A `FAIL` means the URL is wrong or the server is down. |
| Auth | `GET /api/v1/memories` returned 200 | `401` → the API key is missing or invalid. `403` → the key is valid but was minted for a different user than `user_id`. |
| Live read | The list endpoint returned a `total` | This is the only aggregate the server exposes; there is no stats endpoint. |
| Hook outcomes | The opt-in hook log exists and was tallied | `SKIP` just means `CORTADEL_HOOKS_LOG` is unset — see below. |

## When every check passes but memory still "isn't working"

This is the common case, and it is why the hook-outcome log exists. All three hooks
fail open by design: they exit 0 with no output on every failure path, so "the server
said 401", "the extractor found no facts", and "3 facts were stored" are all equally
silent. A green doctor run plus no visible memories usually means the Stop hook is
working exactly as designed and the **extractor is correctly finding no durable facts**
— meta-conversation about tooling, debugging sessions, and content already in the store
all legitimately extract nothing.

To see which it is, turn on the outcome log and reproduce:

```bash
# any path you can read; the hooks append one JSON line per invocation
export CORTADEL_HOOKS_LOG=~/.cortadel-hooks.jsonl
```

Then re-run this skill — the "Hook outcomes" row tallies the last 40 entries, e.g.
`Stop:no-facts×4 UserPromptSubmit:injected×6`. Read them as:

- `stored` — facts were written; the count is in the entry.
- `no-facts` — the server accepted the exchange and extracted nothing. **Healthy.**
- `error` — carries `status` (401/403/5xx) or `error` (`network`, `abort`, `parse`).
- `skip` — the hook bailed before any request; `reason` says which guard fired
  (`no-config`, `hooks-disabled`, `recursion-guard`, `trivial-exchange`,
  `prompt-too-short`, `command-prompt`, `no-assistant-text`, `transcript-unreadable`, …).

The log records outcomes and counts only — never prompt text, memory content, or the
API key.

## Second opinion via MCP

If the `cortadel` MCP server is connected in this session, also call
`search_memory({ topK: 1 })` with no query (browse mode) as an independent live-read
path. Report it separately: REST passing while MCP fails (or the reverse) narrows the
fault to one half of the install. Skip this — don't fail it — when the tool isn't
available.
