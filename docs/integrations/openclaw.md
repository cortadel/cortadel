# Cortadel × OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) is a multi-channel AI gateway — one agent runtime
sitting behind many messaging channels. `@cortadel/openclaw` is a first-party OpenClaw **plugin**
that gives that agent memory outliving the conversation, and it wires Cortadel in at three seams at
once: Cortadel becomes an **additive memory corpus** behind OpenClaw's own `memory_search` /
`memory_get` tools, the agent gets **two dedicated tools** for reaching Cortadel directly, and
optional **hooks** recall relevant memories before each model call and capture every completed turn
afterwards. It is additive by design — it composes with OpenClaw's built-in `memory-core` rather
than replacing it.

## Install

```bash
openclaw plugins install clawhub:cortadel/openclaw
```

That is the ClawHub slug (`clawhub:<org>/<plugin>`), and it is what the package pins as its default
install channel (`openclaw.install.defaultChoice`). The same code is published to npm as
[`@cortadel/openclaw`](https://www.npmjs.com/package/@cortadel/openclaw) — install it directly if
you manage plugin directories yourself:

```bash
npm install @cortadel/openclaw
```

Either way, confirm the runtime loaded it:

```bash
openclaw plugins inspect cortadel --runtime --json
```

## Quickstart

You need a running Cortadel server. Self-host one —

```bash
git clone https://github.com/cortadel/cortadel && cd cortadel
docker compose up          # API on http://localhost:3001
```

— or point at the hosted service, `https://app.cortadel.ai`.

Then enable the plugin in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "cortadel": {
        "enabled": true,
        "config": {
          "baseUrl": "http://localhost:3001",
          "apiKey": "${CORTADEL_API_KEY}",
          "userId": "e2e-openclaw-example",
          "recallScope": "fixed",
          "autoRecall": true,
          "autoCapture": true,
          "corpusSupplement": true,
          "topK": 5,
          "timeoutMs": 5000,
          "tags": ["openclaw"]
        }
      }
    }
  }
}
```

That is the whole setup. Self-hosted Cortadel defaults to auth disabled, so `apiKey` can be dropped
entirely; for the hosted service export `CORTADEL_API_KEY` and OpenClaw expands the `${VAR}`
reference for you. From the next turn on, anything durable the user says is distilled into Cortadel
after the turn, and relevant memories are injected into the context of later turns — in this
conversation and every future one.

> **OpenClaw config is plain JSON, validated by two closed schemas, and nothing strips `"//"` keys.**
> A commented config fails validation and the plugin is skipped at load with a
> `[plugins] cortadel invalid config: …` line. Keep annotations out of the file.

The package ships a runnable walkthrough that drives the real `register()` against a ~40-line
stand-in for the OpenClaw plugin API — capture a turn, recall it on the next one, query it by tool,
and read it back through OpenClaw's own memory tool:

```bash
pnpm install && pnpm build
node examples/local-turn.ts     # honours CORTADEL_BASE_URL / CORTADEL_API_KEY
```

## What you get

### 1. Cortadel as a memory corpus — the automatic-read seam

`api.registerMemoryCorpusSupplement(...)` plugs a `search` / `get` pair in behind OpenClaw's **own**
`memory_search` and `memory_get` tools. The agent reaches Cortadel through the memory interface it
already knows — no new tool to learn — and hits appear alongside the local workspace corpus, tagged
`cortadel`, addressed as `cortadel://<memory-id>`, labelled `Cortadel` (or `Cortadel (shared)` for a
global memory), with the memory type as `kind` and the writing app as `sourcePath`. `memory_get`
accepts either the `cortadel://` path or a bare memory id, and honours `fromLine` / `lineCount`.

It also contributes a short cached system-prompt section
(`api.registerMemoryPromptSupplement(...)`) telling the model that long-term memory is available —
and naming only the tools that are actually registered on that turn.

### 2. Two agent tools

| Tool | What it does |
|---|---|
| `cortadel_search_memory` | Hybrid search across every past conversation. Params: `query` (required), optional `topK` (1–50, defaults to the configured `topK`). |
| `cortadel_add_memories` | Store a durable fact. Params: `text` (required), optional `memory_type` (`episodic` \| `semantic` \| `procedural`). |

