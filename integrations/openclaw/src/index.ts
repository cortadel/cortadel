import { CortadelClient } from "@cortadel/sdk";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { isUsableBaseUrl, resolveConfig } from "./config.js";
import { createCorpusSupplement } from "./corpus.js";
import { CortadelGateway, type CortadelClientFactory } from "./gateway.js";
import { buildPromptSection, buildRecallSearchOptions, filterByScore, formatRecallBlock, RecallLedger, shouldRecall } from "./recall.js";
import { buildConversationOptions, buildTurnMessages, summarizeConversationResult } from "./remember.js";
import { resolveSessionScopeKey } from "./scope.js";
import { createTools } from "./tools.js";
import type { CortadelLogger, CortadelMemoryClient, CortadelOpenClawConfig, TurnIdentity } from "./types.js";

export const PLUGIN_ID = "cortadel";

/**
 * Wiring only. Every decision this plugin makes lives in the sibling modules,
 * which import nothing from `openclaw` and are unit-tested on their own.
 *
 * @param clientFactory Overrides how Cortadel clients are built. OpenClaw never
 *   passes it — `definePluginEntry` calls `register(api)` with one argument — so
 *   in production this is always the real `CortadelClient`. Tests inject a fake
 *   to exercise the full registration path without a server.
 */
export function register(api: OpenClawPluginApi, clientFactory?: CortadelClientFactory): void {
  const logger: CortadelLogger = api.logger;
  const config = resolveConfig(api.pluginConfig as CortadelOpenClawConfig | undefined);

  // A bad base URL would make the SDK constructor throw. Throwing out of
  // register() would fail the whole plugin load, so instead the gateway is
  // built disabled: registrations still happen (keeping `contracts.tools`
  // honest) and every call reports a clear reason.
  const usable = isUsableBaseUrl(config.baseUrl);
  if (!usable) {
    logger.error(`[cortadel] invalid baseUrl ${JSON.stringify(config.baseUrl)} — memory is disabled. Expected an http(s) URL.`);
  }

  const factory: CortadelClientFactory =
    clientFactory ??
    ((userId): CortadelMemoryClient =>
      new CortadelClient({
        baseUrl: config.baseUrl,
        userId,
        apiKey: config.apiKey,
        appName: config.appName,
        timeoutMs: config.timeoutMs,
      }));

  const gateway = new CortadelGateway(config, factory, logger, usable);

  const ledger = new RecallLedger(config.dedupeWindow);

  // ---------------------------------------------------------------- tools --
  // Factory form: OpenClaw invokes it with the active turn's context, so each
  // tool call resolves its own Cortadel user id instead of reading shared state.
  api.registerTool((ctx) =>
    createTools(gateway, {
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      senderId: ctx.requesterSenderId,
    }),
  );

  // ------------------------------------------------------- memory corpus --
  if (config.corpusSupplement) {
    // Additive, not exclusive: Cortadel shows up inside OpenClaw's own
    // memory_search / memory_get alongside the built-in corpus.
    api.registerMemoryCorpusSupplement(createCorpusSupplement(gateway));
  }

  if (config.promptSupplement) {
    // `registerMemoryPromptSupplement` — the *additive, non-exclusive* variant,
    // and the correct call here. Not to be confused with the neighbouring
    // `registerMemoryPromptSection`, which is the exclusive slot and is the one
    // carrying `@deprecated Use registerMemoryCapability({ promptBuilder })`.
    // That replacement is unavailable to us anyway: it throws unless the plugin
    // declares `kind: "memory"`, which this plugin deliberately does not, so as
    // to stay additive alongside OpenClaw's built-in memory-core.
    api.registerMemoryPromptSupplement(({ availableTools }) => buildPromptSection(availableTools));
  }

  // ------------------------------------------------------- automatic recall --
  if (config.autoRecall) {
    api.on("before_prompt_build", async (event, ctx) => {
      if (!shouldRecall(event.prompt, config)) return;

      const identity: TurnIdentity = { agentId: ctx.agentId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, senderId: ctx.senderId };
      const outcome = await gateway.call(gateway.userIdFor(identity), "auto-recall", (client, signal) =>
        client.search(event.prompt, buildRecallSearchOptions(config), signal),
      );
      // Degraded memory must never block a turn: no result means no injection.
      if (!outcome.ok) return;

      const sessionScope = resolveSessionScopeKey(identity);
      const fresh = ledger.filterUnseen(sessionScope, filterByScore(outcome.value.results, config.minScore));
      const block = formatRecallBlock(fresh);
      if (!block) return;

      // Record only what the character budget actually let through. Recording
      // `fresh` would suppress budget-dropped memories for the rest of the
      // session despite the model never having seen them.
      ledger.record(sessionScope, block.injected);
      logger.debug?.(`[cortadel] recalled ${block.injected.length} memories for ${sessionScope}`);
      // `prependContext`, not `prependSystemContext`: this text changes every
      // turn, and the system-prompt variants are reserved for static guidance
      // that providers can prompt-cache.
      return { prependContext: block.text };
    });
  }

  // ------------------------------------------------------ automatic capture --
  if (config.autoCapture) {
    // `llm_output` carries the turn as typed fields — `prompt` and
    // `assistantTexts` — where `agent_end` only exposes `messages: unknown[]`.
    // Persisting from the typed pair avoids guessing at an untyped shape.
    api.on("llm_output", async (event, ctx) => {
      const messages = buildTurnMessages(event.prompt, event.assistantTexts);
      if (!messages) return;

      const identity: TurnIdentity = {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey ?? event.sessionId,
        sessionId: event.sessionId,
        senderId: ctx.senderId,
      };
      const outcome = await gateway.call(gateway.userIdFor(identity), "auto-capture", (client, signal) =>
        client.addConversation(messages, buildConversationOptions(config, identity), signal),
      );
      if (outcome.ok) logger.debug?.(`[cortadel] captured turn: ${summarizeConversationResult(outcome.value)}`);
    });
  }

  // ------------------------------------------------------------- lifecycle --
  // A new or reset conversation starts with a clean injection history, so the
  // memories it needs are re-injected rather than suppressed as "already seen".
  api.on("session_start", (event, ctx) => {
    ledger.reset(resolveSessionScopeKey({ agentId: ctx.agentId, sessionKey: ctx.sessionKey ?? event.sessionKey, sessionId: event.sessionId }));
  });
  api.on("before_reset", (_event, ctx) => {
    ledger.reset(resolveSessionScopeKey({ agentId: ctx.agentId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId }));
  });

  logger.info(
    `[cortadel] memory ${usable ? "ready" : "disabled"} — ${config.baseUrl} as ${config.userId} ` +
      `(recallScope=${config.recallScope}, recall=${config.autoRecall}, capture=${config.autoCapture}, corpus=${config.corpusSupplement})`,
  );
}

