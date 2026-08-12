---
name: reconcile
description: Run Cortadel entity reconciliation and review queued merge suggestions with the judge's confidence and reasoning. Use when the user asks to find or merge duplicate entities, run reconciliation, or review pending merge suggestions. mem0 has no equivalent — it has no reversible entity-reconciliation engine.
---

# Cortadel Reconcile

Runs entity reconciliation and reviews queued merge suggestions. **mem0 cannot do this** — it has
no reversible entity-reconciliation engine with an LLM judge and a review queue.

## Execution

### Step 1 — Kick off a run (only if the user wants one started)

Call `mcp__cortadel__reconcile_memories`. Both parameters are optional — omit either one the user
didn't ask for, don't guess a value:

```
reconcile_memories({
  ...(limit && { limit }),   // cap on candidate pairs judged
  ...(types && { types }),   // e.g. ["PERSON", "ORG"] — omit for all entity types
})
```

This returns a run id and starts an async job; it does not block until the run finishes.

If the user just wants to see what's already queued from a previous run, skip this step and go
straight to Step 3.

### Step 2 — Poll status

Call `mcp__cortadel__reconcile_status()` — it takes no parameters and reports on whatever run is
active for the current user. Poll every few seconds until `status` is `completed`, `failed`, or
`cancelled` (not `idle`/`running`). Don't poll indefinitely — after a reasonable number of checks,
tell the user it's still running and offer to check back later instead of blocking on it.

### Step 3 — Review suggestions

Call `mcp__cortadel__list_merge_suggestions`:

```
list_merge_suggestions({ status: "pending" })   // default; also accepts "approved" | "rejected"
```

Present each suggestion with its confidence and the judge's reasoning — both are part of what this
tool returns, per its own description. The exact response field names were not independently
verified against a live payload, so surface whatever the tool actually returns rather than
asserting a specific shape.

### Step 4 — Explain what happens next

This tool is **read-only** — reviewing suggestions here does not approve or reject them. Tell the
user that approval/rejection happens in the Cortadel dashboard's review UI, not through this skill
or any MCP tool. Mention that high-confidence pairs may already have been auto-merged by the
reconcile run itself (a server-side auto-approve threshold); anything still showing up under
`list_merge_suggestions(status: "pending")` is one that didn't clear that bar automatically.

## Notes

- Omit `limit`/`types` rather than inventing values when the user didn't specify them — both are
  genuinely optional on the wire.
- `list_merge_suggestions`'s `status` argument defaults to `"pending"` when omitted.
