# Cortadel × n8n

`n8n-nodes-cortadel` is a community node package that gives n8n workflows long-term memory. It
ships two nodes. A **Cortadel Memory** sub-node plugs into the AI Agent's `Memory` port and, on
every turn, runs a fresh hybrid BM25 + vector search across everything Cortadel knows about that
*user*, injects the hits, and hands the finished turn back to Cortadel's extraction pipeline to be
distilled into durable facts. A **Cortadel** action node exposes the six public REST operations as
an ordinary main-in/main-out step and — because it declares `usableAsTool` — as a tool the agent
can call on purpose. n8n's built-in memories are chat buffers: the last N turns of the current
session, gone when the session is. This one accumulates against a user identity and outlives the
conversation.

## Install

In n8n: **Settings → Community nodes → Install**, then enter the package name:

```
n8n-nodes-cortadel
```

For a self-hosted instance you can install from the command line in your n8n custom-nodes
directory instead:

```bash
npm install n8n-nodes-cortadel
```

The package is published on npm at `0.1.0` with a Sigstore provenance attestation, and ships
**zero run-time dependencies** — its `package.json` has no `dependencies` block at all, only
`n8n-workflow` as a peer. That is not minimalism for its own sake: n8n's verified-community-node
rules forbid run-time dependencies, so the package talks to the same REST contract
`@cortadel/sdk` is generated from rather than bundling the SDK.

## Quickstart

**1. Create the credential.** Add a **Cortadel API** credential. Set **Base URL** to
`https://app.cortadel.ai` (hosted) or `http://localhost:3001` (self-hosted). Set **API Key** if
your server has auth enabled; leave it blank if it does not — a blank key omits the
`Authorization` header entirely rather than sending an empty one. Hit **Test**: it calls
`GET /api/health`.

**2. Paste this workflow onto the n8n canvas** (Ctrl/Cmd-V works directly on the canvas, or use
**Workflows → ⋯ → Import from File**):

```json
{
  "name": "Cortadel — agent with long-term memory",
  "nodes": [
    {
      "parameters": {},
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "When chat message received",
      "type": "@n8n/n8n-nodes-langchain.chatTrigger",
      "typeVersion": 1.1,
      "position": [-260, 0],
      "webhookId": "22222222-2222-4222-8222-222222222222"
    },
    {
      "parameters": {
        "options": {
          "systemMessage": "You are a helpful assistant. Facts recalled from Cortadel are background knowledge about the user; use them when relevant and never repeat them back verbatim unless asked."
        }
      },
      "id": "33333333-3333-4333-8333-333333333333",
      "name": "AI Agent",
      "type": "@n8n/n8n-nodes-langchain.agent",
      "typeVersion": 2,
      "position": [40, 0]
    },
    {
      "parameters": { "model": "gpt-4o-mini", "options": {} },
      "id": "44444444-4444-4444-8444-444444444444",
      "name": "OpenAI Chat Model",
      "type": "@n8n/n8n-nodes-langchain.lmChatOpenAi",
      "typeVersion": 1,
      "position": [-60, 220]
    },
    {
      "parameters": {
        "userId": "={{ $json.userId ?? $json.sessionId }}",
        "sessionId": "={{ $json.sessionId }}",
        "scopeRecallToSession": false,
        "topK": 5,
        "options": {
          "contextFormat": "block",
          "contextRole": "user",
          "persistTurns": true,
          "tags": "n8n,chat"
        }
      },
      "id": "55555555-5555-4555-8555-555555555555",
      "name": "Cortadel Memory",
      "type": "n8n-nodes-cortadel.cortadelMemory",
      "typeVersion": 1,
      "position": [100, 220],
      "credentials": {
        "cortadelApi": { "id": "REPLACE_WITH_YOUR_CREDENTIAL_ID", "name": "Cortadel account" }
      }
    },
    {
      "parameters": {
        "resource": "memory",
        "operation": "search",
        "userId": "={{ $json.userId ?? $json.sessionId }}",
        "query": "={{ $fromAI('query', 'What to look up in the user long-term memory', 'string') }}",
        "simplify": true,
        "searchOptions": { "topK": 8 }
      },
      "id": "66666666-6666-4666-8666-666666666666",
      "name": "Cortadel",
      "type": "n8n-nodes-cortadel.cortadelTool",
      "typeVersion": 1,
      "position": [280, 220],
      "credentials": {
        "cortadelApi": { "id": "REPLACE_WITH_YOUR_CREDENTIAL_ID", "name": "Cortadel account" }
      }
    }
  ],
  "connections": {
    "When chat message received": {
      "main": [[{ "node": "AI Agent", "type": "main", "index": 0 }]]
    },
    "OpenAI Chat Model": {
      "ai_languageModel": [[{ "node": "AI Agent", "type": "ai_languageModel", "index": 0 }]]
    },
    "Cortadel Memory": {
      "ai_memory": [[{ "node": "AI Agent", "type": "ai_memory", "index": 0 }]]
    },
    "Cortadel": {
      "ai_tool": [[{ "node": "AI Agent", "type": "ai_tool", "index": 0 }]]
    }
  },
  "pinData": {},
  "settings": { "executionOrder": "v1" }
}
```

