/**
 * `@cleocode/core/render` — shared `--human` rendering primitives.
 *
 * Pure formatting helpers (no stdout writes, no side effects) used by the
 * CLI thin shell and any other surface that needs to format LAFS envelopes
 * for human consumption. Originally lived under `packages/cleo/src/cli/
 * renderers/format-helpers.ts`; migrated here per AGENTS.md
 * Package-Boundary Check.
 *
 * @task T10129
 */

export * from './helpers.js';
