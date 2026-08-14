// End-to-end wiring: drives the real `register()` against a fake
// OpenClawPluginApi. No OpenClaw gateway, no Cortadel server, no keys — the
// Cortadel client factory is injected, so nothing opens a socket.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OpenClawSchema, validateJsonSchemaValue, type JsonSchemaObject } from "openclaw/plugin-sdk/config-schema";

import entry, { PLUGIN_ID, register } from "../src/index.js";
import type { CortadelAgentTool } from "../src/tools.js";
import type { CorpusSupplement } from "../src/corpus.js";
import type { CortadelOpenClawConfig } from "../src/types.js";
import { cortadelError, FakeCortadelClient, hit, recordingLogger, searchResults, TEST_USER } from "./helpers.js";

type ToolFactory = (ctx: Record<string, unknown>) => CortadelAgentTool[];
type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readPackageJson = (...segments: string[]): unknown =>
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, ...segments), "utf8"));

/** Captures everything `register()` does to the plugin API. */
function fakeApi(pluginConfig: CortadelOpenClawConfig) {
  const logger = recordingLogger();
  const hooks = new Map<string, Hook>();
  const captured = {
    logger,
    hooks,
    toolFactory: undefined as ToolFactory | undefined,
    corpus: undefined as CorpusSupplement | undefined,
    promptSupplement: undefined as ((p: { availableTools: Set<string> }) => string[]) | undefined,
  };

  const api = {
    id: PLUGIN_ID,
    name: "Cortadel Memory",
    pluginConfig,
    logger,
    registerTool: (tool: unknown) => {
      captured.toolFactory = tool as ToolFactory;
    },
    registerMemoryCorpusSupplement: (s: unknown) => {
      captured.corpus = s as CorpusSupplement;
    },
    registerMemoryPromptSupplement: (b: unknown) => {
      captured.promptSupplement = b as (p: { availableTools: Set<string> }) => string[];
    },
    on: (name: string, handler: Hook) => {
      hooks.set(name, handler);
    },
  };

  return { api, captured };
}

function setup(pluginConfig: CortadelOpenClawConfig = {}, client = new FakeCortadelClient()) {
  const { api, captured } = fakeApi({ userId: TEST_USER, baseUrl: "http://localhost:3001", ...pluginConfig });
  const seen: string[] = [];
  register(api as never, (userId) => {
    seen.push(userId);
    return client;
  });
  return { captured, client, seen };
}

describe("plugin entry", () => {
  it("exports the id, name, and register the manifest declares", () => {
    expect(entry.id).toBe("cortadel");
    expect(entry.name).toBe("Cortadel Memory");
    expect(typeof entry.register).toBe("function");
  });
});

const manifest = readPackageJson("openclaw.plugin.json") as {
  id: string;
  name: string;
  description: string;
  activation?: Record<string, unknown>;
  contracts?: { tools?: string[] };
  configSchema: JsonSchemaObject & { type: string; properties?: Record<string, unknown> };
  toolMetadata?: Record<string, { optional?: boolean }>;
};