**3. Fix the two placeholders.** Open both Cortadel nodes and pick the credential you just made
(the JSON carries a `REPLACE_WITH_YOUR_CREDENTIAL_ID` placeholder), then attach a credential to
the chat model. Nothing here depends on OpenAI — swap in any chat model node you already use.

**4. Chat.** Tell the agent something about yourself, start a brand-new session, and ask about it.
A chat buffer has forgotten. Cortadel has not.

The package ships this workflow as `examples/agent-with-cortadel-memory.json`, plus
`examples/ingest-and-search.json` — a manual-trigger workflow with no agent at all that stores a
transcript, waits for extraction, and searches for what was learned under the disposable user id
`e2e-n8n-quickstart`.

## What you get

### The automatic-memory seam — `Cortadel Memory`

A sub-node with **no main input** and a single `ai_memory` output named `Memory`, so it drops onto
the AI Agent's Memory port exactly like Simple Memory or Postgres Chat Memory. It files itself
under **AI → Memory → External memories** in the nodes panel. On every turn it:

- **before the model call** — searches `POST /api/v1/memories/search` with the current turn text
  and injects the hits as context (one user-role block by default, or one message per fact);
- **after the turn** — posts the exchange to `POST /api/v1/memories/from-conversation`, where
  Cortadel's pipeline distils it into facts, deduplicates against what it already knows, and
  supersedes anything the turn contradicts.

The agent does not have to cooperate, or even know.

### The tools — `Cortadel`

A main-in/main-out node with `usableAsTool: true`, which makes n8n generate a tool variant
(`n8n-nodes-cortadel.cortadelTool`) connectable to the agent's `ai_tool` port. One resource,
`Memory`, with six operations mapping one-to-one onto the public REST contract:

| Operation | Wire call | What it does |
|---|---|---|
| **Add** (`add`) | `POST /api/v1/memories` | Store one piece of text |
| **Add Conversation** (`addConversation`) | `POST /api/v1/memories/from-conversation` | Distil facts out of a transcript |
| **Search** (`search`) | `POST /api/v1/memories/search` | Hybrid BM25 + vector retrieval |
| **List** (`list`) | `GET /api/v1/memories` | Page through stored memories |
| **Get** (`get`) | `GET /api/v1/memories/{id}` | One memory with its bi-temporal validity window |
| **Delete** (`delete`) | `DELETE /api/v1/memories` | Delete one or more memories by id |

> **Canon deviation — the tools are not called `search_memory` and `add_memories`.** Every other
> Cortadel integration names its two memory tools that way. n8n derives an agent-facing tool name
> from the node's *workflow name* and gives operations no naming hook at all, so there is nothing
> to name: the equivalents are the `search` and `add` / `addConversation` operations on one node.
> Rename the node on the canvas and you have renamed the tool.

## Configuration

### Credential — `Cortadel API`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | string, required | `http://localhost:3001` | Origin of your Cortadel server; `https://app.cortadel.ai` for the hosted service. Trailing slashes are stripped, and a blank value falls back to the same default. |
| `apiKey` | string (password) | *(empty)* | Sent as `Authorization: Bearer <key>`. Optional: a self-hosted server with an empty auth secret leaves every endpoint open. When blank the header is **omitted entirely** rather than sent empty, because some reverse proxies reject an empty `Authorization` value outright. |

The credential test is `GET /api/health`. Cortadel answers **503** with a health body when a
dependency is degraded, so the test reports failure against a reachable-but-degraded server —
that is a server-health signal, not necessarily a bad key.

### `Cortadel Memory` sub-node

The first four are top-level fields on the node; everything below `contextFormat` lives inside the
**Options** collection (click *Add Option*).

