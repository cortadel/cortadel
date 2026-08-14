/**
 * Helpers for reading the Agents SDK's conversation items.
 *
 * `AgentInputItem` (`@openai/agents-core/dist/types/aliases.d.ts`) is a discriminated union of
 * Zod-inferred plain objects — message items, function calls, function-call outputs, reasoning
 * items, compaction markers and more. At runtime every one of them is an ordinary object, so this
 * module reads them structurally and never narrows on a class.
 *
 * Only *message* items carry text we can send to Cortadel. Function calls, their outputs,
 * reasoning items and the rest are agent plumbing: they are deliberately dropped rather than
 * stored as memories.
 */

import type { AgentInputItem } from '@openai/agents';

/**
 * Roles whose text is worth persisting as long-term memory. System items are instructions we (or
 * the framework) authored, not things the user or the agent said.
 */
export const ROLES_TO_STORE = ['user', 'assistant'] as const;

export type StorableRole = (typeof ROLES_TO_STORE)[number];

/** One storable message, flattened to plain text. */
export interface MessagePair {
  role: StorableRole;
  text: string;
}

/**
 * Content-part `type` values that carry plain text. `input_text` is what the user sends,
 * `output_text` is what the model produces, `summary_text` shows up inside reasoning items, and
 * bare `text` appears in some provider shims.
 */
const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text', 'summary_text']);

/**
 * Whether a content part's `type` names one of the text-bearing kinds.
 *
 * A missing `type` counts: some provider shims emit a bare `{ text: '…' }` part.
 *
 * The `typeof` check is load-bearing, not defensive noise. `type` arrives as `unknown`, and
 * coercing it with `String()` would flatten every object to `"[object Object]"` — worse, a part
 * whose `type` carried its own `toString()` could return `"text"` and impersonate a real text
 * part. Only an actual string can name a kind; anything else is a shape we do not understand and
 * is dropped.
 */
function isTextPartType(partType: unknown): boolean {
  if (partType === undefined) {
    return true;
  }
  return typeof partType === 'string' && TEXT_PART_TYPES.has(partType);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Return the role of a *message* item, or `undefined` for anything else.
 *
 * An item counts as a message when it has a `role` and either omits `type` entirely (the
 * shorthand `{ role: 'user', content: 'hi' }`) or sets it to `"message"` (the fully expanded
 * shape the Responses API returns). `type` is `z.ZodOptional<z.ZodLiteral<'message'>>` on all
 * three message schemas, so both forms are legal input.
 */
export function itemRole(item: unknown): string | undefined {
  const record = asRecord(item);
  if (!record) {
    return undefined;
  }
  const type = record['type'];
  if (type !== undefined && type !== 'message') {
    return undefined;
  }
  const role = record['role'];
  return typeof role === 'string' ? role : undefined;
}

/**
 * Extract the plain text of an item, flattening multi-part content.
 *
 * Returns an empty string when the item carries no text (an image-only turn, a refusal, a tool
 * call). Callers treat empty as "nothing to remember".
 */
export function itemText(item: unknown): string {
  const record = asRecord(item);
  if (!record) {
    return '';
  }

  const content = record['content'];
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    const partRecord = asRecord(part);
    if (!partRecord) {
      continue;
    }
    if (!isTextPartType(partRecord['type'])) {
      continue;
    }
    const text = partRecord['text'];
    if (typeof text === 'string' && text) {
      chunks.push(text);
    }
  }

  return chunks.join('\n').trim();
}

function isStorableRole(role: string | undefined): role is StorableRole {
  return role === 'user' || role === 'assistant';
}

/**
 * Return `{ role, text }` for every storable message item, in order.
 *
 * Items that are not messages, carry an unstorable role, or have no text are dropped.
 */
export function messagePairs(items: readonly AgentInputItem[] | undefined): MessagePair[] {
  const pairs: MessagePair[] = [];
  for (const item of items ?? []) {
    const role = itemRole(item);
    if (!isStorableRole(role)) {
      continue;
    }
    const text = itemText(item);
    if (text) {
      pairs.push({ role, text });
    }
  }
  return pairs;
}

/** Index of the most recent user message that carries text, or `undefined`. */
export function lastUserIndex(items: readonly AgentInputItem[] | undefined): number | undefined {
  const sequence = items ?? [];
  for (let index = sequence.length - 1; index >= 0; index -= 1) {
    const item = sequence[index];
    if (itemRole(item) === 'user' && itemText(item)) {
      return index;
    }
  }
  return undefined;
}

/**
 * Text of the most recent user message, or `undefined` if there is none.
 *
 * This is the retrieval query for the automatic-memory filter: it is the question the model is
 * about to answer, which is exactly what we want to search Cortadel for.
 */
export function lastUserText(items: readonly AgentInputItem[] | undefined): string | undefined {
  const sequence = items ?? [];
  const index = lastUserIndex(sequence);
  return index === undefined ? undefined : itemText(sequence[index]);
}
