/**
 * Suppresses the ExperimentalWarning for node:sqlite.
 *
 * Node.js writes ExperimentalWarnings to stderr via `process.emitWarning`
 * before emitting the 'warning' event. Monkeypatching `process.emitWarning`
 * at the point of module load is the only JS-level suppression that works
 * for programmatic consumers who do not use the `cleo` CLI wrapper.
 *
 * This module is imported at the top of every main entry point to ensure
 * suppression is active before `node:sqlite` or `drizzle-orm/node-sqlite`
 * are loaded.
 *
 * @package @cleocode/core
 */

const SQLITE_EXPERIMENTAL_MSG = 'SQLite is an experimental feature';

const originalEmitWarning = process.emitWarning;

// biome-ignore lint/suspicious/noExplicitAny: process.emitWarning has complex overloads that cannot be matched by a single function type.
(process as unknown as { emitWarning: any }).emitWarning = function (
  this: typeof process,
  warning: string | Error,
  ...args: unknown[]
): void {
  const message = typeof warning === 'string' ? warning : (warning as Error | undefined)?.message;
  if (message && message.includes(SQLITE_EXPERIMENTAL_MSG)) {
    return;
  }
  // biome-ignore lint/suspicious/noExplicitAny: forwarding to original emitWarning overloads
  (originalEmitWarning as any).apply(this, [warning, ...args]);
};
