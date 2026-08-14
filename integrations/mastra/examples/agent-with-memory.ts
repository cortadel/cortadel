/**
 * Cortadel × Mastra — end-to-end example.
 *
 * A single agent that:
 *   1. recalls long-term memory before every model call  (input processor)
 *   2. persists the finished turn afterwards             (output processor)
 *   3. can also search/write memory on its own initiative (tools)
 *
 * Run it:
 *   # a Cortadel server, e.g. `docker compose up` from the repo root
 *   export CORTADEL_BASE_URL=http://localhost:3001
 *   # and a model for Mastra's model router
 *   export OPENAI_API_KEY=sk-...
 *   pnpm dlx tsx examples/agent-with-memory.ts
 *
 * The second turn is the point of the example: it starts a brand-new thread,
 * so nothing is in Mastra's own conversation history — anything the agent knows
 * came out of Cortadel.
 */
import { Agent } from "@mastra/core/agent";

import { cortadelMemory } from "@cortadel/mastra";

// One Cortadel user id per person. A Cortadel client is bound to a single user
// id at construction, so the integration keeps one client per id behind the
// scenes; here the id comes from Mastra's own `resourceId`.
const USER = "e2e-mastra-example";

const memory = cortadelMemory({
  baseUrl: process.env.CORTADEL_BASE_URL ?? "http://localhost:3001",
  // apiKey: process.env.CORTADEL_API_KEY,  // omit when the server runs with auth disabled
  appName: "cortadel-mastra-example",
  topK: 5,
  // Log memory trouble instead of failing the run — memory always degrades softly.
  onError: (error, context) => console.error(`[memory:${context.operation}]`, error),
});

const agent = new Agent({
  id: "memory-demo",
  name: "memory-demo",
  instructions:
    "You are a helpful assistant with long-term memory. " +
    "When the user tells you something durable about themselves, save it with add_memories. " +
    "When a question might depend on something they told you before, search with search_memory.",
  model: "openai/gpt-5",
  tools: { ...memory.tools },
  // The SAME processor instance goes in both arrays: `processInput` recalls,
  // `processOutputResult` persists.
  inputProcessors: [memory.processor],
  outputProcessors: [memory.processor],
});

// --- Turn 1: teach it something. -------------------------------------------
const first = await agent.generate("I only ever ship to production on Tuesdays, never on a Friday.", {
  memory: { resource: USER, thread: "example-thread-1" },
});
console.log("turn 1:", first.text);

// The write happens inside `processOutputResult` above, which has already
// awaited by the time `generate` resolves. Cortadel's extraction pipeline runs
// asynchronously server-side, so give it a moment before reading back.
//
// If that write had failed, re-running this exact turn would write it: the
// processor's duplicate-turn latch is only made permanent once the write has
// actually landed, so a retry is a real re-attempt and not a silent no-op.
// (Re-running a turn that *did* land is still skipped.)
await new Promise((resolve) => setTimeout(resolve, 3000));

// --- Turn 2: a fresh thread, so only Cortadel can supply the answer. --------
const second = await agent.generate("Can we cut a release this Friday?", {
  memory: { resource: USER, thread: "example-thread-2" },
});
console.log("turn 2:", second.text);

// --- Direct access, without the agent, using the same pool. -----------------
const hits = await memory.pool.get(USER).search("release schedule", { topK: 3 });
for (const hit of hits.results) {
  console.log(`- ${hit.content}  (rrf ${hit.rrfScore ?? "n/a"})`);
}