describe("openclaw.plugin.json", () => {

  it("carries the fields OpenClaw requires of a manifest", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.name).toBe(entry.name);
    expect(manifest.description.length).toBeGreaterThan(0);
    // configSchema is a required top-level field.
    expect(manifest.configSchema?.type).toBe("object");
    // Activation must be set intentionally; omitting it no longer startup-loads.
    expect(manifest.activation?.onStartup).toBe(true);
  });

  it("declares exactly the tools that get registered", () => {
    // OpenClaw discovers tool ownership from contracts.tools without loading the
    // runtime, so a drift here silently breaks discovery.
    const { captured } = setup();
    const registered = captured.toolFactory!({}).map((t) => t.name).sort();
    expect([...(manifest.contracts?.tools ?? [])].sort()).toEqual(registered);
  });

  it("keeps toolMetadata aligned with the tools it declares", () => {
    for (const name of Object.keys(manifest.toolMetadata ?? {})) {
      expect(manifest.contracts?.tools).toContain(name);
    }
  });

  it("documents every config option the plugin actually reads", () => {
    const declared = Object.keys(manifest.configSchema?.properties ?? {}).sort();
    expect(declared).toEqual(
      [
        "apiKey",
        "appName",
        "autoCapture",
        "autoRecall",
        "baseUrl",
        "circuitBreaker",
        "corpusSupplement",
        "dedupeWindow",
        "minPromptChars",
        "minScore",
        "project",
        "promptSupplement",
        "rerank",
        "tags",
        "timeoutMs",
        "topK",
        "userId",
        "recallScope",
      ].sort(),
    );
  });

  it("claims no model-provider surface", () => {
    // Cortadel is a memory backend, not a model provider, and this plugin
    // registers no provider runtime. `setup.providers[].id` must stay globally
    // unique across every discovered plugin and shows up in onboarding pickers;
    // `providerEndpoints[].endpointClass` is a closed core union that has no
    // member meaning "a memory server". Declaring either is wrong metadata.
    const asRecord = manifest as unknown as Record<string, unknown>;
    expect(asRecord.setup).toBeUndefined();
    expect(asRecord.providerEndpoints).toBeUndefined();
  });

  it("hardcodes no credentials", () => {
    expect(JSON.stringify(manifest)).not.toMatch(/\b(sk|m0)-[A-Za-z0-9]{8,}/);
  });
});

describe("examples/openclaw.json", () => {
  // The README tells users to copy this file. Both of OpenClaw's config layers
  // are closed schemas, and an invalid plugin config is fatal rather than a
  // warning — loader-D8d2EvVh.js logs `[plugins] <id> invalid config: ...` and
  // `continue`s, skipping the plugin entirely. So the example has to be checked
  // against OpenClaw's real validators, not merely eyeballed.
  const example = readPackageJson("examples", "openclaw.json") as {
    plugins: { entries: { cortadel: { enabled: boolean; config: Record<string, unknown> } } };
  };

  /**
   * The loader's own gate, called the way the loader calls it
   * (loader-D8d2EvVh.js `validatePluginConfig`), so this test cannot pass on a
   * config the real plugin loader would reject. Returns the display errors, so a
   * failure names the offending keys instead of asserting `false !== true`.
   */
  const validateAgainstManifest = (config: unknown): string[] => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: JSON.stringify(manifest.configSchema),
      value: config ?? {},
      applyDefaults: true,
    });
    return result.ok ? [] : result.errors.map((error) => error.text);
  };

  it("passes the plugin-config layer built from this plugin's own manifest schema", () => {
    expect(validateAgainstManifest(example.plugins.entries.cortadel.config)).toEqual([]);
  });

  it("passes the root-config layer (OpenClawSchema)", () => {
    const result = OpenClawSchema.safeParse(example);
    expect(result.success ? [] : result.error.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
  });

  it("rejects a `//` comment key at either layer — which is why the example carries none", () => {
    // Negative control. Nothing in OpenClaw strips `"//"`-prefixed keys, so a
    // JSON-with-comments example silently disables the plugin. This asserts the
    // failure mode is real, so the two tests above are not vacuous.
    expect(validateAgainstManifest({ ...example.plugins.entries.cortadel.config, "//baseUrl": "prose" })).not.toEqual([]);
    expect(OpenClawSchema.safeParse({ ...example, "//": ["prose"] }).success).toBe(false);
  });

  it("enables the plugin and uses e2e-scoped test data", () => {
    expect(example.plugins.entries.cortadel.enabled).toBe(true);
    expect(example.plugins.entries.cortadel.config.userId).toMatch(/^e2e-/);
  });

  it("inlines no credential — the api key is an env reference", () => {
    // OpenClaw expands `${VAR}` in any config string value.
    expect(example.plugins.entries.cortadel.config.apiKey).toBe("${CORTADEL_API_KEY}");
    expect(JSON.stringify(example)).not.toMatch(/\b(sk|m0)-[A-Za-z0-9]{8,}/);
  });
});

