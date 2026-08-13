/**
 * Uniform failure reporting for every Cortadel call this package makes.
 *
 * Two knobs, and they are orthogonal on purpose:
 *
 * - `throwOnError` (`boolean`, default `false`) — propagate the failure to the caller.
 * - `onError` (callback, default `undefined`) — *observe* the failure. Always a callback, never a
 *   mode string.
 *
 * Fail-open is the default: a memory outage must never take the agent down. When a failure is
 * swallowed and no `onError` callback is set, it is reported through `console.warn` instead — an
 * observer and a log line are the same mechanism at different volumes, so there is no separate
 * "warn" / "ignore" mode.
 */

import { CortadelError } from "@cortadel/sdk";

/** Observer invoked with the error a Cortadel call threw. */
export type OnErrorCallback = (error: unknown) => void;

/** `code: message` for a `CortadelError`, `name: message` for anything else. */
export function describeError(error: unknown): string {
  if (error instanceof CortadelError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Hand `error` to `onError`. Returns whether an observer actually saw it.
 *
 * A callback that throws is itself swallowed and logged: an observer must not be able to take the
 * agent down through the very path that exists to keep it running.
 */
export function notifyError(
  onError: OnErrorCallback | undefined,
  action: string,
  error: unknown,
): boolean {
  if (!onError) return false;
  try {
    onError(error);
  } catch (callbackError) {
    console.warn(
      `@cortadel/deepagents: the onError callback threw while reporting a ${action} failure.`,
      callbackError,
    );
  }
  return true;
}

/**
 * Report a Cortadel failure, then swallow it — or rethrow it under `throwOnError`.
 *
 * `onError` observes every failure, including the ones that go on to be rethrown: the two options
 * are orthogonal, one reports and one decides. A swallowed failure with no observer falls back to
 * a `console.warn`.
 */
export function reportFailure(
  action: string,
  error: unknown,
  options: { throwOnError?: boolean; onError?: OnErrorCallback },
): string {
  const detail = describeError(error);
  const observed = notifyError(options.onError, action, error);
  if (options.throwOnError) throw error;
  if (!observed) {
    console.warn(
      `@cortadel/deepagents: ${action} failed (${detail}); continuing without memory.`,
    );
  }
  return detail;
}
