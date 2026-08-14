import type {
  LanguageModelGenerateResult,
  LanguageModelMessage,
  LanguageModelPrompt,
} from "./types.js";

/**
 * Joins the text parts of the last `user` message in the prompt.
 *
 * This is the recall query. Files, images and tool results are skipped — Cortadel searches text.
 * Returns `""` when the prompt has no user message with text (e.g. an image-only turn), which
 * callers treat as "nothing to search for".
 */
export function lastUserText(prompt: LanguageModelPrompt): string {
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i] as LanguageModelMessage | undefined;
    if (message?.role !== "user") {
      continue;
    }
    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text;
  }
  return "";
}

/** Joins the text content of a completed generation, ignoring reasoning, tool calls and files. */
export function assistantText(content: LanguageModelGenerateResult["content"]): string {
  return content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * Inserts a system message carrying recalled memories.
 *
 * It goes *after* any leading system messages and *before* the first non-system message, for two
 * reasons: the caller's own instructions stay in first position where they outrank recalled
 * context, and the system block stays contiguous at the top of the prompt. That second point is
 * load-bearing — several providers (Anthropic among them) reject a system message that appears
 * after a user or assistant message, so appending at the end would break them.
 *
 * The prompt is copied, never mutated: `transformParams` receives the caller's live params object.
 */
export function injectSystemMemories(
  prompt: LanguageModelPrompt,
  text: string,
): LanguageModelPrompt {
  let insertAt = 0;
  while (insertAt < prompt.length && prompt[insertAt]?.role === "system") {
    insertAt += 1;
  }

  const memoryMessage = { role: "system", content: text } as LanguageModelMessage;
  return [...prompt.slice(0, insertAt), memoryMessage, ...prompt.slice(insertAt)];
}
