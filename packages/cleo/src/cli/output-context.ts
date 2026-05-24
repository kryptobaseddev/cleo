/**
 * CLI output-mode resolution context.
 *
 * Singleton that holds the resolved `--output <mode>` selection for the
 * current CLI invocation. Set once in the global flag parser in
 * `cli/index.ts`; read by `cliOutput()` in `renderers/index.ts` to switch
 * the render path AFTER dispatch has produced the canonical envelope.
 *
 * Mirrors the format-context.ts / field-context.ts pattern.
 *
 * Modes
 * -----
 * - `envelope` (default) — emit the canonical LAFS envelope JSON.
 * - `id` — for mutate ops, print just the created/updated id (one per line).
 *          For list ops, print one id per line.
 * - `table` — render data as an ASCII table on stdout. List → grouped
 *             id/status/priority/title columns. Other shapes fall back to
 *             a generic key-value flatten.
 * - `count` — print just the row count (single number).
 * - `silent` — suppress stdout on success; on failure still emit a 1-line
 *              error to stderr.
 *
 * Precedence with `--field` (T9929)
 * ---------------------------------
 * `--field` (single-field plain-text extraction) WINS when both flags are
 * specified. The `--output` mode applies to the canonical envelope shape;
 * `--field` short-circuits to a scalar projection before mode dispatch.
 *
 * @task T9930
 * @epic T9855
 */

/** All valid `--output` modes. The literal union backs the {@link OutputMode} type. */
export const OUTPUT_MODES = ['envelope', 'id', 'table', 'count', 'silent'] as const;

/** Resolved `--output` mode for the current CLI invocation. */
export type OutputMode = (typeof OUTPUT_MODES)[number];

/** Current mode. Defaults to `'envelope'` (the canonical LAFS payload). */
let currentMode: OutputMode = 'envelope';

/**
 * Set the resolved output mode for this CLI invocation.
 * Called once from the global flag parser in `cli/index.ts`.
 */
export function setOutputMode(mode: OutputMode): void {
  currentMode = mode;
}

/** Get the current resolved output mode. */
export function getOutputMode(): OutputMode {
  return currentMode;
}

/**
 * Type guard: confirm a raw string corresponds to a valid {@link OutputMode}.
 *
 * Used by the global flag parser to reject `--output bogus` at startup
 * BEFORE dispatch runs.
 */
export function isOutputMode(value: string): value is OutputMode {
  return (OUTPUT_MODES as readonly string[]).includes(value);
}
