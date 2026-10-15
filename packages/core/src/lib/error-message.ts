/**
 * Bounded, single-line formatting for thrown values in warnings and logs.
 *
 * Drizzle (and other query builders) interpolate the full SQL text and every
 * bound parameter into `error.message` — on a large failed query that is
 * hundreds of kilobytes on one line of stderr (observed: ~900 KB per docs
 * write on axiom-app, T13711). Warnings should carry the driver cause (the
 * small, actionable "why"), never the parameter dump.
 *
 * Dependency-free; safe to import from any layer (lib barrel contract).
 *
 * @task T13711
 */

/**
 * Default cap for a formatted error message, in characters.
 *
 * Chosen to keep a full warning line well under typical log-pipeline line
 * limits while preserving the actionable prefix (error class + SQLSTATE /
 * SQLite extended code + short context).
 */
const DEFAULT_MAX_LENGTH = 500;

/**
 * Format an unknown thrown value as a single-line, length-capped message.
 *
 * Prefers the deepest wrapped driver cause (the end of the `error.cause`
 * chain) — the underlying SQLite/driver error, which does not contain the
 * parameter dump — and falls back to the outer message. Everything from a
 * drizzle `params:` section onward is cut, then whitespace runs collapse to
 * single spaces so multi-line dumps cannot flood the log even before the cap.
 *
 * @param err - The thrown value (anything `throw`-able).
 * @param maxLength - Character cap for the message body. Default 500.
 * @returns A single-line message: at most `maxLength` characters of the
 *   message, followed (only when cut) by `… [truncated N chars]`, where N is
 *   the number of characters removed.
 */
export function boundedErrorMessage(err: unknown, maxLength: number = DEFAULT_MAX_LENGTH): string {
  let deepest = err;
  const seen = new Set<unknown>([err]);
  while (deepest instanceof Error && deepest.cause instanceof Error && !seen.has(deepest.cause)) {
    deepest = deepest.cause;
    seen.add(deepest);
  }
  let raw: string;
  if (deepest instanceof Error) {
    raw = deepest === err ? deepest.message : `${deepest.name}: ${deepest.message}`;
  } else {
    try {
      raw = String(deepest);
    } catch {
      // String() throws for values with no toString, e.g. Object.create(null).
      raw = '[unprintable thrown value]';
    }
  }
  const singleLine = raw
    .replace(/(?:\n| )params:[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}… [truncated ${singleLine.length - maxLength} chars]`;
}