describe("install metadata", () => {
  // Two names refer to this package — the ClawHub slug in the README's install
  // command and the npm package name. `openclaw.install` is what onboarding
  // actually reads (catalog-dIh-7kX9.js), so it is the authoritative pin; these
  // assertions stop the README and the npm name from drifting away from it.
  const pkg = readPackageJson("package.json") as {
    name: string;
    openclaw: { install: { clawhubSpec: string; npmSpec: string; defaultChoice: string } };
  };
  const readme = readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8");

  it("pins the ClawHub slug in the form OpenClaw's own parser accepts", () => {
    // `clawhub:<name>[@version]` — parseClawHubPluginSpec rejects anything else.
    expect(pkg.openclaw.install.clawhubSpec).toMatch(/^clawhub:[^@\s]+$/);
    expect(pkg.openclaw.install.defaultChoice).toBe("clawhub");
  });

  it("keeps npmSpec identical to the published package name", () => {
    expect(pkg.openclaw.install.npmSpec).toBe(pkg.name);
  });

  it("documents the same install command it declares", () => {
    expect(readme).toContain(`openclaw plugins install ${pkg.openclaw.install.clawhubSpec}`);
    expect(readme).toContain(`npm install ${pkg.openclaw.install.npmSpec}`);
  });
});

describe("register", () => {
  it("registers both tools, the corpus supplement, the prompt section, and the hooks", () => {
    const { captured } = setup();

    const tools = captured.toolFactory!({});
    expect(tools.map((t) => t.name)).toEqual(["cortadel_search_memory", "cortadel_add_memories"]);
    expect(captured.corpus).toBeDefined();
    expect(captured.promptSupplement).toBeDefined();
    expect([...captured.hooks.keys()].sort()).toEqual(["before_prompt_build", "before_reset", "llm_output", "session_start"]);
  });

  it("registers no recall hook when autoRecall is off", () => {
    const { captured } = setup({ autoRecall: false });
    expect(captured.hooks.has("before_prompt_build")).toBe(false);
    expect(captured.hooks.has("llm_output")).toBe(true);
  });

  it("registers no capture hook when autoCapture is off", () => {
    const { captured } = setup({ autoCapture: false });
    expect(captured.hooks.has("llm_output")).toBe(false);
  });

  it("skips the corpus and prompt supplements when disabled", () => {
    const { captured } = setup({ corpusSupplement: false, promptSupplement: false });
    expect(captured.corpus).toBeUndefined();
    expect(captured.promptSupplement).toBeUndefined();
  });

  it("still registers its declared tools when the base URL is unusable", () => {
    // contracts.tools must stay honest, and the tools report the reason.
    const { captured } = setup({ baseUrl: "not a url" });
    expect(captured.toolFactory!({})).toHaveLength(2);
    expect(captured.logger.lines.some((l) => l.startsWith("error:") && l.includes("baseUrl"))).toBe(true);
  });

  it("does not call Cortadel at all when disabled by a bad base URL", async () => {
    const { captured, client } = setup({ baseUrl: "ftp://nope" });
    const result = await captured.toolFactory!({})[0]!.execute("c", { query: "anything" });
    expect(result.details).toMatchObject({ ok: false, reason: "disabled" });
    expect(client.searches).toHaveLength(0);
  });

  it("passes each turn's identity through the tool factory", async () => {
    const { captured, seen } = setup({ recallScope: "session" });
    const tools = captured.toolFactory!({ sessionKey: "alpha:telegram:42", agentId: "alpha", requesterSenderId: "u1" });
    await tools[0]!.execute("c", { query: "q" });
    expect(seen).toEqual([`${TEST_USER}:alpha-telegram-42`]);
  });
});

