/**
 * Message adapters between LangChain messages and Cortadel's `ChatMessage`.
 */

import type { BaseMessage } from "@langchain/core/messages";
import type { ChatMessage } from "@cortadel/sdk";

/**
 * LangChain `message.getType()` -> Cortadel role.
 *
 * `system` is deliberately absent: a deep agent's system prompt is a multi-kilobyte harness
 * instruction (filesystem tools, subagent protocol, todo discipline) and none of it is a durable
 * fact about the user. `tool` is absent for the same reason — tool output is transcript noise, and
 * Cortadel's extraction pipeline works better on the human/assistant dialogue alone.
 */
const ROLE_BY_TYPE: Record<string, string> = { human: "user", ai: "assistant" };

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
  if (typeof candidate.getType === "function") {
    try {
      const type = candidate.getType();
      if (typeof type === "string" && type) return type;
    } catch {
      // fall through to the field-based paths
    }
  }
  if (typeof candidate.type === "string" && candidate.type) return candidate.type;
  if (typeof candidate.role === "string" && candidate.role) {
    // Plain message objects speak roles, not LangChain types.
    return candidate.role === "user" ? "human" : candidate.role === "assistant" ? "ai" : candidate.role;
  }
  return undefined;
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
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const typed = block as { type?: unknown; text?: unknown };
        if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
      }
    }
    return parts.join("\n").trim();
  }
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
 */
export function toChatMessages(messages: readonly (BaseMessage | unknown)[]): ChatMessage[] {
  const converted: ChatMessage[] = [];
  for (const message of messages) {
    const type = messageType(message);
    const role = type ? ROLE_BY_TYPE[type] : undefined;
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
