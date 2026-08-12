# cortadel-memory — Claude Code plugin

Ambient [Cortadel](../../README.md) memory for Claude Code. Three hooks, zero dependencies
(Node 18+ built-in `fetch`, ESM, no build step), Windows-safe (exec-form hooks, no shell):

| Hook | What it does | Latency |
| --- | --- | --- |
| `UserPromptSubmit` | Push-recall: searches Cortadel with your prompt (hybrid mode) and injects the top hits as context on **every** prompt. | 12 s request budget inside a 15 s hook timeout. Raw RRF is ~1 s p50; see the rerank note below. |
| `SessionStart` | Bootstrap: injects a short "memory is active" notice plus your most recent memories. | 7 s budget / 10 s timeout. |
| `Stop` | Auto-capture: sends the last user→assistant exchange of the session transcript to `POST /api/v1/memories/from-conversation` for fact extraction. Runs **async** — it never blocks the UI. | 110 s budget / 120 s timeout (extraction is synchronous server-side). |

**Everything fails open.** Missing config, server errors, timeouts, malformed
input — every failure path exits 0 with no output. The plugin can slow a prompt
down by at most its request budget, but it can never break a Claude Code session.

## Install

Trial run (no install):

```
claude --plugin-dir <repo>/clients/claude-code-plugin
```

Project scope: add this directory as a local plugin for your team via the
`/plugin` command (add the repo as a marketplace, then install
`cortadel-memory`), or point `--plugin-dir` at a checkout in your shell profile.
See the [Claude Code plugin docs](https://docs.anthropic.com/en/docs/claude-code/plugins)
for marketplace setup.

## Configuration (environment variables)

Required — if **any** of the three is missing, all hooks are silent no-ops:

| Variable | Meaning |
| --- | --- |
| `CORTADEL_URL` | Base URL of your Cortadel server, e.g. `https://cortadel.example.com` |
| `CORTADEL_API_KEY` | API key for your user. Mint one on the server: `dotnet Cortadel.Api.dll mint-key <user>` (in Docker: `docker exec <container> dotnet Cortadel.Api.dll mint-key <user>`) |
| `CORTADEL_USER_ID` | The user id the key was minted for — must match, or the server returns 403 |

Optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CORTADEL_RECALL_TOPK` | `3` | Memories injected per prompt |
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
working after an upgrade, check stderr for this message and rename your env vars.

## Privacy

`UserPromptSubmit` sends **every prompt you type** (first 4000 chars) to your
Cortadel server as a search query, and `Stop` sends the final exchange of each
session for fact extraction. Point the plugin only at a server you trust with
that content. To pause everything, set `CORTADEL_HOOKS_DISABLE=1`.

## Troubleshooting

Hooks are deliberately silent, so "nothing happens" is the failure symptom.
Check with `curl`:

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
  normal outcome, not an error.
- **Everything used to work and now doesn't, right after an upgrade** — check
  stderr for the `[cortadel-memory] MEMFORGE_* is set, but ...` diagnostic
  described above; your env vars likely still use the retired `MEMFORGE_*` names.

## Tests

```
node --test clients/claude-code-plugin/test/
```

(Windows note: some Node builds don't expand a bare directory for `--test`;
use `node --test "clients/claude-code-plugin/test/*.test.mjs"` locally.)
Tests spawn the real hook scripts against an ephemeral `node:http` stub and
assert the wire contract plus every fail-open path.