describe("automatic recall (before_prompt_build)", () => {
  it("searches and prepends the matching memories", async () => {
    const { captured, client } = setup();
    client.searchResult = searchResults("db choice", [hit("m1", "Uses Postgres.")]);

    const result = (await captured.hooks.get("before_prompt_build")!(
      { prompt: "what database did I pick?", messages: [] },
      { sessionKey: "alpha:main" },
    )) as { prependContext?: string } | undefined;

    expect(client.searches[0]!.query).toBe("what database did I pick?");
    expect(result?.prependContext).toContain("Uses Postgres.");
    expect(result?.prependContext).toContain("<cortadel-memory>");
  });

  it("does not re-inject the same memory on the next turn", async () => {
    const { captured, client } = setup();
    client.searchResult = searchResults("q", [hit("m1", "Uses Postgres.")]);
    const hook = captured.hooks.get("before_prompt_build")!;
    const ctx = { sessionKey: "alpha:main" };

    const first = (await hook({ prompt: "which database?", messages: [] }, ctx)) as { prependContext?: string };
    expect(first?.prependContext).toContain("Uses Postgres.");

    // Same top hit, second turn: nothing new to say, so nothing is injected.
    const second = await hook({ prompt: "and which database again?", messages: [] }, ctx);
    expect(second).toBeUndefined();
  });

  it("re-injects after the session restarts", async () => {
    const { captured, client } = setup();
    client.searchResult = searchResults("q", [hit("m1", "Uses Postgres.")]);
    const hook = captured.hooks.get("before_prompt_build")!;
    const ctx = { sessionKey: "alpha:main" };

    await hook({ prompt: "which database?", messages: [] }, ctx);
    captured.hooks.get("session_start")!({ sessionId: "new" }, ctx);

    const after = (await hook({ prompt: "which database?", messages: [] }, ctx)) as { prependContext?: string };
    expect(after?.prependContext).toContain("Uses Postgres.");
  });

  it("re-injects after a reset", async () => {
    const { captured, client } = setup();
    client.searchResult = searchResults("q", [hit("m1", "Uses Postgres.")]);
    const hook = captured.hooks.get("before_prompt_build")!;
    const ctx = { sessionKey: "alpha:main" };

    await hook({ prompt: "which database?", messages: [] }, ctx);
    captured.hooks.get("before_reset")!({}, ctx);

    const after = (await hook({ prompt: "which database?", messages: [] }, ctx)) as { prependContext?: string };
    expect(after?.prependContext).toContain("Uses Postgres.");
  });

  it("does not suppress memories the character budget dropped", async () => {
    // The recall block is capped at MAX_RECALL_CHARS independently of topK, so a
    // large topK can return more than fits. Only what was injected may be marked
    // as seen — otherwise the overflow is silently lost for the whole session.
    const { captured, client } = setup({ topK: 50 });
    const many = Array.from({ length: 40 }, (_, i) => hit(`m${i}`, `memory ${i}: ${"x".repeat(380)}`));
    client.searchResult = searchResults("q", many);
    const hook = captured.hooks.get("before_prompt_build")!;
    const ctx = { sessionKey: "alpha:budget" };

    const first = (await hook({ prompt: "tell me everything", messages: [] }, ctx)) as { prependContext: string };
    const firstIds = many.filter((h) => first.prependContext.includes(`memory ${h.id.slice(1)}:`)).map((h) => h.id);
    expect(firstIds.length).toBeGreaterThan(0);
    expect(firstIds.length).toBeLessThan(many.length); // the budget really did truncate

    // Second turn, same session, same hits: the overflow must still be reachable.
    const second = (await hook({ prompt: "tell me everything again", messages: [] }, ctx)) as { prependContext: string };
    expect(second?.prependContext).toBeDefined();
    for (const id of firstIds) expect(second.prependContext).not.toContain(`memory ${id.slice(1)}:`);
    expect(second.prependContext).toContain(`memory ${firstIds.length}:`);
  });

  it("keeps sessions independent", async () => {
    const { captured, client } = setup();
    client.searchResult = searchResults("q", [hit("m1", "Uses Postgres.")]);
    const hook = captured.hooks.get("before_prompt_build")!;

    await hook({ prompt: "which database?", messages: [] }, { sessionKey: "alpha:one" });
    const other = (await hook({ prompt: "which database?", messages: [] }, { sessionKey: "alpha:two" })) as { prependContext?: string };
    expect(other?.prependContext).toContain("Uses Postgres.");
  });

  it("skips a trivially short prompt without searching", async () => {
    const { captured, client } = setup();
    await captured.hooks.get("before_prompt_build")!({ prompt: "hi", messages: [] }, {});
    expect(client.searches).toHaveLength(0);
  });

  it("leaves the turn untouched when Cortadel is unreachable", async () => {
    // The agent must keep working with memory down.
    const { captured, client } = setup();
    client.failure = cortadelError(0, "transport_error", "connection refused");

    const result = await captured.hooks.get("before_prompt_build")!({ prompt: "what did I decide?", messages: [] }, {});
    expect(result).toBeUndefined();
    expect(captured.logger.lines.some((l) => l.startsWith("warn:"))).toBe(true);
  });

  it("injects nothing when the search returns no hits", async () => {
    const { captured } = setup();
    const result = await captured.hooks.get("before_prompt_build")!({ prompt: "anything at all", messages: [] }, {});
    expect(result).toBeUndefined();
  });
});

