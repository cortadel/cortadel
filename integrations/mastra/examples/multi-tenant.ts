/**
 * Cortadel × Mastra — one agent, many users.
 *
 * A Cortadel client is bound to one user id at construction, so multi-user
 * scoping means one client per user. `cortadelMemory` does that for you: it
 * pools clients keyed by the id it resolves for each run.
 *
 * Resolution order, highest first:
 *   1. `resolveUserId(scope)`   — full control, shown below
 *   2. `userId`                 — pin every run to one id (single-user scripts)
 *   3. Mastra's `resourceId`    — the default, and usually the right answer
 *
 * Run it:
 *   export CORTADEL_BASE_URL=http://localhost:3001
 *   export OPENAI_API_KEY=sk-...
 *   pnpm dlx tsx examples/multi-tenant.ts
 */
import { Agent } from "@mastra/core/agent";

import { cortadelMemory } from "@cortadel/mastra";

const memory = cortadelMemory({
  baseUrl: process.env.CORTADEL_BASE_URL ?? "http://localhost:3001",
  // Namespace every tenant's memories so two customers with a user called
  // "alice" never share a graph.
  resolveUserId: (scope) => (scope.resourceId ? `e2e-mastra-acme:${scope.resourceId}` : undefined),
  // Don't let a slow memory server add latency to a user-facing turn.
  recallTimeoutMs: 2_000,
  // Fire-and-forget: safe here because this is a long-lived server, not a
  // serverless isolate that can be frozen the moment the response is returned.
  // A failed write is reported to `onError` after the turn has already
  // returned, so nobody can retry *that* turn — but it does not leave the turn
  // marked as persisted, so the next identical one is written rather than
  // skipped as a duplicate.
  awaitPersist: false,
});

const agent = new Agent({
  id: "support",
  name: "support",
  instructions: "You are a support agent. Be concise.",
  model: "openai/gpt-5",
  tools: { ...memory.tools },
  inputProcessors: [memory.processor],
  outputProcessors: [memory.processor],
});

// Two different people, one agent. `resource` is what separates their memory —
// note that Mastra only propagates `resource` alongside a `thread`, so always
// pass both (or pin `userId`).
for (const user of ["e2e-alice", "e2e-bob"]) {
  const result = await agent.generate("Remind me what I asked you last time.", {
    memory: { resource: user, thread: `${user}-thread-1` },
  });
  console.log(`${user}:`, result.text);
}

// One pooled Cortadel client per resolved user id.
console.log("pooled clients:", memory.pool.size); // → 2
