import type { ChatMessage, ConversationOptions, ConversationResult } from "@cortadel/sdk";
import type { ResolvedCortadelConfig, TurnIdentity } from "./types.js";

/**
 * The persist-after-turn half of automatic memory.
 *
 * Cortadel's `addConversation` does the extraction itself — it distils durable
 * facts from a transcript through its own store pipeline (intent classify →
 * dedup → extract). So this module's whole job is to hand it a clean, correctly
 * scoped user/assistant pair; it must not try to decide what is memorable.
 */

/** Per-message cap. Cortadel chunks long input, but an unbounded turn is still worth trimming. */
export const MAX_MESSAGE_CHARS = 32_000;

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

/**
 * Build the message pair for one completed turn.
 *
 * Returns `undefined` when there is nothing worth storing — an empty prompt, an
 * empty reply, or a turn that produced neither. Storing a half-turn teaches
 * Cortadel a fact with no context, so a partial turn is dropped rather than
 * guessed at.
 */
export function buildTurnMessages(prompt: string | undefined, assistantTexts: readonly string[]): ChatMessage[] | undefined {
  const user = prompt?.trim();
  const assistant = assistantTexts
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join("\n\n")
    .trim();

  if (!user || !assistant) return undefined;

  return [
    { role: "user", content: truncate(user) },
    { role: "assistant", content: truncate(assistant) },
  ];
}

/**
 * Conversation options for a captured turn.
 *
 * `sessionId` belongs here (and not on recall): it groups the facts a single
 * conversation produced, so they can be retrieved or audited together later,
 * without narrowing what future turns are allowed to recall.
 */
export function buildConversationOptions(config: ResolvedCortadelConfig, identity: TurnIdentity): ConversationOptions {
  const options: ConversationOptions = {
    // We want facts about the user, not about the assistant's own behaviour.
    isAgentMemory: false,
  };
  const sessionId = identity.sessionKey ?? identity.sessionId;
  if (sessionId) options.sessionId = sessionId;
  if (config.tags && config.tags.length > 0) options.tags = config.tags;
  if (config.project) options.project = config.project;
  return options;
}

/**
 * One-line summary of what the store pipeline did, for the debug log.
 *
 * `ConversationResult` is an either/or on the wire — `results` or
 * `noFactsExtracted`, never both — so `results` is null-checked before use.
 */
export function summarizeConversationResult(result: ConversationResult): string {
  if (result.noFactsExtracted) return "no facts extracted";
  const items = result.results;
  if (!items || items.length === 0) return "no facts extracted";

  const counts = new Map<string, number>();
  for (const item of items) {
    const event = item.event ?? "UNKNOWN";
    counts.set(event, (counts.get(event) ?? 0) + 1);
  }
  return [...counts.entries()].map(([event, n]) => `${event}=${n}`).join(" ");
}