The stems (`search_memory`, `add_memories`) match Cortadel's own MCP tool names; the `cortadel_`
prefix is OpenClaw's requirement for plugin-owned tools, and both names are declared in the
manifest's `contracts.tools`. Restrict them with `tools.allow` if you want the model to reach memory
only on request.

Neither tool fails a turn. An unreachable Cortadel is reported in-band — the model is told memory is
unavailable and to answer without it — while a genuinely bad argument (an empty `query`) throws, per
OpenClaw's tool contract. `cortadel_add_memories` reports what the store pipeline actually did
(`ADD`, `SKIP_DUPLICATE`, …) rather than assuming a 200 means a new memory was written.

### 3. Automatic memory

| Hook | When | What happens |
|---|---|---|
| `before_prompt_build` | Before each model call | Searches Cortadel with the user's prompt and returns `prependContext` carrying the matches. |
| `llm_output` | After a model attempt produces output | Sends the user/assistant pair to `add_conversation`, which distils durable facts from it. |
| `session_start`, `before_reset` | New or reset conversation | Clears that conversation's recall history. |

## Configuration

Everything lives under `plugins.entries.cortadel.config`. Out-of-range and malformed values are
clamped or ignored rather than rejected — a plugin that refuses to load would take the agent with
it.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `string` | `http://localhost:3001` (or `$CORTADEL_BASE_URL`) | Cortadel origin. Hosted: `https://app.cortadel.ai`. |
| `apiKey` | `string` | — (or `$CORTADEL_API_KEY`) | Sent as `Authorization: Bearer`. Omit when self-hosted auth is disabled. Prefer `${VAR}` or a SecretRef over a literal. |
| `userId` | `string` | `default` (or `$CORTADEL_USER_ID`) | The Cortadel namespace owning these memories. |
| `appName` | `string` | `cortadel-openclaw` | Sent on every search for access logging, and recorded as the app label on memories written by `cortadel_add_memories`. |
| `recallScope` | `"fixed"` \| `"agent"` \| `"session"` \| `"sender"` | `fixed` | How wide a namespace a turn recalls from **and** writes to — see below. |
| `autoRecall` | `boolean` | `true` | Inject relevant memories before each model call. |
| `autoCapture` | `boolean` | `true` | Persist each completed turn. |
| `corpusSupplement` | `boolean` | `true` | Expose Cortadel behind `memory_search` / `memory_get`. |
| `promptSupplement` | `boolean` | `true` | Add the cached system-prompt section. |
| `topK` | `integer` 1–50 | `5` | Maximum memories per recall. One knob covers automatic recall, the corpus supplement's default page, and the `cortadel_search_memory` tool — so the tool's own `topK` argument falls back to this value rather than to the SDK's search default of 10. |
| `minScore` | `number` ≥ 0 | `0` | Drop automatically recalled memories below this fused RRF score. Hits that arrive without a score are kept. |
| `rerank` | `boolean` | `false` | Use Cortadel's cross-encoder reranker on every search this plugin issues. More accurate, slower. |
| `timeoutMs` | `integer` 250–120000 | `5000` | Per-request budget. On timeout the turn proceeds without memory. |
| `dedupeWindow` | `integer` 0–5000 | `200` | Memory ids remembered per session so automatic recall does not re-inject them. `0` disables. |
| `minPromptChars` | `integer` 0–4000 | `8` | Skip automatic recall for prompts shorter than this. |
| `circuitBreaker.maxFailures` | `integer` 1–100 | `3` | Consecutive failures before memory is skipped entirely. |
| `circuitBreaker.cooldownMs` | `integer` 1000–600000 | `60000` | How long to skip before letting one probe through. |
| `tags` | `string[]` | — | Tags applied to every **captured** fact. |
| `project` | `string` | — | Project scope recorded on every **captured** fact. |

### Choosing a `recallScope`

A Cortadel client is bound to **one user id at construction** — no method takes a user id — so
scoping means picking an id per turn and keeping one client per id. That is exactly what this option
controls, and it narrows recall and capture *together*: a turn always writes to the namespace it
reads from, so an agent can never store a fact it cannot retrieve.