describe("automatic capture (llm_output)", () => {
  it("persists the completed turn as a user/assistant pair", async () => {
    const { captured, client } = setup();

    await captured.hooks.get("llm_output")!(
      { runId: "r1", sessionId: "s1", provider: "p", model: "m", prompt: "I use Postgres.", assistantTexts: ["Noted."] },
      { sessionKey: "alpha:main" },
    );

    expect(client.conversations).toHaveLength(1);
    expect(client.conversations[0]!.messages).toEqual([
      { role: "user", content: "I use Postgres." },
      { role: "assistant", content: "Noted." },
    ]);
    expect(client.conversations[0]!.options).toMatchObject({ isAgentMemory: false, sessionId: "alpha:main" });
  });

  it("falls back to the event's sessionId when the context has no session key", async () => {
    const { captured, client } = setup();
    await captured.hooks.get("llm_output")!(
      { runId: "r1", sessionId: "s-fallback", provider: "p", model: "m", prompt: "a prompt", assistantTexts: ["a reply"] },
      {},
    );
    expect(client.conversations[0]!.options).toMatchObject({ sessionId: "s-fallback" });
  });

  it("stores nothing for a half-turn", async () => {
    const { captured, client } = setup();
    const hook = captured.hooks.get("llm_output")!;
    await hook({ runId: "r", sessionId: "s", provider: "p", model: "m", assistantTexts: ["reply"] }, {});
    await hook({ runId: "r", sessionId: "s", provider: "p", model: "m", prompt: "ask", assistantTexts: [] }, {});
    expect(client.conversations).toHaveLength(0);
  });

  it("swallows a capture failure rather than throwing into the turn", async () => {
    const { captured, client } = setup();
    client.failure = cortadelError(500, "http_error", "boom");
    await expect(
      captured.hooks.get("llm_output")!(
        { runId: "r", sessionId: "s", provider: "p", model: "m", prompt: "a prompt", assistantTexts: ["a reply"] },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("routes capture to the scoped namespace", async () => {
    const { captured, seen } = setup({ recallScope: "agent" });
    await captured.hooks.get("llm_output")!(
      { runId: "r", sessionId: "s", provider: "p", model: "m", prompt: "a prompt", assistantTexts: ["a reply"] },
      { agentId: "beta" },
    );
    expect(seen).toEqual([`${TEST_USER}:beta`]);
  });
});

describe("memory corpus supplement", () => {
  it("is reachable through the registered supplement", async () => {
    const { captured, client } = setup();
    client.searchResult = searchResults("q", [hit("m1", "Uses Postgres.", { rrfScore: 0.7 })]);

    const rows = await captured.corpus!.search({ query: "database", agentSessionKey: "alpha:main" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ corpus: "cortadel", path: "cortadel://m1" });
  });
});

describe("prompt supplement", () => {
  it("describes only the tools that are actually available", () => {
    const { captured } = setup();
    const lines = captured.promptSupplement!({ availableTools: new Set(["cortadel_search_memory"]) });
    expect(lines.join("\n")).toContain("cortadel_search_memory");
    expect(lines.join("\n")).not.toContain("cortadel_add_memories");
  });
});
