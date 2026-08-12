---
name: history
description: Reconstruct what Cortadel memory said as of a past date, or trace a fact's supersession chain (what replaced or invalidated it, and when). Use when the user asks what they believed on a given date, wants to see superseded/historical versions of a fact, or asks how something changed over time. mem0 has no equivalent — it has no bi-temporal model.
---

# Cortadel History

Bi-temporal reconstruction: what memory said as of a past date, or the supersession chain behind a
fact. **mem0 cannot do this** — it has no bi-temporal model; edits there just overwrite.

## Execution

### Step 1 — Determine the question

- "What did we believe about X on/as of `<date>`?" → point-in-time reconstruction (Step 2a).
- "What used to be true about X before it changed?" / "trace the history of X" → supersession
  chain (Step 2b).

If the user gave neither a date nor a specific topic/memory, ask which one they mean before
calling anything.

### Step 2a — Point-in-time reconstruction

Call REST `Memories_List` (`GET /api/v1/memories`) with `as_of` set to the requested date (ISO
8601) and `search_query` narrowing to the topic, if one was given:

```bash
curl -G "$CORTADEL_URL/api/v1/memories" \
  -H "Authorization: Bearer $CORTADEL_API_KEY" \
  --data-urlencode "user_id=$CORTADEL_USER_ID" \
  --data-urlencode "as_of=2026-06-01" \
  --data-urlencode "search_query=<topic>" \
  --data-urlencode "size=20"
```

The returned items (`MemoryListItemResponse`) are what was valid as of that date; each carries
`valid_at`/`invalid_at`/`is_current`.

### Step 2b — Supersession chain

Call the same endpoint with `include_superseded=true` to include historical (non-current) versions
alongside the current one:

```bash
curl -G "$CORTADEL_URL/api/v1/memories" \
  -H "Authorization: Bearer $CORTADEL_API_KEY" \
  --data-urlencode "user_id=$CORTADEL_USER_ID" \
  --data-urlencode "include_superseded=true" \
  --data-urlencode "search_query=<topic>"
```

List items don't carry a `superseded_by` forward-pointer themselves — that field only exists on
the single-memory detail response. To walk the actual chain (which memory replaced which), fetch
each candidate's detail and follow the pointer:

```bash
curl "$CORTADEL_URL/api/v1/memories/<memoryId>?user_id=$CORTADEL_USER_ID" \
  -H "Authorization: Bearer $CORTADEL_API_KEY"
```

Follow `superseded_by` from the oldest version forward until it comes back `null` — that's the
current one.

### Step 3 — Present

Order chronologically by `valid_at`, and show each version's validity window (`valid_at` →
`invalid_at`, or "current" when `is_current` is true / `invalid_at` is null).

## Notes

- `as_of` and `include_superseded` are REST-only: reachable from no MCP tool and from none of the
  three published SDKs' `list()` methods (see `LLM.md`'s honest-gaps section).
- `Memories_List` paginates with `page`/`size` (default `page=1`, `size=10`, max `size=100`) — page
  through for a topic with a long history.
- There is no bulk "diff between two dates" operation; reconstruct each date separately with its
  own `as_of` call and compare the results yourself.
