---
name: recall
description: Search Cortadel memory deliberately — broader, filtered, or budgeted retrieval beyond what the automatic per-prompt recall gives. Use when the user asks to look something up in memory, search past context, or wants results scoped by project/tag/type — e.g. "search my memories for X", "what do we know about Y", "recall everything tagged auth".
---

# Cortadel Recall

Progressive, two-call retrieval via `mcp__cortadel__search_memory` — cheaper to scan and far more
controllable than the automatic per-prompt recall.

## How this differs from the automatic recall

Every prompt already triggers the `UserPromptSubmit` hook
(`cortadel-plugin/scripts/user-prompt-submit.mjs`), which calls REST `POST
/api/v1/memories/search` **directly** (not this MCP tool) with a fixed `top_k` of 3
(`CORTADEL_RECALL_TOPK`, default 3) and **no `project` or `tag` filter at all** — its request body
only ever contains `query`, `user_id`, `app_name`, `top_k`, `mode: "hybrid"`, and an optional
`rerank`. Reach for this skill instead whenever the automatic recall isn't enough: a larger result
set to scan, `project`/`tag`/`memory_type` filtering, a token budget, or browsing with no query at
all.

## Execution

### Step 1 — Scan cheaply

Call `mcp__cortadel__search_memory`:

```
search_memory({
  query: "<user's request>",   // omit entirely to browse chronologically instead of searching
  detail: "headline",          // id + gist + score only — cheap to scan
  topK: 20,                    // generous — this is a scan, not the final answer
  ...(project && { project }),
  ...(tag && { tag }),         // singular — one tag filter per call, not an array
  ...(memory_type && { memory_type }),
  ...(token_budget && { token_budget }),
})
```

Only pass `project` / `tag` / `memory_type` / `token_budget` when the user actually asked for that
scoping — they're optional filters, not defaults to invent on their behalf.

### Step 2 — Pick and expand

From the headline results, choose the ones actually relevant, then re-call with their ids to fetch
full content — this skips search/rerank entirely on the second call, it's a direct id lookup:

```
search_memory({ ids: ["<id1>", "<id2>", ...] })
```

### Step 3 — Answer

Use the expanded content to answer the user's question, citing memory ids where useful.

## Notes

- Parameter casing on this tool is mixed, not a typo: `topK` and `includeFaded` are camelCase;
  `memory_type`, `token_budget`, `include_profile`, `include_skills` are snake_case.
- `tag` takes exactly one value, not a list.
- For a plain browse with no query, omit `query` and use `limit`/`offset` for pagination instead of
  `topK`.
- `include_profile` and `include_skills` default to on when their respective server-side features
  are enabled — set them to `false` explicitly if the user wants search results only, no profile or
  skills block mixed in.
