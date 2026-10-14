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
 * Prefers the wrapped driver cause (`error.cause`) — the underlying
 * SQLite/driver error, which does not contain the parameter dump — and falls
 * back to the outer message hard-capped. Whitespace runs collapse to single
 * spaces so multi-line drizzle dumps cannot flood the log even before the cap.
 *
 * @param err - The thrown value (anything `throw`-able).
 * @param maxLength - Character cap for the result. Default 500.
 * @returns A single-line message, at most `maxLength + 16` characters.
 */
export function boundedErrorMessage(err: unknown, maxLength: number = DEFAULT_MAX_LENGTH): string {
  const cause = err instanceof Error ? err.cause : undefined;
  const raw =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength)}… [truncated ${singleLine.length} chars]`;
}
