# Examples

Three ways in, from "click import" to "read the code".

## 1. `agent-with-cortadel-memory.json` — the standout setup

Import into n8n (**Workflows → ⋯ → Import from File**). It wires a Chat Trigger into an
AI Agent that has:

- **Cortadel Memory** on the agent's `Memory` port — recall before every model call,
  persist after every turn, automatically;
- the **Cortadel** node on the agent's `Tool` port — so the agent can also search and
  write memories deliberately, when it decides it needs to.

Before running, open both Cortadel nodes and pick your **Cortadel account** credential
(the JSON ships a `REPLACE_WITH_YOUR_CREDENTIAL_ID` placeholder), and attach whatever
chat model you use — the example references OpenAI, but nothing depends on that choice.

## 2. `ingest-and-search.json` — no agent required

A manual-trigger workflow that stores a two-turn conversation, waits for Cortadel's
off-request extraction pipeline to distil it, and then searches for what was learned.
Useful for confirming the credential and the server before you wire up an agent. It
writes under the disposable user id `e2e-n8n-quickstart`.

## 3. `memory-roundtrip.mjs` — the same code path, no n8n

Drives `CortadelChatMemory` and `createCortadelBackend` — the two modules the memory
sub-node composes in `supplyData()` — through a full turn against a live server:

```bash
cd integrations/n8n-nodes-cortadel
pnpm install && pnpm run build
CORTADEL_BASE_URL=http://localhost:3001 node examples/memory-roundtrip.mjs
```

It prints what got injected before the model call, what got persisted after it, and
demonstrates the duplicate-turn guard and the non-destructive `clear()`. Set
`CORTADEL_API_KEY` if your server has authentication enabled. It writes to the
disposable user id `e2e-n8n-memory-roundtrip`.
