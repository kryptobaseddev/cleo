/**
 * Simple logger with verbose/quiet mode support.
 *
 * - verbose: enables debug output to stderr
 * - quiet: suppresses info and warn output (errors always shown)
 */

let verboseMode = false;
let quietMode = false;
let humanMode = false;

/**
 * Enable or disable verbose (debug) logging mode.
 *
 * When enabled, debug messages are written to stderr.
 *
 * @param v - `true` to enable verbose mode, `false` to disable
 *
 * @remarks
 * Typically called once during CLI initialization based on the `--verbose` flag.
 *
 * @example
 * ```typescript
 * setVerbose(true);
 * ```
 *
 * @public
 */
export function setVerbose(v: boolean): void {
  verboseMode = v;
}

/**
 * Enable or disable quiet mode.
 *
 * When enabled, info and warning messages are suppressed. Errors are always shown.
 *
 * @param q - `true` to enable quiet mode, `false` to disable
 *
 * @remarks
 * Typically called once during CLI initialization based on the `--quiet` flag.
 *
 * @example
 * ```typescript
 * setQuiet(true);
 * ```
 *
 * @public
 */
export function setQuiet(q: boolean): void {
  quietMode = q;
}

/**
 * Log a debug message to stderr when verbose mode is enabled.
 *
 * @remarks
 * Messages are prefixed with `[debug]` and written to stderr. No output is
 * produced when verbose mode is disabled.
 *
 * @param args - Values to log (forwarded to `console.error`)
 *
 * @example
 * ```typescript
 * debug("Loading config from", filePath);
 * ```
 *
 * @public
 */
export function debug(...args: unknown[]): void {
  if (verboseMode) console.error("[debug]", ...args);
}

/**
 * Log an informational message to stdout.
 *
 * @remarks
 * Output is suppressed when quiet mode is enabled.
 *
 * @param args - Values to log (forwarded to `console.log`)
 *
 * @example
 * ```typescript
 * info("Installed 3 skills");
 * ```
 *
 * @public
 */
export function info(...args: unknown[]): void {
  if (!quietMode) console.log(...args);
}

/**
 * Log a warning message to stderr.
 *
 * @remarks
 * Output is suppressed when quiet mode is enabled.
 *
 * @param args - Values to log (forwarded to `console.warn`)
 *
 * @example
 * ```typescript
 * warn("Deprecated option used");
 * ```
 *
 * @public
 */
export function warn(...args: unknown[]): void {
  if (!quietMode) console.warn(...args);
}

/**
 * Log an error message to stderr.
 *
 * @remarks
 * Errors are always displayed regardless of quiet mode.
 *
 * @param args - Values to log (forwarded to `console.error`)
 *
 * @example
 * ```typescript
 * error("Failed to install skill:", err.message);
 * ```
 *
 * @public
 */
export function error(...args: unknown[]): void {
  console.error(...args);
}

/**
 * Check if verbose (debug) logging is currently enabled.
 *
 * @remarks
 * Useful for conditionally performing expensive formatting only when verbose
 * output is requested.
 *
 * @returns `true` if verbose mode is active
 *
 * @example
 * ```typescript
 * if (isVerbose()) {
 *   console.error("Extra debug info");
 * }
 * ```
 *
 * @public
 */
export function isVerbose(): boolean {
  return verboseMode;
}

/**
 * Check if quiet mode is currently enabled.
 *
 * @remarks
 * Commands use this to skip non-essential output when the user requested quiet
 * operation.
 *
 * @returns `true` if quiet mode is active
 *
 * @example
 * ```typescript
 * if (!isQuiet()) {
 *   console.log("Status message");
 * }
 * ```
 *
 * @public
 */
export function isQuiet(): boolean {
  return quietMode;
}

/**
 * Enable or disable human-readable output mode.
 *
 * When enabled, commands output human-readable format instead of JSON.
 *
 * @param h - `true` to enable human mode, `false` to disable
 *
 * @remarks
 * Typically called once during CLI initialization based on the `--human` flag.
 *
 * @example
 * ```typescript
 * setHuman(true);
 * ```
 *
 * @public
 */
export function setHuman(h: boolean): void {
  humanMode = h;
}

/**
 * Check if human-readable output mode is currently enabled.
 *
 * @remarks
 * Commands use this to decide between structured JSON output and
 * human-friendly formatted output.
 *
 * @returns `true` if human mode is active
 *
 * @example
 * ```typescript
 * if (isHuman()) {
 *   console.log("Human readable output");
 * } else {
 *   console.log(JSON.stringify(data));
 * }
 * ```
 *
 * @public
 */
export function isHuman(): boolean {
  return humanMode;
}