/**
 * The normalized entry OpenClaw loads from this module.
 *
 * Declared explicitly rather than inferred: `definePluginEntry`'s return type
 * reaches into an internal bundled chunk that cannot be named from outside the
 * `openclaw` package, so an inferred `export default` emits a non-portable
 * declaration (TS2742).
 */
export interface CortadelPluginEntry {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
}

const entry: CortadelPluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Cortadel Memory",
  description:
    "Self-hosted long-term temporal graph memory for OpenClaw. Adds Cortadel as an additive memory corpus, " +
    "two agent tools, and optional automatic recall/capture around every turn.",
  register,
});

export default entry;

export { CortadelGateway, CircuitBreaker, describeError } from "./gateway.js";
export { RecallLedger, formatRecallBlock, buildPromptSection, buildRecallSearchOptions, filterByScore, shouldRecall } from "./recall.js";
export { buildTurnMessages, buildConversationOptions, summarizeConversationResult } from "./remember.js";
export { createCorpusSupplement, memoryPath, parseLookup, toCorpusGetResult, toCorpusSearchResult } from "./corpus.js";
export { createTools } from "./tools.js";
export { resolveConfig, isUsableBaseUrl, DEFAULT_APP_NAME, DEFAULT_BASE_URL, DEFAULT_USER_ID } from "./config.js";
export { resolveAgentId, resolveSessionScopeKey, resolveUserId, sanitizeDiscriminator } from "./scope.js";
export type { RecallBlock } from "./recall.js";
export type { CorpusGetResult, CorpusSearchResult, CorpusSupplement } from "./corpus.js";
export type { CortadelClientFactory, GatewayResult } from "./gateway.js";
export type { CortadelAgentTool } from "./tools.js";
export type {
  CortadelCircuitBreakerConfig,
  CortadelLogger,
  CortadelMemoryClient,
  CortadelOpenClawConfig,
  CortadelRecallScope,
  ResolvedCortadelConfig,
  TurnIdentity,
} from "./types.js";