| Scope | Cortadel user id | Use when |
|---|---|---|
| `fixed` | `userId` | **Default.** One operator, one shared memory that carries across every agent and conversation. |
| `agent` | `userId:<agentId>` | Several agents that should not read each other's memory. |
| `session` | `userId:<sessionKey>` | Each conversation fully isolated. |
| `sender` | `userId:<senderId>` | A shared group chat where each human gets their own memory. |

Discriminators are lowercased and reduced to `[a-z0-9._-]`, capped at 96 characters. When the chosen
discriminator is missing on a turn, the plugin falls back to the base `userId` rather than inventing
a namespace.

## How it works

The whole contract with the host is `register(api: OpenClawPluginApi)`. `definePluginEntry` (from
`openclaw/plugin-sdk/plugin-entry`) wraps `{ id, name, description, register }` into the normalized
default export OpenClaw loads, and `package.json`'s `openclaw.extensions` points the loader at
`./dist/index.js`.

**The manifest — `openclaw.plugin.json`.** `activation.onStartup: true` loads the plugin with the
gateway; `contracts.tools` declares `cortadel_search_memory` and `cortadel_add_memories` so OpenClaw
can discover tool ownership *without loading the runtime* (which is why a bad `baseUrl` still
registers both tools — it disables the calls, not the contract); `configSchema` is a closed
(`additionalProperties: false`) JSON Schema that the loader validates your config against;
`uiHints` and `toolMetadata` drive the settings UI.

**Reads — `api.registerMemoryCorpusSupplement(...)`.** This is the deliberate choice at the heart of
the package: a *supplement*, not a *capability*. `api.registerMemoryCapability(...)` is an exclusive
slot — taking it replaces OpenClaw's memory backend outright and can only be selected through
`plugins.slots.memory`. Cortadel is a remote graph of distilled facts, not a substitute for
OpenClaw's local workspace-file memory, so it registers non-exclusively and composes with
`memory-core` (and any other memory plugin) instead of displacing it.

**Prompt — `api.registerMemoryPromptSupplement(...)`.** The additive variant, and easy to confuse
with two neighbours: `registerMemoryPromptSection` is the exclusive slot and carries the
`@deprecated Use registerMemoryCapability({ promptBuilder })` note, and that suggested replacement
throws unless the plugin declares `kind: "memory"` — which this one deliberately does not.

**Tools — `api.registerTool(...)`, factory form.** Registered as a factory rather than as static
objects: OpenClaw invokes it with that turn's `OpenClawPluginToolContext` (`agentId`, `sessionKey`,
`sessionId`, and the trusted `requesterSenderId`), which is what lets non-`fixed` scopes resolve
correctly. A static tool would have had to read the current turn from module state — unsafe in a
gateway that runs many sessions concurrently, and a way to route one user's write into another
user's namespace. The tools are shaped as `AnyAgentTool`: TypeBox `parameters`, a required `label`,
and an `execute` resolving to `{ content, details }`.

**Hooks — `api.on(...)`.** Recall runs on `before_prompt_build` and returns `prependContext`, not
`prependSystemContext`: the latter is reserved for static guidance providers can prompt-cache, and
recall changes every turn. Capture runs on `llm_output` rather than `agent_end` because it carries
the turn as typed `prompt` and `assistantTexts` fields, where `agent_end` only exposes
`messages: unknown[]`. `session_start` and `before_reset` reset the per-conversation recall ledger.

Two more decisions worth knowing:

- **Recall reaches across sessions; capture is scoped to one.** Cortadel's `sessionId` *restricts*
  search results, so it is deliberately never set on recall — that would defeat long-term memory. It
  *is* set on capture, to group the facts one conversation produced.
- **Memories are not re-injected every turn.** A bounded per-session ledger (`dedupeWindow`)
  remembers which ids already went into a conversation and suppresses them later, so a stable set of
  top hits is not paid for on every request. Only what the character budget actually let through is
  recorded, so a budget-dropped memory is not silently marked "already seen".

