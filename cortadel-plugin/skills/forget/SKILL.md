---
name: forget
description: Retract or permanently erase a Cortadel memory. Use when the user says "forget that...", "X is no longer true", "that's outdated", "delete this memory", or "permanently remove <memory>". Default path is a natural-language retraction that keeps history queryable; hard, unrecoverable deletion only happens on an explicit, separately-confirmed request.
---

# Cortadel Forget

The flagship memory-editing skill. Two distinct paths — pick deliberately, don't default to the
destructive one.

- **Path A — Retraction (default).** Write the retraction as a normal memory and let the server's
  intent classifier route it. History stays queryable afterward (see the `history` skill).
- **Path B — Hard-erase (explicit request only).** Permanently deletes rows. Never take this path
  unless the user asked for permanent/irreversible removal in so many words.

## Path A — Retraction (default)

### Step 1 — Get the fact to retract

Take it from the user's message ("forget that X", "X is no longer true", "that's outdated"). If
it's ambiguous which fact they mean, ask before proceeding.

### Step 2 — Store the retraction as a natural memory

Call `mcp__cortadel__add_memories` with the retraction phrased as plain language, not a delete
command — don't rewrite the user's phrasing into something more forceful than what they said:

```
add_memories({ memories: ["<the retraction, in the user's own words>"] })
```

This lets the server's own intent classifier decide which of its supersede/invalidate/delete-entity
/touch/resolve branches actually applies — you are not choosing the branch yourself, and you
should not tell the user which branch you expect it to take.

### Step 3 — Report the event, but do not assert which one it will be

Report the returned `event` field verbatim. **Do not claim in advance that it will be
`INVALIDATE`, `DELETE_ENTITY`, or any other specific token**, and don't branch your own logic on
an assumed value. The public contract is genuinely inconsistent here: `spec/openapi.json` types
`event` as a nullable string and names only `ADD`, `SKIP_DUPLICATE`, `ERROR` (plus one incidental
mention of `INVALIDATE` elsewhere in the same file), while `LLM.md` separately asserts a closed
eight-token list (`ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, `TOUCH`, `RESOLVE`, `INVALIDATE`,
`DELETE_ENTITY`, `ERROR`). Treat `event` as an opaque string to surface to the user, never as a
value your own code paths depend on.

### Step 4 — Verify it's gone from live results

Call `mcp__cortadel__search_memory` with `query` set to the retracted fact's topic (default
`detail`, i.e. full content). Confirm the retracted content no longer appears among live results.
If it still does, tell the user the retraction may not have taken effect yet (extraction runs
async, off the request path) and offer to check again shortly — don't silently fall through to
Path B just because Path A hasn't converged yet.

## Path B — Hard-erase (explicit request only)

Trigger phrases: "permanently delete", "purge this", "hard-delete", "remove it for good". Never
infer this path from an ordinary "forget X" — that's Path A.

### Step 1 — Find candidates and show them

Call `mcp__cortadel__search_memory` with a `query` describing what to delete. **Show the user the
numbered results with their ids** before doing anything else — never reuse a search the user
hasn't seen:

```
1. [id abc123] "<content>" (created <date>)
2. [id def456] "<content>" (created <date>)
```

### Step 2 — Confirm, literally

Ask a literal, explicit confirmation naming the exact ids about to be destroyed, e.g.:

> "Permanently delete memor{y,ies} [abc123, def456]? This cannot be undone and does not go through
> the retraction/history path. Type 'delete' to confirm."

Do not proceed without an explicit affirmative reply that names what's being deleted.

### Step 3 — Delete

Only after confirmation, call REST `Memories_BulkDelete` — there is no MCP delete tool (the eight
`cortadel` MCP tools have no delete operation):

```bash
curl -X DELETE "$CORTADEL_URL/api/v1/memories" \
  -H "Authorization: Bearer $CORTADEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"user_id": "'"$CORTADEL_USER_ID"'", "memory_ids": ["abc123", "def456"]}'
```

`user_id` and `memory_ids` are both required by `DeleteMemoriesRequest`. Build `memory_ids`
**only** from the list the user just confirmed in Step 2 — never from a fresh, unseen search, and
never from a search whose results you didn't show.

### Step 4 — Report

Report the response's `message` field verbatim (e.g. "Deleted 2 memories.").

## Constraints

- Never take Path B without an explicit, literal user confirmation naming the ids to delete.
- Never build `memory_ids` from a search the user has not seen.
- Never assert in advance which `event` token Path A will return.
