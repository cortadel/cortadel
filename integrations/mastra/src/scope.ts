import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";

import type { CortadelConnectionOptions, CortadelScope, RequestContextLike } from "./types.js";

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pull `resourceId` / `threadId` off the message list.
 *
 * Every `MastraDBMessage` carries optional `threadId` and `resourceId`
 * (`@mastra/core/dist/agent/message-list/state/types.d.ts`, `MastraMessageShared`).
 * The newest message wins, so a thread that changes hands mid-list resolves to
 * the current owner.
 */
export function scopeFromMessages(messages: readonly unknown[] | undefined): CortadelScope {
  const scope: CortadelScope = {};
  if (!messages) return scope;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { resourceId?: unknown; threadId?: unknown } | null;
    if (!message || typeof message !== "object") continue;
    scope.resourceId ??= asNonEmptyString(message.resourceId);
    scope.threadId ??= asNonEmptyString(message.threadId);
    if (scope.resourceId && scope.threadId) break;
  }
  return scope;
}

/**
 * Read `resourceId` / `threadId` out of a Mastra `RequestContext`.
 *
 * Callers set these under the framework's own well-known keys
 * (`MASTRA_RESOURCE_ID_KEY` = `"mastra__resourceId"`,
 * `MASTRA_THREAD_ID_KEY` = `"mastra__threadId"`, from
 * `@mastra/core/request-context`), which is how a server hands an authenticated
 * user id down to an agent run.
 */
export function scopeFromRequestContext(requestContext: RequestContextLike | undefined): CortadelScope {
  if (!requestContext || typeof requestContext.get !== "function") return {};
  try {
    return {
      resourceId: asNonEmptyString(requestContext.get(MASTRA_RESOURCE_ID_KEY)),
      threadId: asNonEmptyString(requestContext.get(MASTRA_THREAD_ID_KEY)),
    };
  } catch {
    // A typed RequestContext can throw on an unknown key; never let that
    // bubble into the agent run.
    return {};
  }
}

/** Merge scope fragments, earliest non-empty value winning per field. */
export function mergeScopes(...scopes: readonly (CortadelScope | undefined)[]): CortadelScope {
  const merged: CortadelScope = {};
  for (const scope of scopes) {
    if (!scope) continue;
    merged.resourceId ??= scope.resourceId;
    merged.threadId ??= scope.threadId;
    merged.requestContext ??= scope.requestContext;
  }
  return merged;
}

/**
 * Decide which Cortadel user id owns this run.
 *
 * Precedence: `resolveUserId(scope)` → the pinned `userId` option → Mastra's
 * `resourceId`. Returns `undefined` when none of the three yields a value, in
 * which case the caller must skip the Cortadel call rather than guess.
 */
export function resolveUserId(
  scope: CortadelScope,
  options: Pick<CortadelConnectionOptions, "userId" | "resolveUserId">,
): string | undefined {
  const resolved = options.resolveUserId?.(scope);
  if (typeof resolved === "string" && resolved.length > 0) return resolved;
  if (options.userId) return options.userId;
  return scope.resourceId;
}
