/**
 * Automatic memory: the agent recalls and remembers without ever being asked.
 *
 * This is the `UserPromptSubmit` + `Stop` hook path. Nothing in the prompts
 * below mentions memory — the hooks do the work:
 *
 *   * before the model runs, `UserPromptSubmit` searches Cortadel with the
 *     submitted prompt and injects the hits as
 *     `hookSpecificOutput.additionalContext`;
 *   * after the turn ends, `Stop` reads the exchange back off the session
 *     transcript and hands it to `addConversation`, where Cortadel distils the
 *     durable facts. That write is awaited (`awaitPersist: true`, the default),
 *     so it is guaranteed to have landed before this script exits — which is
 *     exactly why turn 2 can find it.
 *
 * Run it twice. The first run has nothing to recall and stores the turn; the
 * second answers from memory, in a brand-new session.
 *
 *     npm install @cortadel/claude-agent-sdk @anthropic-ai/claude-agent-sdk zod
 *
 *     # A Cortadel server (self-hosted `docker compose up`, or https://app.cortadel.ai)
 *     export CORTADEL_URL=http://localhost:3001
 *     export CORTADEL_USER_ID=e2e-claude-agent-sdk-demo
 *     # export CORTADEL_API_KEY=...     # only if the server has auth enabled
 *
 *     npx tsx auto-memory.ts
 *
 * From a checkout of this repo instead, build first — the import below is a
 * package self-reference, so Node resolves it through `exports` to `dist/`:
 *
 *     pnpm build && pnpm dlx tsx examples/auto-memory.ts
 *
 * Requires the Claude Code CLI and Anthropic credentials, which the Claude
 * Agent SDK itself needs.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { CortadelMemory } from "@cortadel/claude-agent-sdk";

const PROMPTS = [
  // Turn 1 — states a durable preference. The Stop hook captures it.
  "For this project we standardise on four-space indentation and never use tabs. " +
    "Acknowledge that and tell me nothing else.",
  // Turn 2 — never restates the rule. The UserPromptSubmit hook supplies it.
  "What indentation should I use in this project?",
];

const userId = process.env.CORTADEL_USER_ID ?? "e2e-claude-agent-sdk-demo";

// One CortadelMemory per user: a Cortadel client is bound to one user id at
// construction, so the user id belongs here and never appears in a single call.
const memory = new CortadelMemory({
  baseUrl: process.env.CORTADEL_URL ?? "http://localhost:3001",
  userId,
  apiKey: process.env.CORTADEL_API_KEY || undefined,
  topK: 5,
  // Recall across sessions — that is why turn 2 answers in a fresh session.
  scopeRecallToSession: false,
  // throwOnError: false (the default) keeps the agent running when Cortadel is
  // down; the onError callback is how you find out that it was.
  throwOnError: false,
  onError: (error: unknown) => console.warn("[cortadel]", error),
});

// `{ tools: false }` keeps this example honest: no memory tools are offered, so
// anything the model recalls came from the hooks, not a deliberate tool call.
const options = memory.apply({ model: "claude-sonnet-4-5", maxTurns: 1 }, { tools: false });

for (const prompt of PROMPTS) {
  console.log(`\n>>> ${prompt}`);
  for await (const message of query({ prompt, options })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(`<<< ${message.result}`);
    }
  }
}

// Only needed if you set `awaitPersist: false`; harmless otherwise.
await memory.flush();

console.log(
  `\nRun this again: the second turn should answer from memory even in a fresh session. ` +
    `Everything is stored under user id "${userId}".`,
);
