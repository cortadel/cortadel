# Examples

Two things live here:

| File | What it is |
|---|---|
| [`openclaw.json`](openclaw.json) | A ready-to-merge OpenClaw config block enabling this plugin. |
| [`local-turn.ts`](local-turn.ts) | A runnable end-to-end walkthrough that drives the plugin's real `register()` against a ~40-line stand-in for OpenClaw. |

## `openclaw.json`

Merge the `plugins` block into your own `~/.openclaw/openclaw.json`:

```bash
openclaw plugins install clawhub:cortadel/openclaw
# ...merge examples/openclaw.json into ~/.openclaw/openclaw.json, then:
openclaw plugins inspect cortadel --runtime --json
```

**The file carries no comments, on purpose.** OpenClaw config is plain JSON validated
by two strict, closed schemas — the root `OpenClawSchema` (`.strict()`, so an unknown
top-level key is an `unrecognized_keys` error) and this plugin's own `configSchema`,
which sets `"additionalProperties": false`. Nothing in OpenClaw strips `"//"`-prefixed
keys. A `"//comment"` key inside `plugins.entries.cortadel.config` is therefore not
ignored — it fails validation, the loader logs
`[plugins] cortadel invalid config: ...` and skips the plugin entirely, so the plugin
silently never loads. The annotations that would have been comments are the table
below instead, and `test/plugin.test.ts` validates this exact file against both
schemas so it cannot drift back.

### What each value in the example does

| Key | Value in the example | Why |
|---|---|---|
| `baseUrl` | `http://localhost:3001` | Where a self-hosted `docker compose up` listens. Hosted Cortadel is `https://app.cortadel.ai`. |
| `apiKey` | `${CORTADEL_API_KEY}` | Never inline a real key. OpenClaw expands `${VAR}` in any config string value; a SecretRef works too. Self-hosted Cortadel defaults to auth disabled, so this line can be deleted outright. |
| `userId` | `e2e-openclaw-example` | The Cortadel namespace that owns these memories. The `e2e-` prefix marks it as disposable test data — **change it** to your own id. |
| `recallScope` | `fixed` | One memory namespace shared across every agent and conversation — the right default for a personal assistant. `agent`, `session`, and `sender` suffix the id instead, trading carry-over for isolation. |
| `autoRecall` | `true` | Search Cortadel before each model call and prepend what matches. |
| `autoCapture` | `true` | Send each completed turn to Cortadel so it can distil durable facts. |
| `corpusSupplement` | `true` | Expose Cortadel behind OpenClaw's own `memory_search` / `memory_get`, alongside the built-in corpus. |
| `topK` | `5` | Maximum memories retrieved per recall (1–50), and the fallback when the `cortadel_search_memory` tool omits its own `topK`. |
| `minScore` | `0` | Keep every hit. Raise it to drop weakly-ranked memories. |
| `rerank` | `false` | Cortadel's local cross-encoder. More accurate, slower. |
| `timeoutMs` | `5000` | Per-request budget. On timeout the turn simply proceeds without memory. |
| `dedupeWindow` | `200` | Memory ids remembered per session so the same facts are not re-injected every turn. |
| `circuitBreaker` | `{ maxFailures: 3, cooldownMs: 60000 }` | After 3 consecutive errors, skip memory for a minute instead of slowing every turn. |
| `tags` | `["openclaw"]` | Applied to every fact captured from a turn, for scoped retrieval later. |

Every option, including the ones the example leaves at their defaults
(`appName`, `promptSupplement`, `minPromptChars`, `project`), is in the
[configuration table in the main README](../README.md#configuration).

## `local-turn.ts`

```bash
pnpm install && pnpm build
node examples/local-turn.ts
```

`node` runs the `.ts` file as-is: type stripping has been on by default since Node
22.18, and this package requires ≥ 22.22.3, so no loader, no `tsx`, no separate
compile step. `pnpm build` is for the plugin the example imports, not for the
example. It is TypeScript so that `pnpm typecheck` covers it — `tsconfig.test.json`
includes `examples/` and maps `@cortadel/openclaw` to `src/index.ts`, so this file is
compiled against the plugin's current source and cannot quietly fall behind it.

It talks to a **real** Cortadel server — start one with `docker compose up` from the
Cortadel repo root, or point it at the hosted service:

```bash
CORTADEL_BASE_URL=https://app.cortadel.ai CORTADEL_API_KEY=... node examples/local-turn.ts
```

With no server reachable it still runs to completion, which demonstrates the other
half of the design: memory degrades, the agent keeps going.
