/**
 * Explicit memory: the model decides when to read and write.
 *
 * The middleware in `chat-with-memory.ts` recalls on every turn whether the model wants it or not.
 * Tools are the other half — the agent calls `search_memory` when it notices it is missing
 * context, and `add_memories` when it hears something worth keeping. Use tools when you want the
 * agent in control, the middleware when you want memory to be invisible, or both together.
 *
 * Run it:
 *
 *   1. Start a Cortadel server:  docker compose up          (→ http://localhost:3001)
 *   2. pnpm add @ai-sdk/openai && export OPENAI_API_KEY=...
 *   3. pnpm exec tsx examples/memory-tools.ts
 */
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";

import { cortadelTools } from "@cortadel/vercel-ai-provider";

// A tool set is bound to one user id, because a Cortadel client is. That is the safety property:
// the user id is not part of any tool's input schema, so no instruction hidden in a document can
// talk the model into reading somebody else's memories. For a multi-tenant server, build one of
// these per request — it is a plain object literal.
const tools = cortadelTools({
  baseUrl: process.env.CORTADEL_BASE_URL ?? "http://localhost:3001",
  userId: "e2e-vercel-ai-tools-demo",
  apiKey: process.env.CORTADEL_API_KEY,

  search: { topK: 5 },
  add: { app: "vercel-ai-demo" },

  onError: (error, { phase }) => console.warn(`[cortadel] ${phase} failed:`, error),
});

// --- The agent stores what it just learned. ------------------------------------------------
const stored = await generateText({
  model: openai("gpt-4.1-mini"),
  tools,
  // Tool calls only advance the conversation if the loop is allowed more than one step.
  stopWhen: stepCountIs(5),
  system:
    "You are an assistant with long-term memory. When the user tells you something that will " +
    "still matter in a future conversation, store it. Search your memory before answering " +
    "anything that depends on what you were told before.",
  prompt: "I've moved the team's standup to 10:15 and we're dropping the Wednesday one entirely.",
});

console.log("stored:", stored.text);
console.log(
  "tool calls:",
  stored.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
);

// --- The agent recalls it, in a run that shares no message history with the one above. ------
const recalled = await generateText({
  model: openai("gpt-4.1-mini"),
  tools,
  stopWhen: stepCountIs(5),
  system: "Search your memory before answering questions about the user's schedule.",
  prompt: "When is standup?",
});

console.log("recalled:", recalled.text);
