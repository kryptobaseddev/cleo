/**
 * SSoT wrapper for citty's `defineCommand` (T10072 · Epic T9837 · Saga T9831
 * SG-ARCH-SOLID). This is the ONLY file in `packages/cleo/src/` that is
 * allowed to import `defineCommand` directly from 'citty' — every other CLI
 * command MUST import from here.
 *
 * The wrapper currently re-exports `defineCommand` and `showUsage` as-is.
 * Future SG-ARCH-SOLID work will hang middleware here (telemetry, dispatch
 * banner injection, deprecation warning surfacing, etc.) without rewriting
 * every command-file import.
 *
 * Enforcement
 * -----------
 * `scripts/lint-no-raw-define-command.mjs` runs in `--check` mode in CI and
 * fails when the count of raw `defineCommand` imports from 'citty' under
 * `packages/cleo/src/` exceeds the baseline in
 * `.cleo/define-command-ssot-baseline.json`. Net-new commands MUST import
 * from this wrapper to keep the count flat (or shrink it).
 *
 * @epic T9837
 * @saga T9831
 * @task T10103 — new release ship-e2e-smoke command first consumer
 * @task T10072 — SSoT enforcement gate baseline
 */

export type { ArgDef, CommandDef } from 'citty';
// define-command-ssot-allowed
export { defineCommand, showUsage } from 'citty';
