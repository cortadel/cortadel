---
name: reconcile
description: Run Cortadel entity reconciliation and review queued merge suggestions with the judge's confidence and reasoning. Use when the user asks to find or merge duplicate entities, run reconciliation, or review pending merge suggestions. mem0 has no equivalent — it has no reversible entity-reconciliation engine.
---

# Cortadel Reconcile

Runs entity reconciliation and reviews queued merge suggestions. **mem0 cannot do this** — it has
no reversible entity-reconciliation engine with an LLM judge and a review queue.

## How this skill talks to Cortadel

Reconciliation is **REST, not MCP**. The server's MCP surface is exactly two tools — `add_memories`
and `search_memory` — so there is no `reconcile_memories`, `reconcile_status` or
`list_merge_suggestions` tool to call. Everything below goes through the plugin's own script, which
resolves your configured `base_url` / `user_id` / `api_key` the same way `doctor` does:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile.mjs" <command> [options]
```

It prints JSON on success and exits non-zero with a readable reason on failure. Read the JSON it
returns rather than assuming a field shape — report what actually came back.

## Execution

### Step 1 — Kick off a run (only if the user wants one started)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile.mjs" run
```

Add `--dry-run` if the user wants to see what *would* merge without changing anything. This starts
an async job and returns immediately — it does not block until the run finishes.

If the user just wants to see what's already queued from a previous run, skip to Step 3.

### Step 2 — Poll status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile.mjs" status
```

Poll every few seconds until the run reports a terminal state rather than an in-progress one. Don't
poll indefinitely — after a reasonable number of checks, tell the user it's still running and offer
to check back later instead of blocking on it. `reconcile.mjs cancel` stops a run in progress.

### Step 3 — Review suggestions

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile.mjs" suggestions
```

Defaults to pending; `--status approved` and `--status rejected` also work. Present each suggestion
with its confidence and the judge's reasoning. Surface whatever the payload actually contains rather
than asserting a specific shape.

### Step 4 — Approve or reject

Unlike the previous MCP-based version of this skill, review is **not** read-only — the REST surface
can act on a suggestion:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile.mjs" approve <suggestionId>
node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile.mjs" reject  <suggestionId>
```

Merges are reversible server-side (`POST /api/v1/entities/merges/{loserId}/unmerge`), but **always
confirm with the user before approving or rejecting** — never act on a suggestion they haven't seen
and agreed to. Approving is a write to their memory graph.

High-confidence pairs may already have been auto-merged by the run itself (there is a server-side
auto-approve threshold); anything still pending is a pair that didn't clear that bar automatically.

## Notes

- Don't invent filter values the user didn't ask for — the script omits what you don't pass.
- If the script reports the plugin is unconfigured, point the user at `/plugin` or the
  `CORTADEL_URL` / `CORTADEL_USER_ID` / `CORTADEL_API_KEY` environment variables; run the `doctor`
  skill to see which tier each value resolves from.
- The underlying endpoints, if you need them directly: `POST`/`GET`/`DELETE
  /api/v1/entities/reconcile`, `GET /api/v1/entities/suggestions`,
  `POST /api/v1/entities/suggestions/{id}/approve|reject`.
