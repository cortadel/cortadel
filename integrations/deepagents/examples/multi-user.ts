/**
 * Cortadel × DeepAgents — one agent, many users.
 *
 * A Cortadel client is bound to a single `userId` at construction: no SDK method takes a user id.
 * So per-user scoping means *one client per user*, and the middleware resolves which one to use
 * from the run itself.
 *
 * It looks in two places, in this order:
 *   1. `runtime.context[userIdKey]`      — set by `agent.invoke(input, { context: { user_id } })`
 *   2. `runtime.configurable[userIdKey]` — set by `agent.invoke(input, { configurable: { user_id } })`,
 *                                          which is what LangGraph Platform and Studio populate.
 *
 * For (1) to arrive at all, the middleware declares `userIdKey` on its own `contextSchema`:
 * LangChain hands a middleware only the context keys it declared, and an undeclared one is silently
 * dropped. Nothing is required of you here beyond passing the id.
 *
 * Clients are built lazily and cached, so a long-lived server keeps one connection pool per user
 * rather than one per request.
 *
 * Run it:
 *   pnpm exec tsx examples/multi-user.ts
 */

import { createDeepAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import { createCortadelMemoryMiddleware } from "@cortadel/deepagents";

// Leave `userId` unset — that is what puts the middleware in multi-user mode. Every run must then
// carry an id, or memory quietly sits out that run (with a one-time warning).
const memory = createCortadelMemoryMiddleware({
  baseUrl: process.env.CORTADEL_BASE_URL ?? "http://localhost:3001",
  // userIdKey: "user_id",   // rename if your runs carry the id under a different key
});

const agent = createDeepAgent({
  model: "anthropic:claude-sonnet-4-5",
  // Optional: this types and validates `{ context: { user_id } }` at the `invoke` call. The
  // middleware declares the key on its own `contextSchema` too — which is what actually makes the
  // value reach it, since LangChain filters a middleware's `runtime.context` down to the keys that
  // middleware declared — so per-user scoping works with or without this line.
  contextSchema: z.object({ user_id: z.string() }),
  middleware: [memory],
});

// Alice's memories are stored and recalled under `e2e-alice` …
const alice = await agent.invoke(
  { messages: [new HumanMessage("I prefer TypeScript over Python for new services.")] },
  { context: { user_id: "e2e-alice" } },
);
console.log("alice:", alice.messages.at(-1)?.text);

// … and Bob's under `e2e-bob`. Neither can see the other's memory: Cortadel anchors every read and
// write to the user node, so isolation is enforced by the store, not by our filtering.
const bob = await agent.invoke(
  { messages: [new HumanMessage("What language should I use for the new service?")] },
  { context: { user_id: "e2e-bob" } },
);
console.log("bob:", bob.messages.at(-1)?.text);

// The same works through `configurable`, which is what LangGraph Platform sends:
const viaConfigurable = await agent.invoke(
  { messages: [new HumanMessage("Remind me what I said about languages.")] },
  { context: { user_id: "e2e-alice" }, configurable: { thread_id: "e2e-alice-thread-1" } },
);
console.log("alice again:", viaConfigurable.messages.at(-1)?.text);
