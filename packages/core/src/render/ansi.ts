/**
 * Minimal ANSI escape primitives used by the shared render helpers.
 *
 * Kept tiny and self-contained so `@cleocode/core/render` has zero coupling
 * to the cleo CLI's larger colors module. Respects `NO_COLOR` and
 * `FORCE_COLOR` envs the same way (https://no-color.org).
 *
 * @task T10129
 */

/** Whether ANSI color escape codes should be emitted. */
const colorsEnabled: boolean = (() => {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return process.stdout.isTTY === true;
})();

function ansi(code: string): string {
  return colorsEnabled ? code : '';
}

/** Bold text. */
export const BOLD = ansi('\x1b[1m');
/** Dim text. */
export const DIM = ansi('\x1b[2m');
/** Reset (no-color). */
export const NC = ansi('\x1b[0m');
