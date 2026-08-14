# Cortadel × OpenClaw

Give your [OpenClaw](https://github.com/openclaw/openclaw) agent memory that outlives the
conversation. Cortadel is self-hosted long-term **temporal graph memory** for AI agents — a
bi-temporal graph store with hybrid BM25 + vector search — and this plugin wires it into OpenClaw
at three seams at once: Cortadel becomes an **additive memory corpus** behind OpenClaw's own
`memory_search`/`memory_get` tools, the agent gets **two dedicated tools** for reaching Cortadel
directly, and optional **hooks** recall relevant memories before each model call and capture every
completed turn afterwards. It is additive by design — it composes with OpenClaw's built-in
`memory-core` rather than replacing it.

## Install

```bash
openclaw plugins install clawhub:cortadel/openclaw
```

That is the ClawHub slug (`clawhub:<org>/<plugin>`). The same code is published to npm as
[`@cortadel/openclaw`](https://www.npmjs.com/package/@cortadel/openclaw) — install it directly if you
manage plugin directories yourself:

```bash
npm install @cortadel/openclaw
```

Then enable it in `~/.openclaw/openclaw.json` and confirm the runtime loaded:

```bash
openclaw plugins inspect cortadel --runtime --json
```

## Quickstart

You need a Cortadel server. Either self-host it —

```bash
git clone https://github.com/cortadel/cortadel && cd cortadel
docker compose up          # API on http://localhost:3001
```

— or use the hosted service at `https://app.cortadel.ai`.

Then add the plugin to your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "cortadel": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:3001",
          "userId": "my-user-id",
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

That is the whole setup. Self-hosted Cortadel defaults to auth disabled, so no key is needed; for
the hosted service add `"apiKey": "${CORTADEL_API_KEY}"` and export the variable. From here on:

- anything durable the user says is distilled into Cortadel after the turn, and
- relevant memories are injected into the context of later turns, in this conversation and every
  future one.

A complete, runnable walkthrough — capture a turn, recall it on the next one, query it by tool, and
read it back through OpenClaw's own memory tool — lives in
[`examples/local-turn.ts`](examples/local-turn.ts):

```bash
pnpm install && pnpm build
node examples/local-turn.ts
```

`node` runs the TypeScript file directly — it strips types natively, and this package's Node floor
is well past the 22.18 that made that the default — so the example needs no loader of its own.

[`examples/openclaw.json`](examples/openclaw.json) is a ready-to-merge config block, annotated
line-by-line in [`examples/README.md`](examples/README.md). The annotations live there rather than
in the JSON because OpenClaw config is plain JSON validated by two closed schemas and nothing strips
`"//"` comment keys — a commented config fails validation and the plugin is skipped at load.

## What you get

### 1. Cortadel as a memory corpus (the main seam)

The plugin calls `api.registerMemoryCorpusSupplement(...)`, which plugs a `search`/`get` pair in
behind OpenClaw's **own** `memory_search` and `memory_get` tools. Your agent reaches Cortadel
through the memory interface it already knows — no new tool to learn, and results appear alongside
the local workspace corpus, tagged `cortadel` and addressed as `cortadel://<memory-id>`.

This is deliberately a *supplement*, not a *capability*. `api.registerMemoryCapability(...)` is an
exclusive slot — taking it replaces OpenClaw's memory backend outright and must be selected through
`plugins.slots.memory`. Cortadel is a remote graph of distilled facts, not a substitute for
OpenClaw's local file-and-line memory, so it registers additively and the two work together.

It also contributes a short cached system-prompt section (`registerMemoryPromptSupplement`) telling
the model that long-term memory is available.

### 2. Two agent tools

| Tool | What it does |
|---|---|
| `cortadel_search_memory` | Search long-term memory across every past conversation. Params: `query`, optional `topK` (1–50, defaults to the configured `topK`). |
| `cortadel_add_memories` | Store a durable fact. Params: `text`, optional `memory_type` (`episodic` \| `semantic` \| `procedural`). |

The stems (`search_memory`, `add_memories`) match Cortadel's own MCP tool names; the `cortadel_`
prefix is OpenClaw's requirement for plugin-owned tools.

Both are declared in `contracts.tools` and registered through `registerTool`'s **factory** form, so
each call resolves its own user id from that turn's context — safe under OpenClaw's concurrent
sessions. Restrict them with `tools.allow` if you want the model to use memory only on request.

### 3. Automatic memory

| Hook | When | What happens |
|---|---|---|
| `before_prompt_build` | Before each model call | Searches Cortadel with the user's prompt and returns `prependContext` containing the matches. |
| `llm_output` | After a model attempt produces output | Sends the user/assistant pair to `addConversation`, which distils durable facts from it. |
| `session_start`, `before_reset` | New or reset conversation | Clears that conversation's recall history. |

`llm_output` is used for capture rather than `agent_end` because it exposes the turn as typed
`prompt` and `assistantTexts` fields, where `agent_end` only offers `messages: unknown[]`.

Injected memories use `prependContext`, not `prependSystemContext` — the latter is reserved for
static, prompt-cacheable guidance, and recall changes every turn.

### Design notes worth knowing

- **Recall reaches across sessions; capture is scoped to one.** Cortadel's `sessionId` *restricts*
  search results, so it is deliberately never set on recall — that would defeat long-term memory.
  It *is* set on capture, to group the facts one conversation produced.
- **Memories are not re-injected every turn.** A bounded per-session ledger (`dedupeWindow`)
  remembers which memory ids already went into a conversation and suppresses them on later turns,
  so a stable set of top hits is not re-paid for on every request. It resets on session start/reset.
- **Memory never takes down the agent.** Every Cortadel call runs under an `AbortSignal` deadline
  and a try/catch, and a circuit breaker stops calling a server that is already failing. A Cortadel
  outage means turns proceed without memory and `memory_search` falls back to local results — it
  never throws into the agent loop. Failing open is unconditional here, so there is deliberately no
  `throwOnError` switch: a plugin that threw would fail the hook and take the turn with it.
  Swallowed failures are reported through OpenClaw's own `PluginLogger` at `warn`, which is where an
  `onError` callback's output would have gone anyway — and plugin config is plain JSON, which cannot
  carry a callback.
- **Capture is awaited, not fire-and-forget.** The `llm_output` hook awaits the write (bounded by
  `timeoutMs`), because a detached promise can be cut off when the run ends — losing the memory
  silently — so there is no `awaitPersist` knob to turn that off.
- **Injected memory is framed as data.** The recall block is tagged and explicitly labelled as
  background facts rather than instructions, since stored text is untrusted input.

## Configuration

Everything lives under `plugins.entries.cortadel.config`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | `http://localhost:3001` (or `$CORTADEL_BASE_URL`) | Cortadel server. Hosted: `https://app.cortadel.ai`. |
| `apiKey` | `string` | — (or `$CORTADEL_API_KEY`) | Sent as `Authorization: Bearer`. Omit when self-hosted auth is disabled. Prefer `${VAR}` or a SecretRef over a literal. |
| `userId` | `string` | `default` (or `$CORTADEL_USER_ID`) | The Cortadel namespace owning these memories. |
| `appName` | `string` | `cortadel-openclaw` | Recorded on searches for access logging, and as the app label on memories written by the `cortadel_add_memories` tool. Auto-captured turns go through `addConversation`, whose options carry no app field, so those facts have no app label. |
| `recallScope` | `"fixed"` \| `"agent"` \| `"session"` \| `"sender"` | `fixed` | How wide a namespace a turn recalls from and writes to — see below. |
| `autoRecall` | `boolean` | `true` | Inject relevant memories before each model call. |
| `autoCapture` | `boolean` | `true` | Persist each completed turn. |
| `corpusSupplement` | `boolean` | `true` | Expose Cortadel behind `memory_search` / `memory_get`. |
| `promptSupplement` | `boolean` | `true` | Add the cached system-prompt section. |
| `topK` | `integer` 1–50 | `5` | Maximum memories per recall. One knob covers both automatic recall and the `cortadel_search_memory` tool, so the tool's own `topK` argument falls back to this value rather than to the SDK's own search default of 10. |
| `minScore` | `number` | `0` | Drop recalled memories below this fused RRF score. |
| `rerank` | `boolean` | `false` | Use Cortadel's local cross-encoder reranker. More accurate, slower. |
| `timeoutMs` | `integer` 250–120000 | `5000` | Per-request budget. On timeout the turn proceeds without memory. |
| `dedupeWindow` | `integer` 0–5000 | `200` | Memory ids remembered per session to avoid re-injection. `0` disables. |
| `minPromptChars` | `integer` | `8` | Skip recall for prompts shorter than this. |
| `circuitBreaker.maxFailures` | `integer` | `3` | Consecutive failures before memory is skipped. |
| `circuitBreaker.cooldownMs` | `integer` | `60000` | How long to skip before retrying. |
| `tags` | `string[]` | — | Tags applied to every captured fact. |
| `project` | `string` | — | Project scope recorded on captured facts. |

Out-of-range and malformed values are clamped or ignored rather than rejected — a plugin that
refuses to load would take the agent with it.

### Choosing a `recallScope`

A Cortadel client is bound to **one user id at construction** — no method takes a user id — so
scoping means picking an id per turn and keeping one client per id. That is what this option
controls. It narrows recall and capture together: a turn always writes to the same namespace it
reads from, so an agent can never store a fact it cannot retrieve.

| Scope | Cortadel user id | Use when |
|---|---|---|
| `fixed` | `userId` | **Default.** One operator, one shared memory. Memory carries across every agent and conversation. |
| `agent` | `userId:<agentId>` | Several agents that should not read each other's memory. |
| `session` | `userId:<sessionKey>` | Each conversation fully isolated. |
| `sender` | `userId:<senderId>` | A shared group chat where each human gets their own memory. |

Only `fixed` gives memory that carries across conversations for one person; the others trade that
for isolation. If the discriminator is missing on a turn, the plugin falls back to the base `userId`
rather than inventing a namespace.

## Running the tests

```bash
pnpm install
pnpm exec vitest run     # 145 unit tests, fully offline
pnpm typecheck           # src, test and examples, against the real openclaw type declarations
pnpm build
```

The examples are TypeScript for that second line's sake: `tsconfig.test.json` type-checks
`examples/` against this package's own source (`@cortadel/openclaw` is mapped to `src/index.ts`, so
the pass needs no prior build), which is what stops a documented example from drifting away from the
API it demonstrates.

The tests need no network, no Cortadel server, and no API keys — the Cortadel client is stubbed at
its own boundary, and `register()` is driven against a fake plugin API. Test data uses `e2e-*` user
ids throughout.

`examples/openclaw.json` is checked against OpenClaw's *own* validators — the manifest-derived
plugin-config schema (`buildJsonPluginConfigSchema`) and the root `OpenClawSchema` — so the config
the README tells you to copy cannot drift into something the loader rejects.

## Requirements

- **Node.js ≥ 22.22.3** — OpenClaw's own floor (`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`).
- **OpenClaw ≥ 2026.7.1** — declared as a peer dependency, matching OpenClaw's plugin convention.
  Verified against `openclaw@2026.7.1-2`.
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted via
  `docker compose up` (→ `http://localhost:3001`). See
  [self-hosting](https://github.com/cortadel/cortadel/blob/main/docs/self-hosting.md).

## Links

- [Cortadel on GitHub](https://github.com/cortadel/cortadel)
- [cortadel.ai](https://cortadel.ai)
- [`@cortadel/sdk`](https://www.npmjs.com/package/@cortadel/sdk) — the TypeScript SDK this builds on
- [OpenClaw plugin docs](https://docs.openclaw.ai)

Licensed under Apache-2.0, same as the rest of the Cortadel repository.
