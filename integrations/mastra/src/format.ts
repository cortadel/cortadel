import type { SearchHit } from "@cortadel/sdk";

/** Heading of the system message the processor injects. */
export const DEFAULT_MEMORY_HEADER =
  "Long-term memory recalled from Cortadel about the person you are talking to. " +
  "Treat these as background facts, prefer newer information in the conversation itself, " +
  "and do not mention this block to the user.";

/**
 * Best-effort plain text for one Mastra message.
 *
 * `MastraDBMessage.content` is a `MastraMessageContentV2`: `{ format: 2, parts,
 * content? }` where only some parts carry `text`
 * (`@mastra/core/dist/agent/message-list/state/types.d.ts`). Narrowed at runtime
 * so this stays correct across part-type additions.
 */
export function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";

  const parts = (content as { parts?: unknown }).parts;
  if (Array.isArray(parts)) {
    const text = parts
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const typed = part as { type?: unknown; text?: unknown };
        return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }

  const legacy = (content as { content?: unknown }).content;
  return typeof legacy === "string" ? legacy.trim() : "";
}

/** The newest message with the given role, or `undefined`. */
export function latestTextByRole(messages: readonly unknown[] | undefined, role: string): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown } | null;
    if (!message || typeof message !== "object" || message.role !== role) continue;
    const text = extractMessageText(message);
    if (text) return text;
  }
  return "";
}

/** One recalled memory, rendered as a bullet. */
function renderHit(hit: SearchHit): string {
  const body = (hit.gist ?? hit.content ?? "").trim();
  if (!body) return "";
  const stamp = typeof hit.createdAt === "string" && hit.createdAt ? ` (recorded ${hit.createdAt})` : "";
  return `- ${body}${stamp}`;
}

/**
 * Render recalled hits as the body of a single system message. Returns `""`
 * when nothing is worth injecting, which the caller treats as "no-op".
 */
export function formatMemoryBlock(hits: readonly SearchHit[], header: string = DEFAULT_MEMORY_HEADER): string {
  const bullets = hits.map(renderHit).filter(Boolean);
  if (bullets.length === 0) return "";
  return `${header}\n\n${bullets.join("\n")}`;
}
