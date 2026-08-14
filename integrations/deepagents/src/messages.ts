/**
 * Message adapters between LangChain messages and Cortadel's `ChatMessage`.
 */

import type { ChatMessage } from "@cortadel/sdk";

/**
 * LangChain `message.getType()` -> Cortadel role — the exact inverse of {@link typeFromRole}.
 *
 * `system` is deliberately absent: a deep agent's system prompt is a multi-kilobyte harness
 * instruction (filesystem tools, subagent protocol, planning-tool discipline) and none of it is a
 * durable fact about the user. `tool` is absent for the same reason — tool output is transcript
 * noise, and Cortadel's extraction pipeline works better on the human/assistant dialogue alone.
 *
 * Two comparisons rather than a lookup table, mirroring `typeFromRole` below. A message type is
 * *data* — it comes from LangGraph state, or from a plain `{ role, content }` object a caller
 * handed to `agent.invoke` — and a plain object answers the inherited `Object.prototype` keys with
 * a truthy member instead of `undefined`: `ROLE_BY_TYPE["constructor"]` was `Object`,
 * `["toString"]` a function, `["__proto__"]` the prototype itself. Each sailed past the caller's
 * `if (!role)` guard and was written into the outgoing conversation as a non-string role.
 */
function roleForType(type: string | undefined): string | undefined {
  if (type === "human") return "user";
  if (type === "ai") return "assistant";
  return undefined;
}

/** The value when it is a non-empty string, otherwise `undefined`. `""` counts as absent. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value;
}

/**
 * The type reported by a message's own `getType()`, if it has a usable one.
 *
 * The call is guarded because `messageType` accepts arbitrary objects: a look-alike carrying a
 * `getType` that throws must fall through to the field-based paths, not sink the conversion.
 */
function typeFromGetType(candidate: { getType?: () => string }): string | undefined {
  if (typeof candidate.getType !== "function") return undefined;
  try {
    return nonEmptyString(candidate.getType());
  } catch {
    return undefined;
  }
}

/** Plain message objects speak roles, not LangChain types; unknown roles pass through as-is. */
function typeFromRole(role: unknown): string | undefined {
  const name = nonEmptyString(role);
  if (name === "user") return "human";
  if (name === "assistant") return "ai";
  return name;
}

/**
 * Best-effort message type for a LangChain message.
 *
 * `getType()` is the LangChain 1.x accessor (`_getType()` is deprecated); `type` is the public
 * readonly field on every concrete message class. Plain `{ role, content }` objects are handled
 * too, because a caller can hand those straight to `agent.invoke({ messages: [...] })`.
 */
export function messageType(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as {
    getType?: () => string;
    type?: unknown;
    role?: unknown;
  };
  return (
    typeFromGetType(candidate) ?? nonEmptyString(candidate.type) ?? typeFromRole(candidate.role)
  );
}

/**
 * Text carried by one content block, or `undefined` when the block carries none — an image or a
 * tool-use block. An empty `text` is *present* and returns `""`, so it still occupies a line in the
 * join below, exactly as it did when this walk was inline.
 */
function blockText(block: unknown): string | undefined {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return undefined;
  const typed = block as { type?: unknown; text?: unknown };
  if (typed.type !== "text" || typeof typed.text !== "string") return undefined;
  return typed.text;
}

/** Flatten an array-of-content-blocks `content` into text, one block per line. */
function contentBlocksText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const text = blockText(block);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n").trim();
}

/**
 * Best-effort plain text for a LangChain message.
 *
 * `text` is a getter on LangChain 1.x messages, but `content` can be a plain string or an array of
 * content blocks, and a plain `{ role, content }` object has no getter at all. All three shapes are
 * handled here so a content-block message never silently persists as `""`.
 */
export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { text?: unknown; content?: unknown };

  if (typeof candidate.text === "string" && candidate.text.trim()) return candidate.text.trim();

  const content = candidate.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return contentBlocksText(content);
  return "";
}

/** Text of the most recent human message — the retrieval query for this turn. */
export function latestUserText(messages: readonly unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageType(messages[index]) !== "human") continue;
    const text = messageText(messages[index]);
    if (text) return text;
  }
  return undefined;
}

/**
 * Convert LangChain messages to Cortadel `ChatMessage`s, dropping what shouldn't be stored.
 *
 * Skipped: system messages, tool messages, and assistant messages whose only payload is tool calls
 * (an `AIMessage` with empty text). What survives is the human/assistant dialogue, which is what
 * `addConversation` distills facts from.
 *
 * The element type is `unknown`, matching {@link latestUserText}: the intended input is LangChain's
 * `BaseMessage`, but a plain `{ role, content }` object is equally valid (that is what a caller
 * hands to `agent.invoke({ messages: [...] })`), and LangGraph state arrives loosely typed. Every
 * field is type-guarded at runtime by {@link messageType} / {@link messageText}, so a narrower
 * union would buy no safety and would reject inputs this function handles.
 */
export function toChatMessages(messages: readonly unknown[]): ChatMessage[] {
  const converted: ChatMessage[] = [];
  for (const message of messages) {
    const role = roleForType(messageType(message));
    if (!role) continue;
    const content = messageText(message);
    if (!content) continue;
    const id = (message as { id?: unknown }).id;
    converted.push({
      role,
      content,
      ...(typeof id === "string" && id ? { uuid: id } : {}),
    });
  }
  return converted;
}