| Option | Type | Default | Meaning |
|---|---|---|---|
| `userId` | string, required | `={{ $json.userId ?? $json.sessionId }}` | The Cortadel user that owns these memories. Blank or whitespace throws at wiring time. |
| `sessionId` | string, required | `={{ $json.sessionId }}` | Groups the facts this conversation produces. Blank or whitespace throws at wiring time. |
| `scopeRecallToSession` | boolean | `false` | Restrict recall to facts stored under this session id instead of the whole user graph. Writes carry the session id either way. |
| `topK` | number, 1–50 | `5` | Max memories injected per turn. Clamped into range, so a stored workflow with an out-of-range value still runs. |
| `contextFormat` | `block` \| `messages` | `block` | One message listing every recalled fact, or one message each. |
| `contextHeader` | string | *(empty → built-in sentence)* | Overrides the line above the facts in `block` format. The built-in is "Relevant long-term memories recalled from Cortadel. Treat them as background knowledge about the user, not as things the user just said." |
| `contextRole` | `system` \| `user` | `user` | Role the recalled context is injected under. `system` is opt-in and **throws on the Anthropic Chat Model** — see [Known limits](#known-limits). |
| `inputKey` | string | `input` | Key holding the user's turn in the values LangChain passes in. |
| `memoryKey` | string | `chat_history` | Prompt variable the context is written to. Ignored on the agent's streaming branch — see [Known limits](#known-limits). |
| `memoryType` | `''` \| `episodic` \| `procedural` \| `semantic` | `''` (Any) | Restrict recall to one cognitive type. The blank is dropped from the request rather than sent. |
| `outputKey` | string | `output` | Key holding the model's turn in the values LangChain passes in. |
| `persistTurns` | boolean | `true` | Send each finished turn for fact extraction. Turn off for read-only memory — nothing is written, and no HTTP call is made. |
| `project` | string | *(unset)* | Project scope recorded on facts extracted from this conversation. |
| `recallCacheTtlMs` | number, ≥ 0 | `15000` | How long an identical recall query is served from a local, case-insensitive cache (bounded at 32 entries). `0` disables it. |
| `rerank` | boolean | `false` | Send `rerank: "cross_encoder"`, the only strategy the contract accepts. Also enables the graph and session arms. |
| `returnMessages` | boolean | `true` | Hand the agent message objects rather than one rendered string. |
| `mode` (**Search Mode**) | `hybrid` \| `text` \| `vector` | `hybrid` | Which retrieval arms to fuse when recalling. |
| `tags` | string (CSV) | *(unset)* | Comma-separated tags applied to every fact stored from this chat. |

### `Cortadel` action node

`userId` is required on every operation and is trimmed before use; blank fails the item.

| Operation | Required parameters | Options (with defaults) |
|---|---|---|
| **Add** | `text` | `app` (defaults to `n8n-nodes-cortadel`), `infer` (`true`), `memoryType` (Any), `metadata` (JSON — an untouched `{}` is dropped, not sent) |
| **Add Conversation** | `inputMode` (`fields` \| `json`) and at least one non-empty turn | `isAgentMemory` (`false`), `project`, `sessionId`, `tags` (CSV) |
| **Search** | `query` | `simplify` (`true` — one item per hit instead of the raw `{query, results, total}` envelope), `topK` (`10`), `mode` (`hybrid`), `rerank` (`false`), `sessionId`, `memoryType` (Any) |
| **List** | — | `returnAll` (`false`), `limit` (`20`, max 100, shown only when Return All is off), `page` (`1`), `appId`, `categories`, `searchQuery`, `includeSuperseded` (`false`), `memoryType` (Any) |
| **Get** | `memoryId` | — |
| **Delete** | `memoryIds` (comma-separated) | — |

`Return All` walks the list route 100 rows at a time until the reported page count is reached,
with a 1,000-iteration guard against a server that reports paging inconsistently.

### What Cortadel records as the app

Both nodes identify themselves as `n8n-nodes-cortadel` — this package's published npm name, the
same convention every Cortadel integration follows, pinned by a test against `package.json`. It is
sent as `app_name` on every search (recorded for access logging) and as `app` on the **Add**
operation's write, where the operation's own `app` field overrides it. There is no option for it
on the memory sub-node: a workflow author has no reason to misreport which node wrote a memory.

> **Canon deviations, and why.** Node parameters are JSON values set in a UI, so this package
> cannot accept a function: there is **no `onError` callback** and **no `throwOnError`**. Memory
> failures always degrade and are warned through n8n's own node logger, prefixed
> `[Cortadel Memory]`. There is also **no `awaitPersist`** — writes are unconditionally awaited
> inside the turn, because n8n treats the execution as over the moment the workflow ends, so a
> write still in flight has no execution left to report into, and in queue mode the worker that
> owns it can be reaped first. `topK` (`5` for automatic recall, `10` for the explicit Search
> operation), `scopeRecallToSession` (`false`) and the app name all match the repo-wide canon.

## How it works

**The extension point is `INodeType.supplyData()` on a node whose only output is
`NodeConnectionTypes.AiMemory`.** That is n8n's sub-node seam: a node declaring `inputs: []` and
`outputs: [NodeConnectionTypes.AiMemory]` gets a connector that the AI Agent's Memory port
accepts, and instead of `execute()` it implements
`supplyData(this: ISupplyDataFunctions, itemIndex): Promise<SupplyData>`, returning
`{ response: <the memory object> }`. n8n hands that object to the agent, which drives it as
LangChain memory. The node has no `execute` method at all — a test asserts it is `undefined`.

The object handed back is `CortadelChatMemory`, structurally typed against LangChain's
`BaseMemory` surface rather than extending it (again: zero run-time dependencies). It implements:

- `memoryKeys` — the prompt variables it fills;
- `loadMemoryVariables(values)` — reads the turn from `values[inputKey]`, searches Cortadel, and
  returns `{ [memoryKey]: messages | string }`;
- `saveContext(inputValues, outputValues)` — posts the pair to `from-conversation`;
- `clear()` — drops the local cache and nothing else;
- a `chatHistory` facade (`getMessages`, `addMessage`, `addUserMessage`, `addAIChatMessage`,
  `clear`) for the n8n and LangChain paths that reach past `loadMemoryVariables`/`saveContext`.
  Its writes funnel into the same fingerprinted persist path, so nothing is stored twice.

Three deliberate behaviours sit on top:

- **It degrades, it does not break.** Every Cortadel call is wrapped. A failed recall yields empty
  context and a logged warning; a failed persist is swallowed the same way. There is deliberately
  no "fail hard" switch — and the default `contextRole` is chosen by the same rule (below).
- **It does not re-search or re-store the same thing.** Identical recall queries inside one turn
  are served from a short-lived local cache, so an agent's tool loop cannot hammer the server. An
  identical `(input, output)` pair is never written twice **by the same node instance**: the last
  64 pairs are held in a FIFO-evicted set, so an `A → B → A` tool loop is suppressed too, not just
  consecutive repeats. Duplicate hits are collapsed by memory id and by exact text before
  injection. Because n8n builds a fresh node instance per execution, these are within-execution
  guards; Cortadel's own server-side deduplication is the backstop across executions.
- **`clear()` deletes nothing.** Clearing an n8n chat window drops the local recall cache and the
  fingerprint set. Long-term memory is not something a UI button should be able to wipe — use the
  Cortadel node's **Delete** operation, explicitly. A test asserts the memory surface exposes no
  method named `delete`, `deleteMemories`, `forget` or `purge` at all.

Four smaller seams are worth naming, because each is the reason something behaves the way it does:

- **`usableAsTool: true`** on the action node's `INodeTypeDescription`. n8n derives a `…Tool` node
  type from it, which is why the quickstart workflow references `n8n-nodes-cortadel.cortadelTool`
  and wires it to `ai_tool`.
- **`ISupplyDataFunctions.addInputData` / `addOutputData`**, called with
  `NodeConnectionTypes.AiMemory` around every recall and persist, so each shows up as a sub-node
  run in the n8n UI with a `{ action, recalled }` or `{ action, stored, noFactsExtracted }`
  summary. The built-in memories get this from `logWrapper` in `@n8n/ai-utilities`, which is
  internal to the n8n monorepo and unavailable to a community package. The hand-rolled tracer
  swallows its own failures — an older n8n whose helpers throw still runs the memory fine.
- **`this.helpers.httpRequestWithAuthentication`**, the single choke point for every HTTP call.
  Not a bundled client: this helper is what applies the credential's `authenticate` block along
  with the instance's proxy and TLS configuration. Failures that are not already a `NodeApiError`
  are wrapped into one carrying the method and full URL.
- **`ICredentialType.authenticate` in its function form**, not the declarative
  `IAuthenticateGeneric`. The declarative form can only ever *set* a header, so a blank key would
  put an empty `Authorization` on every request; the function form can omit it.

Message objects are the last wrinkle. n8n's built-in memory nodes import LangChain's
`HumanMessage` / `AIMessage` / `SystemMessage` directly; this package cannot. It resolves the
host's own `@langchain/core/messages` at run time through a dynamic `import()` — present in any
n8n instance with the AI nodes — and falls back to a dependency-free shim when it is not. The shim
has to carry the full field set, not just `content` + `_getType()`: LangChain's
`coerceMessageLikeToMessage()` treats anything with a `_getType` function as already-a-message and
returns it **uncoerced**, so a shim reaches the provider's converter verbatim, and those
converters read `response_metadata` and `additional_kwargs` without a guard.

## Known limits

- **The AI Agent's streaming path cannot pass the query.** n8n's agent has two execution branches.
  On the non-streaming one, LangChain's `BaseChain._formatValues` passes the real turn inputs to
  `loadMemoryVariables(values)` and you get the per-turn hybrid search this node is built for. On
  the **streaming** branch (chat trigger with response streaming on, agent node type version
  ≥ 2.1), n8n calls `memory.loadMemoryVariables({})` with a literally empty object and
  `AgentExecutor`'s stream iterator never re-runs `_formatValues`. No query text reaches the node,
  so recall degrades to the **most recent `Top K` memories** via `GET /api/v1/memories` instead of
  a search. Nothing in a memory sub-node can recover the input — it is simply not passed. The same
  code path hardcodes `'chat_history'` when reading the returned variables, so **`memoryKey` only
  takes effect on the non-streaming branch**. If per-turn relevance matters more to you than
  token-by-token streaming, turn streaming off on the AI Agent node. Persisting is unaffected:
  `saveContext` receives the real input and output on both branches.
- **`contextRole: system` throws on Anthropic — which is why it is not the default.** Anthropic's
  API takes a single `system` field, so `@langchain/anthropic` lifts `messages[0]` into it and
  throws `System messages are only permitted as the first passed message.` for any later one.
  n8n's agent prompt is `[system?, ...chat_history, human]`, so anything a memory node puts in
  `chat_history` sits at index ≥ 1 as soon as the agent's own **System Message** option is set —
  and `Context Format: One Message Per Fact` produces several regardless. Both cases throw. The
  default is therefore `user`, the one role no provider can reject; opt into `system` only on
  OpenAI-style models (OpenAI, Azure OpenAI, Groq, Ollama, most OpenAI-compatible gateways), where
  it carries instruction-level weight instead of sitting in the dialogue.
- **Turns shorter than three characters never search.** Recall falls back to the recent-memories
  list below that threshold, and the threshold is not exposed as a node option.
- **The dedupe and cache guards are per node instance.** n8n builds a fresh instance per
  execution, so a repeated turn across two executions — or across two workers in queue mode — is
  written twice at this layer and left to Cortadel's server-side deduplication.
- **`Get` surfaces a 404 as a node error**, unlike the Cortadel SDKs, where `client.get()` returns
  `null` / `None` for an unknown id. That is the n8n convention — a failed lookup should colour the
  node red — and **Settings → On Error → Continue** turns it back into a data row if you prefer
  the SDK behaviour. This particular divergence is documented rather than pinned by a test.
- **No `throwOnError`, no `onError`, no `awaitPersist`** — see the canon note under
  [Configuration](#configuration). The first two are unrepresentable in n8n's JSON parameters; the
  third is fixed to "always await" by n8n's execution lifecycle.
- **`clear()` is not a delete.** If you expected clearing the chat to wipe memory, it does not.
- **Nothing is exercised against a live Cortadel server in CI.** The test suite is fully offline:
  every HTTP call is stubbed at n8n's `httpRequestWithAuthentication` boundary, all test data uses
  `e2e-*` user ids, and the `@langchain/*` packages are devDependencies present only so the
  message-compatibility suite can assert against the real classes and the real provider
  converters. Wire-level behaviour rests on the [SDKs](../sdk-typescript.md) and their own
  conformance suites.

## Requirements

- **n8n with the AI nodes available** — the `ai_memory` port only exists on the AI Agent node. The
  package peers `n8n-workflow` at `*` and is verified against **2.16.0**; it uses
  `NodeConnectionTypes.AiMemory` and `usableAsTool`, both long-standing in current n8n.
- **Node.js ≥ 20.**
- **A running Cortadel server** — the hosted service at `https://app.cortadel.ai`, or your own
  (`docker compose up` → `http://localhost:3001`, see [Self-hosting](../self-hosting.md)).

## Links

- Package on npm: <https://www.npmjs.com/package/n8n-nodes-cortadel>
- Source: [`integrations/n8n-nodes-cortadel`](https://github.com/cortadel/cortadel/tree/main/integrations/n8n-nodes-cortadel)
- Back to [Integrations](../integrations.md)