Everything between the plugin and the server runs through one gateway: a client per resolved user id
(LRU-capped at 256, so `session` scoping cannot grow unbounded), an `AbortSignal.timeout(timeoutMs)`
deadline on every call, a try/catch that converts a throw into a result object, and a
consecutive-failure circuit breaker that stops hammering a server already failing and lets one probe
through after the cooldown.

## Known limits

**Canon deviations, and why.** OpenClaw plugin config is plain JSON in `openclaw.json`, which cannot
carry a function — so there is no `onError` callback, and no `throwOnError` either: failing open is
unconditional here, because a plugin that threw would fail the hook and take the turn with it.
Swallowed failures go to OpenClaw's own `PluginLogger` at `warn`, which is where an `onError`
callback's output would have gone anyway. There is no `awaitPersist`: the `llm_output` hook always
awaits the write (bounded by `timeoutMs`), because a detached promise can be cut off when the run
ends, losing the memory silently. And there is no `scopeRecallToSession` boolean — `recallScope` is
a four-value enum instead, because the plugin genuinely has four scopes and each one *is* a choice
of Cortadel user id. `appName` defaults to the de-scoped `cortadel-openclaw` rather than the literal
npm name, since it is recorded as a plain label on searches and writes.

- **Auto-captured facts carry no app label.** Capture goes through `add_conversation`, whose options
  carry no app field, so `appName` reaches searches and `cortadel_add_memories` writes only.
- **`tags` and `project` apply to capture only.** Facts written by the `cortadel_add_memories` tool
  carry neither; that path sets the app label and the optional memory type.
- **Corpus lookups see less identity than hooks do.** OpenClaw hands the corpus supplement only an
  `agentSessionKey`, so under `recallScope: "sender"` a `memory_search` / `memory_get` call falls
  back to the base `userId`, and under `agent` it derives the agent id from the session-key prefix.
  The dedicated tools and the hooks get the full turn context and are unaffected.
- **`minScore`, `dedupeWindow` and `minPromptChars` govern automatic recall only** — not the corpus
  supplement, and not the `cortadel_search_memory` tool.
- **Injected context is hard-capped at 4,000 characters**, independent of `topK`, with single
  memories elided at 400 characters, so recall cannot dominate the window.
- **Capture stores the final user/assistant pair, not the whole history**, truncated at 32,000
  characters per message; a half-turn (empty prompt or empty reply) is dropped rather than guessed
  at.
- **The recall ledger is in-memory and per-process.** A gateway restart re-injects once, which is
  harmless; it tracks at most 512 conversations before dropping the coldest.
- **A bad `baseUrl` disables memory rather than failing the load** — the plugin logs an error, still
  registers its declared tools, and every call reports `disabled`.
- **Verified against `openclaw@2026.7.1-2` only, and never loaded by a live gateway.** The 151
  offline unit tests drive the real `register()` against a fake plugin API with the Cortadel client
  stubbed, and check `examples/openclaw.json` with OpenClaw's own shipped validators — the manifest's
  `configSchema` through `validateJsonSchemaValue` (the call the loader itself makes) and the root
  `OpenClawSchema` — but the OpenClaw CLI never loads the package in CI, and no test touches a live
  Cortadel server. Test data uses `e2e-*` user ids throughout.

## Requirements

- **Node.js ≥ 22.22.3** — matching OpenClaw's own floor
  (`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`).
- **OpenClaw ≥ 2026.7.1** — declared as a peer dependency. Verified against `openclaw@2026.7.1-2`.
- **A running Cortadel server** — hosted at `https://app.cortadel.ai`, or self-hosted with
  `docker compose up` (→ `http://localhost:3001`). See [Self-hosting](../self-hosting.md) and
  [Authentication](../authentication.md).

## Links

- [`@cortadel/openclaw` on npm](https://www.npmjs.com/package/@cortadel/openclaw) — published at
  `0.1.0` with a Sigstore provenance attestation.
- [`integrations/openclaw`](https://github.com/cortadel/cortadel/tree/main/integrations/openclaw) —
  source, tests, and the annotated example config.
- [All integrations](../integrations.md) — the other eleven frameworks.
