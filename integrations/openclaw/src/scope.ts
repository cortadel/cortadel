import type { CortadelRecallScope, TurnIdentity } from "./types.js";

/**
 * A Cortadel client is bound to one user id at construction — no method takes a
 * user id — so "per-user scoping" here means choosing a user id per turn and
 * keeping one client per distinct id. This module owns that choice.
 */

/** Longest discriminator we append before truncating, keeping ids readable in the dashboard. */
const MAX_DISCRIMINATOR = 96;

/** Separators that are legal inside a discriminator but never at either end. */
function isEdgeSeparator(char: string): boolean {
  return char === "-" || char === ".";
}

/**
 * Strip leading and trailing `-`/`.` in one linear scan.
 *
 * Deliberately not a regex. The obvious spelling — `/^[-.]+|[-.]+$/` — is
 * quadratic: on `"a" + ".".repeat(n) + "a"` the leading `a` defeats the `^`
 * alternative at every offset, so each of the n offsets inside the run falls
 * through to `[-.]+$`, which consumes the rest of the run and then backtracks
 * all of it away against a `$` that can never match. Measured on V8, the time
 * quadrupled for every doubling of the input: 160k chars blocked the event loop
 * for 5.6s. `value` here is an opaque provider-supplied id and the length cap is
 * applied *after* this, so that was a reachable denial of service. Two index
 * walks are O(n) by construction and need no reasoning about backtracking.
 */
function trimEdgeSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  // `charAt` (not `[i]`) so this stays correct under `noUncheckedIndexedAccess`.
  while (start < end && isEdgeSeparator(value.charAt(start))) start += 1;
  while (end > start && isEdgeSeparator(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/**
 * Reduce an OpenClaw identifier to something safe to embed in a user id.
 *
 * Session keys and channel-owned sender ids are opaque, provider-supplied
 * strings that can contain separators, spaces, or unicode. Cortadel treats a
 * user id as an opaque namespace anchor, but keeping it to a predictable
 * charset means the same conversation always resolves to the same namespace and
 * the id stays greppable in logs and the dashboard.
 */
export function sanitizeDiscriminator(value: string): string {
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-");
  return trimEdgeSeparators(collapsed).slice(0, MAX_DISCRIMINATOR);
}

/**
 * Best-effort agent id for a turn.
 *
 * Prefers the context's own `agentId`. OpenClaw session keys are
 * agent-scoped and conventionally prefixed with the agent id, so the prefix is
 * used as a fallback when the context did not carry one.
 */
export function resolveAgentId(identity: TurnIdentity): string | undefined {
  const direct = identity.agentId?.trim();
  if (direct) return direct;
  const key = identity.sessionKey?.trim();
  if (!key) return undefined;
  const [prefix] = key.split(":", 1);
  return prefix && prefix.length > 0 && prefix !== key ? prefix : undefined;
}

/**
 * Map one OpenClaw turn onto the Cortadel user id that owns its memories.
 *
 * - `fixed` (default) — every turn shares `baseUserId`. Correct for OpenClaw's
 *   primary shape, a single operator's personal assistant, and the only scope
 *   where memory carries across agents and conversations.
 * - `agent` / `session` / `sender` — suffix `baseUserId` with the relevant
 *   discriminator to get an isolated namespace per agent, per conversation, or
 *   per human in a shared chat.
 *
 * The scope narrows recall *and* capture together: both halves of a turn use
 * the id this returns, so an agent can never write into a namespace it cannot
 * read back from.
 *
 * When the chosen discriminator is unavailable for a turn this falls back to
 * `baseUserId` rather than inventing one, so memories land in a predictable
 * namespace instead of a scattering of anonymous ones.
 */
export function resolveUserId(scope: CortadelRecallScope, baseUserId: string, identity: TurnIdentity): string {
  if (scope === "fixed") return baseUserId;

  let raw: string | undefined;
  if (scope === "agent") raw = resolveAgentId(identity);
  else if (scope === "session") raw = identity.sessionKey ?? identity.sessionId;
  else if (scope === "sender") raw = identity.senderId;

  if (!raw) return baseUserId;
  const discriminator = sanitizeDiscriminator(raw);
  return discriminator.length > 0 ? `${baseUserId}:${discriminator}` : baseUserId;
}

/**
 * Stable per-conversation key for the recall ledger.
 *
 * Falls back through sessionKey → sessionId → agentId so a turn without a
 * session still gets a consistent bucket rather than sharing one global bucket
 * with every other agent.
 */
export function resolveSessionScopeKey(identity: TurnIdentity): string {
  return identity.sessionKey ?? identity.sessionId ?? identity.agentId ?? "__global__";
}
