/**
 * Cortadel × DeepAgents — quickstart.
 *
 * Two turns against one agent, showing the whole point of the integration: nothing in turn 2 tells
 * the agent what you said in turn 1, and it still knows.
 *
 * Prerequisites:
 *   1. A running Cortadel server — `docker compose up` (http://localhost:3001) or the hosted
 *      service at https://app.cortadel.ai.
 *   2. A model key for whichever provider you point `model` at, e.g. `ANTHROPIC_API_KEY`.
 *
 * Run it:
 *   pnpm add @cortadel/deepagents deepagents langchain @langchain/anthropic
 *   pnpm exec tsx examples/quickstart.ts
 */

import { createDeepAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";

import { createCortadelMemoryMiddleware } from "@cortadel/deepagents";

// One middleware instance gives you all three capabilities:
//   - `beforeAgent`   -> hybrid-search Cortadel once per turn
//   - `wrapModelCall` -> inject the hits into the system message for every model call in the turn
//   - `afterAgent`    -> `addConversation` the new messages once the turn ends
// plus the `search_memory` / `add_memories` tools the agent can call on its own.
const memory = createCortadelMemoryMiddleware({
  baseUrl: process.env.CORTADEL_BASE_URL ?? "http://localhost:3001",
  userId: "e2e-deepagents-quickstart",
  // apiKey: process.env.CORTADEL_API_KEY,   // omit when the server has auth disabled
  topK: 5,
  onError: (error) => console.error("[cortadel] memory degraded:", error),
});

const agent = createDeepAgent({
  model: "anthropic:claude-sonnet-4-5",
  systemPrompt: "You are a helpful engineering assistant.",
  middleware: [memory],
});

// Turn 1 — tell it something worth remembering. `afterAgent` persists the exchange.
const first = await agent.invoke({
  messages: [
    new HumanMessage(
      "I'm on the Project Alpha team and we only deploy on Tuesdays. Remember that.",
    ),
  ],
});
console.log("turn 1:", first.messages.at(-1)?.text);

// Turn 2 — a brand-new run with no shared state. `beforeAgent` recalls from Cortadel, so the
// answer knows about Tuesdays even though this invocation never mentions them.
const second = await agent.invoke({
  messages: [new HumanMessage("Can we ship the release tomorrow?")],
});
console.log("turn 2:", second.messages.at(-1)?.text);
