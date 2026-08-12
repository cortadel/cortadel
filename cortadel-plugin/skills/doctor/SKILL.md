---
name: doctor
description: Diagnose a Cortadel plugin install end to end — config resolution, server health, auth, and a live read. Use when memory doesn't seem to be working (no recall injected, add_memories/search_memory erroring), or right after installing or reconfiguring the plugin. Reports every check rather than stopping at the first failure.
---

# Cortadel Doctor

End-to-end install diagnosis. Run every check below and report all of them — do not stop at the
first failure. **Never use `cortadel-plugin/scripts/lib.mjs`'s `api()` helper for any of this**: it
swallows every failure (non-2xx, timeout, network error) into `null`, which is exactly wrong for a
diagnostic whose entire job is telling a 401 apart from zero results. Use raw `curl` (or the MCP
tools directly) so real status codes and error bodies stay visible.

## Execution

### Check 1 — Config resolution

Resolve the same required values the plugin's own hooks resolve (`base_url`, `user_id`,
`api_key`), `CLAUDE_PLUGIN_OPTION_<KEY>` tier first, `CORTADEL_*` env var tier second — this
mirrors `cortadel-plugin/scripts/lib.mjs`'s `cfg()`/`readOption()` precedence:

```bash
for pair in "CLAUDE_PLUGIN_OPTION_BASE_URL:CORTADEL_URL" \
            "CLAUDE_PLUGIN_OPTION_USER_ID:CORTADEL_USER_ID" \
            "CLAUDE_PLUGIN_OPTION_API_KEY:CORTADEL_API_KEY"; do
  opt="${pair%%:*}"; fallback="${pair##*:}"
  val="${!opt:-${!fallback:-}}"
  if [ -n "$val" ]; then echo "$fallback: resolved"; else echo "$fallback: NOT SET"; fi
done
```

PASS if all three resolve to a non-empty value; FAIL — and report the rest of the checks as
"skipped, no config" — if any is empty. Never print the API key's actual value, only whether it
resolved.

**Caveat, stated plainly to the user if relevant**: `CLAUDE_PLUGIN_OPTION_*` is documented as
being injected into hook *subprocesses* specifically. Whether it is also visible inside a skill's
own shell execution is not confirmed by anything in this repo — check both tiers and report which
one actually resolved each value, rather than assuming the marketplace tier is reachable here.

### Check 2 — Server health (unauthenticated)

`GET /api/health` needs no credentials at all — it's the right first network probe, independent of
whether your own API key is valid:

```bash
curl -s "$CORTADEL_URL/api/health"
```

Report the top-level `status` (`ok` or `degraded`) and, if present, the `checks` map (e.g.
`checks.memgraph.ok`, `checks.embeddings.ok`). A `degraded`/503 response is a normal,
non-exceptional outcome to report — not a reason to stop running the remaining checks.

### Check 3 — Auth

```bash
curl -s -o /tmp/cortadel-doctor-auth.json -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $CORTADEL_API_KEY" \
  "$CORTADEL_URL/api/v1/memories?user_id=$CORTADEL_USER_ID&size=1"
```

- `200` → PASS.
- `401` → FAIL — missing or invalid API key.
- `403` → FAIL — the key is valid but doesn't match `user_id`.
- anything else → FAIL — report the status code and response body.

### Check 4 — Live read

If Check 3 returned `200`, read back `/tmp/cortadel-doctor-auth.json`: confirm it parses as JSON
and has an `items` array and a `total` count (`MemoryListPagedResponse`'s shape). Report `total` as
the install's memory count — this is the only aggregate figure the server exposes; there is no
separate stats endpoint, so this is the full extent of "stats" available anywhere.

If the `cortadel` MCP server is also connected in this session, additionally call
`mcp__cortadel__search_memory({ topK: 1 })` (no `query` — browse mode) as a second, independent
live-read path through the MCP surface rather than REST. Report it separately: a REST pass with an
MCP failure (or the reverse) narrows down which half of the install is actually broken. Skip this
sub-check — don't fail it — if the MCP tool isn't available in the current session.

### Display

Report all four checks together, PASS/FAIL/WARN per check, e.g.:

```
Config resolution   PASS  base_url, user_id, api_key all resolved (CORTADEL_* tier)
Server health       PASS  status=ok
Auth                PASS  HTTP 200
Live read           PASS  total=142 memories; MCP search_memory: PASS
```

If any check fails, add concrete next steps mirroring `docs/plugin.md`'s Troubleshooting section:
401 → check `CORTADEL_API_KEY`; 403 → check `CORTADEL_USER_ID` matches the key's user; degraded
health → point at whichever `checks.*` entry failed.
