/**
 * End-to-end walkthrough of the Cortadel × OpenClaw plugin — without OpenClaw.
 *
 * The plugin's whole contract with its host is `register(api)`: it registers
 * tools, a memory corpus, and a few hooks onto whatever object it is handed.
 * So this script hands it a ~30-line stand-in for OpenClaw's plugin API, then
 * drives a realistic conversation through the exact code paths the real gateway
 * would drive:
 *
 *   turn 1  capture   — llm_output            → Cortadel distils durable facts
 *   turn 2  recall    — before_prompt_build   → matching memories are injected
 *   turn 2  tool call — cortadel_search_memory→ the agent queries memory itself
 *   turn 2  corpus    — memory_search         → the same memories via OpenClaw's own tool
 *
 * This talks to a REAL Cortadel server. Point it at one first:
 *
 *   docker compose up                 # from the cortadel repo root → :3001
 *   pnpm build && node examples/local-turn.mjs
 *
 *   # or the hosted service:
 *   CORTADEL_BASE_URL=https://app.cortadel.ai CORTADEL_API_KEY=... node examples/local-turn.mjs
 *
 * With no server reachable it still runs to completion — demonstrating the
 * other half of the design: memory degrades, the agent keeps going.
 */

import { register } from "../dist/index.js";

const BASE_URL = process.env.CORTADEL_BASE_URL ?? "http://localhost:3001";
// `e2e-` marks this as disposable test data, per the Cortadel project convention.
const USER_ID = process.env.CORTADEL_USER_ID ?? "e2e-openclaw-example";
const SESSION_KEY = "assistant:example:1";

/** A minimal stand-in for OpenClawPluginApi: capture whatever the plugin registers. */
function createFakeHost(config) {
  const host = { hooks: new Map(), tools: [], corpus: undefined, promptSection: undefined };
  const log = (level) => (message) => console.log(`  [${level}] ${message}`);

  const api = {
    id: "cortadel",
    name: "Cortadel Memory",
    pluginConfig: config,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    // OpenClaw calls the factory with the active turn's context.
    registerTool: (factory) => {
      host.tools = factory({ sessionKey: SESSION_KEY, agentId: "assistant" });
    },
    registerMemoryCorpusSupplement: (supplement) => {
      host.corpus = supplement;
    },
    registerMemoryPromptSupplement: (builder) => {
      host.promptSection = builder;
    },
    on: (hookName, handler) => host.hooks.set(hookName, handler),
  };

  register(api);
  return host;
}

const heading = (text) => console.log(`\n${"─".repeat(72)}\n${text}\n${"─".repeat(72)}`);

async function main() {
  heading(`1. Load the plugin (Cortadel at ${BASE_URL} as ${USER_ID})`);

  const host = createFakeHost({
    baseUrl: BASE_URL,
    apiKey: process.env.CORTADEL_API_KEY,
    userId: USER_ID,
    recallScope: "fixed",
    topK: 5,
    // Short budget so an unreachable server fails fast in this demo.
    timeoutMs: 8000,
    tags: ["openclaw-example"],
  });

  console.log(`\n  tools registered : ${host.tools.map((t) => t.name).join(", ")}`);
  console.log(`  hooks registered : ${[...host.hooks.keys()].join(", ")}`);
  console.log(`  memory corpus    : ${host.corpus ? "registered (additive)" : "disabled"}`);
  console.log("\n  System-prompt section the model sees:");
  for (const line of host.promptSection({ availableTools: new Set(host.tools.map((t) => t.name)) })) {
    console.log(`    · ${line}`);
  }

  // ── Turn 1: the user states something durable. -----------------------------
  heading("2. Turn 1 — capture (llm_output)");

  const turnOne = {
    runId: "run-1",
    sessionId: SESSION_KEY,
    provider: "example",
    model: "example-model",
    prompt: "Remember that I deploy on Fridays and I always use Postgres, never MySQL.",
    assistantTexts: ["Got it — Friday deploys, Postgres over MySQL."],
  };
  console.log(`  user      : ${turnOne.prompt}`);
  console.log(`  assistant : ${turnOne.assistantTexts[0]}`);
  console.log("\n  → handing the turn to Cortadel to distil facts from:");
  await host.hooks.get("llm_output")(turnOne, { sessionKey: SESSION_KEY, agentId: "assistant" });

  // Extraction runs off the request path, so give it a moment to land.
  console.log("\n  (waiting 3s for Cortadel's extraction pipeline)");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // ── Turn 2: a later question that should recall those facts. ---------------
  heading("3. Turn 2 — automatic recall (before_prompt_build)");

  const question = "Which database should I use for the new service, and when can I ship it?";
  console.log(`  user : ${question}\n`);

  const recalled = await host.hooks.get("before_prompt_build")(
    { prompt: question, messages: [] },
    { sessionKey: SESSION_KEY, agentId: "assistant" },
  );

  if (recalled?.prependContext) {
    console.log("  → prepended to the turn context:\n");
    console.log(recalled.prependContext.replace(/^/gm, "    "));
  } else {
    console.log("  → nothing injected (no server, no matches, or already injected this session).");
  }

  // ── The same memories, reached deliberately by the agent. ------------------
  heading("4. Turn 2 — the agent calls cortadel_search_memory itself");

  const searchTool = host.tools.find((t) => t.name === "cortadel_search_memory");
  const searchResult = await searchTool.execute("example-call-1", { query: "database preference", topK: 3 });
  console.log(`  ${searchResult.content[0].text.replace(/\n/g, "\n  ")}`);

  // ── And through OpenClaw's own memory tool. --------------------------------
  heading("5. The same memories through OpenClaw's built-in memory_search");

  const rows = await host.corpus.search({ query: "deployment schedule", maxResults: 3, agentSessionKey: SESSION_KEY });
  if (rows.length === 0) {
    console.log("  (no rows — Cortadel unreachable or nothing stored yet)");
  } else {
    for (const row of rows) {
      console.log(`  [${row.corpus}] ${row.path}  score=${row.score.toFixed(4)}`);
      console.log(`      ${row.snippet}`);
    }
    // Every row is addressable, so the agent can read one back in full.
    const full = await host.corpus.get({ lookup: rows[0].path, agentSessionKey: SESSION_KEY });
    if (full) console.log(`\n  memory_get(${rows[0].path}):\n      ${full.content}`);
  }

  // ── Recall dedupe: the same question again injects nothing new. ------------
  heading("6. Ask again — recall does not repeat itself");

  const again = await host.hooks.get("before_prompt_build")(
    { prompt: question, messages: [] },
    { sessionKey: SESSION_KEY, agentId: "assistant" },
  );
  console.log(
    again?.prependContext
      ? "  → injected new memories (different hits than last turn)."
      : "  → nothing injected — either already in this conversation's context, or memory is unavailable.",
  );

  heading("Done");
  console.log(`  Memories are stored under user "${USER_ID}".`);
  console.log("  Inspect them in the Cortadel dashboard, or clean up with the SDK's delete().\n");
}

main().catch((error) => {
  // Reaching here means a bug, not an outage: every Cortadel call inside the
  // plugin is already guarded and degrades on its own.
  console.error("\nExample failed:", error);
  process.exit(1);
});
