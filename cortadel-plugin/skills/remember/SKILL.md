---
name: remember
description: Write one fact to Cortadel memory right now, with scoping control the automatic Stop-hook capture doesn't give you. Use when the user says "remember that...", "save this", "note that...", "store this fact", or explicitly asks to record a decision, preference, or convention outside of normal end-of-turn capture.
---

# Cortadel Remember

Store one fact immediately via the `cortadel` MCP server, instead of waiting for the automatic
end-of-turn `Stop` hook capture (`cortadel-plugin/scripts/stop-capture.mjs`) to distill it later.

## When to use

- The user says "remember that …", "save this", "note that …", "store this fact", or explicitly
  asks to record a decision, preference, or convention right now.
- Not for casual conversation — only for content the user wants explicitly persisted.

## Execution

### Step 1 — Get the text

Take the fact from the user's message, as close to verbatim as possible. If no text was given,
ask: "What should I remember?" and wait for the answer. Don't paraphrase or restructure it — the
server's own intent classifier and dedup logic key off the literal wording.

### Step 2 — Scope it

- **`project`** — always set it, to the basename of the current working directory. This matches
  the convention `cortadel-plugin/scripts/stop-capture.mjs` already uses for its own auto-captured
  memories (`basename(cwd)`), so manual and automatic writes land in the same project bucket:
  ```bash
  basename "$(pwd)"
  ```
- **`tags`** — only when the user names a topic ("remember this about auth: …" → `tags: ["auth"]`).
  Omit the field entirely otherwise; don't invent a tag to fill it.
- **`memory_type`** — only when the user pins one explicitly ("remember this as a procedural note"
  → `memory_type: "procedural"`, one of `episodic` | `semantic` | `procedural`). Omit otherwise and
  let the server auto-classify.

### Step 3 — Store it

Call `mcp__cortadel__add_memories`:

```
add_memories({
  memories: ["<the fact, as given>"],
  project: "<repo basename>",
  ...(tags && { tags }),
  ...(memory_type && { memory_type }),
})
```

`memories` is the only required field — it takes an array, even for one fact. There is **no
`infer` parameter** on this MCP tool (unlike the REST `Memories_Create` operation, which has one):
every `add_memories` call always runs the full intent-classify → dedup → extraction pipeline; you
cannot request a verbatim, extraction-skipped store through MCP.

### Step 4 — Report the result

Report the response's `event` field **verbatim** — do not rename, reinterpret, or summarize it
into something it didn't say. If `event` is `SKIP_DUPLICATE`, treat that as success too ("already
remembered — not duplicated") and do not retry the call. Don't assume `event` is drawn from any
particular fixed set before reporting it — see the `forget` skill's note on why this field's public
contract is looser than it looks.

## Example

> User: "Remember that we use pnpm, not npm, in this repo."
>
> 1. text = "we use pnpm, not npm, in this repo"
> 2. `project` = `cortadel` (repo basename); `tags` omitted (no named topic); `memory_type` omitted
> 3. `add_memories({ memories: ["we use pnpm, not npm, in this repo"], project: "cortadel" })`
> 4. "Remembered (event: ADD)."
