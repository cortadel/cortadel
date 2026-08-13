/**
 * End-to-end walkthrough of the Cortadel × OpenClaw plugin — without OpenClaw.
 *
 * The plugin's whole contract with its host is `register(api)`: it registers
 * tools, a memory corpus, and a few hooks onto whatever object it is handed.
 * So this script hands it a ~40-line stand-in for OpenClaw's plugin API, then
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
 *   pnpm build && node examples/local-turn.ts
 *
 *   # or the hosted service:
 *   CORTADEL_BASE_URL=https://app.cortadel.ai CORTADEL_API_KEY=... node examples/local-turn.ts
 *
 * `node` runs this `.ts` file directly: Node strips the types itself (default
 * since 22.18, and this package's floor is 22.22.3), so no loader or build step
 * is needed for the example — `pnpm build` is only for the plugin it imports.
 * Being TypeScript is also what keeps it honest: `pnpm typecheck` compiles
 * `examples/` against the plugin's real source, so an example cannot drift out
 * of step with the API it demonstrates.
 *
 * With no server reachable it still runs to completion — demonstrating the
 * other half of the design: memory degrades, the agent keeps going.
 */

import process from "node:process";

import { register, type CorpusSupplement, type CortadelAgentTool, type CortadelOpenClawConfig } from "@cortadel/openclaw";

const BASE_URL = process.env.CORTADEL_BASE_URL ?? "http://localhost:3001";
// `e2e-` marks this as disposable test data, per the Cortadel project convention.
const USER_ID = process.env.CORTADEL_USER_ID ?? "e2e-openclaw-example";
const SESSION_KEY = "assistant:example:1";

/** The per-turn context OpenClaw passes to tool factories and hook handlers. */
interface TurnContext {
  sessionKey: string;
  agentId: string;
}

/**
 * A hook handler as this harness stores them.
 *
 * Every OpenClaw hook has its own event type; one `Record` covers them all here
 * because the only events this script dispatches are literals it wrote itself.
 */
type HookHandler = (event: Record<string, unknown>, ctx: TurnContext) => unknown;

/** The cached system-prompt section builder passed to `registerMemoryPromptSupplement`. */
type PromptSectionBuilder = (params: { availableTools: Set<string> }) => string[];

/** What `before_prompt_build` resolves to when it has memories worth injecting. */
interface RecallResult {
  prependContext?: string;
}

/** Everything `register()` handed to the host, captured for inspection below. */
interface FakeHost {
  hooks: Map<string, HookHandler>;
  tools: CortadelAgentTool[];
  corpus?: CorpusSupplement;
  promptSection?: PromptSectionBuilder;
}

/** The one turn context this single-session walkthrough runs everything under. */
const TURN: TurnContext = { sessionKey: SESSION_KEY, agentId: "assistant" };

/** A minimal stand-in for OpenClawPluginApi: capture whatever the plugin registers. */
function createFakeHost(config: CortadelOpenClawConfig): FakeHost {
  const host: FakeHost = { hooks: new Map(), tools: [] };
  const log = (level: string) => (message: string) => console.log(`  [${level}] ${message}`);

  const api = {
    id: "cortadel",
    name: "Cortadel Memory",
    pluginConfig: config,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    // OpenClaw calls the factory with the active turn's context.
    registerTool: (factory: (ctx: TurnContext) => CortadelAgentTool[]) => {
      host.tools = factory(TURN);
    },
    registerMemoryCorpusSupplement: (supplement: CorpusSupplement) => {
      host.corpus = supplement;
    },
    registerMemoryPromptSupplement: (builder: PromptSectionBuilder) => {
      host.promptSection = builder;
    },
    on: (hookName: string, handler: HookHandler) => host.hooks.set(hookName, handler),
  };

  // `OpenClawPluginApi` is OpenClaw's entire plugin surface — dozens of
  // registration methods this plugin never touches. Implementing only the five
  // it does call is the point of a stand-in, so the cast is deliberate;
  // `test/plugin.test.ts` fakes the same seam the same way.
  register(api as never);
  return host;
}

/** Look up a registered hook, failing loudly rather than on `undefined(...)`. */
function hookOf(host: FakeHost, name: string): HookHandler {
  const handler = host.hooks.get(name);
  if (!handler) throw new Error(`the plugin registered no "${name}" hook`);
  return handler;
}

/** Look up a registered tool by its OpenClaw-visible name. */
function toolOf(host: FakeHost, name: string): CortadelAgentTool {
  const tool = host.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`the plugin registered no "${name}" tool`);
  return tool;
}

const heading = (text: string): void => console.log(`\n${"─".repeat(72)}\n${text}\n${"─".repeat(72)}`);

async function main(): Promise<void> {
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
  if (host.promptSection) {
    console.log("\n  System-prompt section the model sees:");
    for (const line of host.promptSection({ availableTools: new Set(host.tools.map((t) => t.name)) })) {
      console.log(`    · ${line}`);
    }
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
  await hookOf(host, "llm_output")(turnOne, TURN);

  // Extraction runs off the request path, so give it a moment to land.
  console.log("\n  (waiting 3s for Cortadel's extraction pipeline)");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // ── Turn 2: a later question that should recall those facts. ---------------
  heading("3. Turn 2 — automatic recall (before_prompt_build)");

  const question = "Which database should I use for the new service, and when can I ship it?";
  console.log(`  user : ${question}\n`);

  // Each hook returns its own result type; this one's is `{ prependContext }`.
  const recalled = (await hookOf(host, "before_prompt_build")({ prompt: question, messages: [] }, TURN)) as
    | RecallResult
    | undefined;

  if (recalled?.prependContext) {
    console.log("  → prepended to the turn context:\n");
    console.log(recalled.prependContext.replace(/^/gm, "    "));
  } else {
    console.log("  → nothing injected (no server, no matches, or already injected this session).");
  }

  // ── The same memories, reached deliberately by the agent. ------------------
  heading("4. Turn 2 — the agent calls cortadel_search_memory itself");

  const searchResult = await toolOf(host, "cortadel_search_memory").execute("example-call-1", {
    query: "database preference",
    topK: 3,
  });
  console.log(`  ${searchResult.content[0].text.replace(/\n/g, "\n  ")}`);

  // ── And through OpenClaw's own memory tool. --------------------------------
  heading("5. The same memories through OpenClaw's built-in memory_search");

  if (!host.corpus) {
    console.log("  (corpus supplement disabled by config)");
  } else {
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
  }

  // ── Recall dedupe: the same question again injects nothing new. ------------
  heading("6. Ask again — recall does not repeat itself");

  const again = (await hookOf(host, "before_prompt_build")({ prompt: question, messages: [] }, TURN)) as
    | RecallResult
    | undefined;
  console.log(
    again?.prependContext
      ? "  → injected new memories (different hits than last turn)."
      : "  → nothing injected — either already in this conversation's context, or memory is unavailable.",
  );

  heading("Done");
  console.log(`  Memories are stored under user "${USER_ID}".`);
  console.log("  Inspect them in the Cortadel dashboard, or clean up with the SDK's delete().\n");
}

main().catch((error: unknown) => {
  // Reaching here means a bug, not an outage: every Cortadel call inside the
  // plugin is already guarded and degrades on its own.
  console.error("\nExample failed:", error);
  process.exit(1);
});
