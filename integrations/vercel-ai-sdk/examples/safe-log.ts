/**
 * Printing a model's reply straight to the console is log injection.
 *
 * Model output is untrusted text — it is shaped by whatever the user, a retrieved document or a
 * tool result put in front of the model. Carriage returns and newlines let it forge whole log
 * lines ("... ERROR auth: admin login succeeded"), and an ESC byte starts an ANSI sequence that
 * can repaint or clear the terminal reading the log. The same applies to anything you echo from
 * memory, since memory is user-written by definition.
 *
 * These examples print model text through the helper below rather than dropping the output, which
 * is the practice worth copying into your own handlers.
 */

/**
 * `\p{Cc}` is the Unicode "control" category: C0 (NUL through US, so CR, LF and the ESC that
 * begins every ANSI sequence) plus DEL and C1. Written as a property escape rather than a literal
 * range so no control character has to appear in this file's source.
 */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/** Renders any value as a single console-safe line. */
export function logSafe(value: unknown): string {
  return String(value).replace(CONTROL_CHARACTERS, " ");
}
