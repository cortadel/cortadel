# cortadel-memory — Claude Code & Codex plugin

Ambient [Cortadel](../../README.md) memory, packaged once and generated for two hosts from a
single metadata source ([`packaging/plugin.metadata.json`](../../packaging/plugin.metadata.json)
+ [`packaging/generate.mjs`](../../packaging/generate.mjs)):

| Host | What's included |
| --- | --- |
| **Claude Code** | Three hooks + an inline MCP server (`mcpServers.cortadel`) + the `cortadel` skill. Zero dependencies (Node 18+ built-in `fetch`, ESM, no build step), Windows-safe (exec-form hooks, no shell). |
| **Codex** | Skills only (`skills/cortadel`). Codex's plugin format has no user-config templating (no `${user_config.*}` substitution), so it cannot express a configurable base URL or carry an API key — see `.codex-plugin/plugin.json`. |

**The plugin is enabled by default as soon as it's installed and configured** — see
[Privacy](#privacy) before pointing it at a server. Full walkthrough, troubleshooting, and the
data-flow statement: [`docs/plugin.md`](../../docs/plugin.md).

## Hooks (Claude Code)

| Hook | What it does | Latency |
| --- | --- | --- |
| `UserPromptSubmit` | Push-recall: searches Cortadel with your prompt (hybrid mode) and injects the top hits as context on **every** prompt. | 12 s request budget inside a 15 s hook timeout. Raw RRF is ~1 s p50; see the rerank note below. |
| `SessionStart` | Bootstrap: injects a short "memory is active" notice plus your most recent memories. | 7 s budget / 10 s timeout. |
| `Stop` | Auto-capture: sends the last user→assistant exchange of the session transcript to `POST /api/v1/memories/from-conversation` for fact extraction. Runs **async** — it never blocks the UI. | 110 s budget / 120 s timeout (extraction is synchronous server-side). |

**Everything fails open.** Missing config, server errors, timeouts, malformed
input — every failure path exits 0 with no output. The plugin can slow a prompt
down by at most its request budget, but it can never break a Claude Code session.

Failing open is also blinding: on its own it makes "stored 3 facts", "the extractor found
nothing", and "the server said 401" produce the identical observable — silence. Set
`CORTADEL_HOOKS_LOG` to tell them apart, and run [`scripts/doctor.mjs`](#diagnostics) to check the
install end to end.

## Install

### Via marketplace (recommended)

```
/plugin marketplace add cortadel/cortadel
/plugin install cortadel-memory@cortadel
```

Reads the repo-root [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)
(Codex: [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json)), which
points at this directory. Claude Code prompts for the four `userConfig` values below on install.

### Trial run (no install)

```
claude --plugin-dir <repo>/cortadel-plugin
```

This skips the marketplace `userConfig` prompt, so configure via the `CORTADEL_*` environment
variables below instead. See the
[Claude Code plugin docs](https://docs.anthropic.com/en/docs/claude-code/plugins) for marketplace
setup.

## Configuration

Four `userConfig` options (declared once in
[`packaging/plugin.metadata.json`](../../packaging/plugin.metadata.json)), each readable two
ways — `CLAUDE_PLUGIN_OPTION_<KEY>` (Claude Code, once installed from the marketplace) always
wins over the matching `CORTADEL_*` environment variable (the `--plugin-dir` dev flow or any
manual run). Missing **any** of the first three leaves all hooks silent no-ops:

| `userConfig` key | `CLAUDE_PLUGIN_OPTION_*` | `CORTADEL_*` fallback | Required | Meaning |
| --- | --- | --- | --- | --- |
| `base_url` | `CLAUDE_PLUGIN_OPTION_BASE_URL` | `CORTADEL_URL` | yes | Base URL the **hooks** use for REST. Defaults to the hosted service, `https://app.cortadel.ai`; point it at your own origin (e.g. `http://localhost:3001`) to self-host. No trailing slash. The inline MCP server is pinned to `https://app.cortadel.ai/mcp/claude` and does not follow this — Claude Desktop and claude.ai copy the MCP url verbatim without substituting plugin options, so it cannot be templated. Self-hosting means adding your own MCP server too; `doctor` warns when the two disagree. |
| `user_id` | `CLAUDE_PLUGIN_OPTION_USER_ID` | `CORTADEL_USER_ID` | yes | The user id the key was minted for. Used in the hooks' REST payloads only; the MCP URL has no user segment. Set it to the key's user — the server overrides a mismatch either way (403 on a query-string id, a silent rescope in a request body), so a wrong value fails quietly. |
| `api_key` | `CLAUDE_PLUGIN_OPTION_API_KEY` | `CORTADEL_API_KEY` | yes | API key for your user. **Hosted**: the `https://app.cortadel.ai` dashboard issues keys. **Self-hosted**: mint one on the server: `dotnet Cortadel.Api.dll mint-key <user>` (in Docker: `docker exec <container> dotnet Cortadel.Api.dll mint-key <user>`). |
| `client_name` | `CLAUDE_PLUGIN_OPTION_CLIENT_NAME` | `CORTADEL_CLIENT_NAME` | no (default `claude`) | The sole MCP `{clientName}` path segment, and the `app_name` `UserPromptSubmit` sends on *search* requests — which the spec defines as "application name for access logging". It does **not** filter results, and it is **not** stamped on captured memories: `AddConversationRequest` has no `app_name` field. |

`scripts/lib.mjs`'s `cfg()`/`readOption()` implements this precedence.

Seven more environment-variable-only options (not `userConfig` — set via `CORTADEL_*` regardless
of install method):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CORTADEL_RECALL_TOPK` | `3` | Memories injected per prompt |
| `CORTADEL_RECALL_MIN_SCORE` | `0` (no floor) | Drop injected memories scoring below this. Search always returns its top *k* however weak the match, so at the default a prompt with nothing relevant still gets the *k* least-irrelevant memories injected every turn. RRF scores run roughly 0.3–0.8; `0.4` is a reasonable first try. Unscored results are never dropped. |
| `CORTADEL_HOOKS_LOG` | unset | Path to a file each hook appends one JSON line to per invocation, recording its outcome (`stored`/`no-facts`/`injected`/`error`/`skip`) plus the status code or guard reason. **The only way to tell a healthy install from a broken one** — see [Diagnostics](#diagnostics). Records outcomes and counts only: never prompt text, memory content, or the API key. |
| `CORTADEL_MIN_PROMPT_CHARS` | `10` | Prompts shorter than this are skipped (also skipped: `/` slash commands and `!` shell prompts) |
| `CORTADEL_RECALL_RERANK` | unset | **Only set this (`cross_encoder`) on deployments with the GPU rerank endpoint** (`MEMFORGE_Rerank__HttpEndpoint`, a server-side setting). Unset = raw RRF, ~1 s p50. CPU cross-encoder rerank takes 6–10 s and must never run on the prompt path. |
| `CORTADEL_CAPTURE_MAX_CHARS` | `16000` | Char cap for the captured exchange (user side capped at 4000 of it) |
| `CORTADEL_HOOKS_DISABLE` | unset | Set to `1` to disable all three hooks without uninstalling |

### Renamed from MemForge — no fallback

These variables used to be `MEMFORGE_*` (the plugin's former name, `memforge-memory`). The
rename to `CORTADEL_*` is **outright — there is no backward-compatible fallback**: an old
`MEMFORGE_URL` etc. is never read as working configuration.

Because that would otherwise fail *silently* for an existing install (the plugin would just
stop finding a server, with no obvious cause), every config read checks for exactly this case —
the new variable missing while its old counterpart is still set — and writes a diagnostic to
stderr naming **both** variables, e.g.:

```
[cortadel-memory] MEMFORGE_URL is set, but this plugin now reads CORTADEL_URL instead. MEMFORGE_*
environment variables were renamed to CORTADEL_* with no backward-compatible fallback — set
CORTADEL_URL (the value of MEMFORGE_URL is ignored). Treating this as unconfigured until you do.
```

The plugin then behaves exactly as if that variable were unset (falls back to its documented
default, or — for the three required variables — goes fully silent). If your hooks stopped
working after an upgrade, check stderr for this message and rename your env vars. Note this
rename diagnostic only applies to the `CORTADEL_*` tier — `CLAUDE_PLUGIN_OPTION_*` has no legacy
counterpart to detect.

## Skills

`skills/cortadel/` — the Cortadel Agent Skill, shipped once here as the single copy both hosts'
manifests point at (`cortadel-plugin/.claude-plugin/plugin.json`'s default `./skills/`
path and `.codex-plugin/plugin.json`'s explicit `skills` field) — alongside six verb skills
(`remember`, `recall`, `forget`, `history`, `reconcile`, `doctor`).

## Diagnostics

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"   # or the /doctor skill inside Claude Code
```

Resolves config, then checks server health, auth, and a live read — reporting **every** check
rather than stopping at the first failure. Exits 0 if all pass, 1 otherwise. It never prints the
API key.

Unlike the hooks it deliberately does **not** fail open, and unlike a hand-rolled `curl` check it
reads config from disk as well as the environment. That matters more than it sounds: Claude Code
injects `CLAUDE_PLUGIN_OPTION_*` into hook *subprocesses* only, so for a marketplace install an
ordinary shell — including the one a skill runs commands in — resolves **nothing** from the
environment and a naive diagnostic reports a perfectly healthy install as unconfigured. The script
also reads what Claude Code persisted: non-sensitive options in `pluginConfigs`
(`~/.claude/settings.json`) and the key in `pluginSecrets` (`~/.claude/.credentials.json`).

**When every check passes but no memories appear**, that is usually correct behaviour, not a
fault: the Stop hook's server-side extractor legitimately finds no durable facts in
meta-conversation, debugging sessions, or content already stored. Set `CORTADEL_HOOKS_LOG` and
re-run to see which it is — `Stop:no-facts×4` and `Stop:error(401)×4` are the same silence
without it.

## Privacy

**Enabled by default the moment it's configured** — there is no separate opt-in. `UserPromptSubmit`
sends **every prompt you type** (first 4000 chars) to your Cortadel server as a search query, and
`Stop` sends the final exchange of each session for fact extraction. Point the plugin only at a
server you trust with that content. To pause everything, set `CORTADEL_HOOKS_DISABLE=1`. Full
statement: [`docs/plugin.md#data-flow--privacy`](../../docs/plugin.md#data-flow--privacy).

## Troubleshooting

Hooks are deliberately silent, so "nothing happens" is the failure symptom. Run
[`scripts/doctor.mjs`](#diagnostics) first — it answers most of the list below in one shot. The
raw equivalent, if you want to check one thing by hand (note this only works when the
`CORTADEL_*` variables are actually set in your shell, which a marketplace install does *not* do):

```
curl -H "Authorization: Bearer $CORTADEL_API_KEY" "$CORTADEL_URL/api/v1/memories?user_id=$CORTADEL_USER_ID&size=1"
```

- **401** (`{"code":"unauthorized", ...}`) — missing/invalid `CORTADEL_API_KEY`.
- **403** — the key is valid but `CORTADEL_USER_ID` does not match the user the
  key was minted for. Query-string `user_id` must equal the key's user; the
  body `user_id` on writes is stamped server-side.
- **No memories injected** — prompt under `CORTADEL_MIN_PROMPT_CHARS`, a slash/`!`
  command, an empty search result, or the request exceeded its budget (the hook
  aborts and stays silent by design).
- **Stop captures "nothing"** — tool-only or trivial (<80 chars combined)
  exchanges are skipped; `{"no_facts_extracted":true}` from the server is a
  normal outcome, not an error. Conversations *about* tooling, debugging sessions,
  and facts already in the store all legitimately extract nothing, so a healthy
  install can capture zero facts across a whole session. `CORTADEL_HOOKS_LOG`
  distinguishes that from a failing write.
- **Everything used to work and now doesn't, right after an upgrade** — check
  stderr for the `[cortadel-memory] MEMFORGE_* is set, but ...` diagnostic
  described above; your env vars likely still use the retired `MEMFORGE_*` names.
- **`.claude-plugin/plugin.json` (or any of the other three generated manifests) looks wrong** —
  never hand-edit it. It's generated by `node packaging/generate.mjs` from
  `packaging/plugin.metadata.json`; fix the source and regenerate.

## Tests

```
node --test cortadel-plugin/test/
```

(Windows note: some Node builds don't expand a bare directory for `--test`;
use `node --test "cortadel-plugin/test/*.test.mjs"` locally.)
Tests spawn the real hook scripts against an ephemeral `node:http` stub and
assert the wire contract plus every fail-open path. Packaging-level tests (the generator, the
generated manifests, and the metadata↔env-var contract) live in
[`packaging/test/`](../../packaging/test) — run with `node --test packaging/test/`.
