/**
 * CLI summary-flag resolution context.
 *
 * Singleton that holds the resolved `--summary` flag for the current CLI
 * invocation. Set once in the global flag parser in `cli/index.ts`; read by
 * `cliOutput()` in `renderers/index.ts` to switch the render path AFTER
 * dispatch has produced the canonical envelope.
 *
 * Mirrors the format-context.ts / field-context.ts / output-context.ts pattern.
 *
 * Shape
 * -----
 * When `--summary` is passed, list-shaped and single-record envelopes are
 * re-rendered as one line per record:
 *
 *   `<id> [<status>] <title-truncated-60>`
 *
 * Precedence (highest to lowest)
 * ------------------------------
 * 1. `--field <pointer>` (T9929)        — single-field scalar projection wins.
 * 2. `--output {id|table|count|silent}` (T9930) — non-envelope modes win.
 * 3. `--summary` (T9932)                — 1-line-per-record re-render.
 * 4. Default `--output envelope` + format(json|human) — canonical paths.
 *
 * Rationale: `--summary` is a textual alternate render of the same envelope,
 * so the more specialised `--output` modes (which already short-circuit to
 * their own machine shapes) take precedence. `--field` always wins because
 * it short-circuits to a scalar before any other render path runs.
 *
 * @task T9932
 * @epic T9855
 */

/** Resolved `--summary` flag for the current CLI invocation. */
let currentSummary = false;

/**
 * Set the resolved `--summary` flag for this CLI invocation.
 * Called once from the global flag parser in `cli/index.ts`.
 */
export function setSummaryMode(on: boolean): void {
  currentSummary = on;
}

/** Get the current resolved `--summary` flag. */
export function getSummaryMode(): boolean {
  return currentSummary;
}
