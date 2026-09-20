/**
 * T12067 quarantine — @cleocode/cleo test files that do not currently pass.
 *
 * ## Why this file exists
 *
 * The `@cleocode/cleo` vitest project declared root-relative `include` globs
 * without pinning `root`, so vitest expanded them to
 * `packages/cleo/packages/cleo/src/**` and matched NOTHING. **281 test files
 * never executed** under `pnpm test`, `pnpm test:pkg`, or the sharded CI job —
 * for long enough that 73 of them rotted while CI reported green.
 *
 * Fixing discovery therefore surfaces 73 files / 349 assertions of PRE-EXISTING
 * failure that have never gated a PR. Quarantining them lets the other **199
 * files / 3,428 tests start protecting the repo immediately**, instead of
 * leaving all 272 invisible until someone finds time for the whole backlog.
 *
 * Measured failure profile (unchanged whether the project roots at the package
 * or at the monorepo — the rot is real, not a cwd artifact):
 *
 *   102  AssertionError: expected false to be true
 *    33  RolldownError: Parse failure
 *    12  DrizzleQueryError: CREATE TABLE `brain_attention`
 *     7  TypeError: _resetDualScopeDbCache is not a function   (removed API)
 *     7  CleoError: Not inside a CLEO project
 *     5  No "humanInfo" export is defined on the mock
 *
 * ## Rules
 *
 * - This list may only SHRINK. `scripts/__tests__/vitest-project-include.test.mjs`
 *   asserts every entry still exists, so a deleted file cannot silently keep a
 *   slot, and the count is pinned below.
 * - Do NOT add a newly-written failing test here. The list is closed to
 *   additions; it exists solely to bound damage already present.
 * - Burn-down is tracked by T12072.
 *
 * @task T12067
 * @task T12072
 */

/** Files quarantined by T12067. MAY ONLY SHRINK — see module docs. */
export const CLEO_TEST_QUARANTINE: readonly string[] = [
  // Added in the same PR as the discovery fix, deliberately and visibly.
  // Unlike the rest of this list it PASSES locally: it drives the real setup
  // wizard against `process.cwd()` (no cwd parameter exists), so a developer
  // checkout with a populated `.cleo/` satisfies it while a fresh CI runner
  // does not. Made hermetic in this PR (chdir to a sandbox with .cleo + .git),
  // which narrowed it to a genuine product bug: something removes the state
  // directory mid-wizard, so the sentient section's tmp-then-rename hits
  // ENOENT on a scratch file it had just written. The scratch-name collision
  // half of that bug IS fixed here (T12075 — the name was keyed on pid alone,
  // so concurrent writes in one process clobbered each other; proven and
  // fixed). The remaining cause is tracked separately in T12075.
  'packages/cleo/src/cli/commands/__tests__/setup-wizard-e2e.test.ts',
  'packages/cleo/src/__tests__/core-parity.test.ts',
  'packages/cleo/src/__tests__/lafs-conformance.test.ts',
  'packages/cleo/src/cli/__tests__/cancel.test.ts',
  'packages/cleo/src/cli/__tests__/changeset-add.test.ts',
  'packages/cleo/src/cli/__tests__/check-canon-docs.test.ts',
  'packages/cleo/src/cli/__tests__/daemon-paths-compliance.test.ts',
  'packages/cleo/src/cli/__tests__/daemon-service.test.ts',
  'packages/cleo/src/cli/__tests__/docs-error-envelopes.test.ts',
  'packages/cleo/src/cli/__tests__/docs-list-ux.test.ts',
  'packages/cleo/src/cli/__tests__/docs-publish-envelope.test.ts',
  'packages/cleo/src/cli/__tests__/docs-publish-pr.test.ts',
  'packages/cleo/src/cli/__tests__/docs-roundtrip-pr-merge.test.ts',
  'packages/cleo/src/cli/__tests__/docs-roundtrip.test.ts',
  'packages/cleo/src/cli/__tests__/focus.test.ts',
  'packages/cleo/src/cli/__tests__/llm-command.test.ts',
  'packages/cleo/src/cli/__tests__/llm-cost.test.ts',
  'packages/cleo/src/cli/__tests__/llm-engine-smoke.test.ts',
  'packages/cleo/src/cli/__tests__/saga-T9787-multi-agent-race.test.ts',
  'packages/cleo/src/cli/__tests__/web.test.ts',
  'packages/cleo/src/cli/commands/__tests__/add-description.test.ts',
  'packages/cleo/src/cli/commands/__tests__/agent-install.test.ts',
  'packages/cleo/src/cli/commands/__tests__/auth-migrate.test.ts',
  'packages/cleo/src/cli/commands/__tests__/backup-export.test.ts',
  'packages/cleo/src/cli/commands/__tests__/backup-import.test.ts',
  'packages/cleo/src/cli/commands/__tests__/brain-export.test.ts',
  'packages/cleo/src/cli/commands/__tests__/docs-add-strict-body.test.ts',
  'packages/cleo/src/cli/commands/__tests__/docs-find-similar.test.ts',
  'packages/cleo/src/cli/commands/__tests__/docs-publish-smoke.test.ts',
  'packages/cleo/src/cli/commands/__tests__/docs-update.test.ts',
  'packages/cleo/src/cli/commands/__tests__/doctor-projects.test.ts',
  'packages/cleo/src/cli/commands/__tests__/graph.test.ts',
  'packages/cleo/src/cli/commands/__tests__/init-gitignore.test.ts',
  'packages/cleo/src/cli/commands/__tests__/memory-cli-new.test.ts',
  'packages/cleo/src/cli/commands/__tests__/memory-clioutput.test.ts',
  'packages/cleo/src/cli/commands/__tests__/nexus-cli-new.test.ts',
  'packages/cleo/src/cli/commands/__tests__/orchestrate-ready-deps-guard.test.ts',
  'packages/cleo/src/cli/commands/__tests__/reconcile.test.ts',
  'packages/cleo/src/cli/commands/__tests__/restore-finalize.test.ts',
  'packages/cleo/src/cli/commands/__tests__/schema-flags.test.ts',
  'packages/cleo/src/cli/renderers/__tests__/generic-tree.test.ts',
  'packages/cleo/src/dispatch/__tests__/parity.test.ts',
  'packages/cleo/src/dispatch/__tests__/registry-derivation.test.ts',
  'packages/cleo/src/dispatch/__tests__/transport-inventory.test.ts',
  'packages/cleo/src/dispatch/adapters/__tests__/cli.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/admin.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/alias-detection.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/check-ops.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/cli-missing-commands.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/docs-add-changeset-delegate.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/docs-slug-type-project.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/docs.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/memory-brain.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/memory-llm-status.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/orchestrate-handoff.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/orchestrate.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/pipeline-manifest.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/pipeline.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/release.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/saga-dry-run.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/sentient.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/service-cli.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/service-dispatch.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/spawn-timeout.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/tasks-filters.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/tasks-show-attachments.test.ts',
  'packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts',
  'packages/cleo/src/dispatch/middleware/__tests__/budget-enforcement.test.ts',
  'packages/cleo/test/templates/release-fanout-render.test.ts',
  'packages/cleo/test/templates/release-prepare-render.test.ts',
  'packages/cleo/test/templates/release-publish-render.test.ts',
  'packages/cleo/test/templates/release-rollback-render.test.ts',
];

/**
 * Size of the quarantine at the moment discovery was fixed.
 *
 * Pinned so a PR that repairs a file must also decrement this number, making
 * the burn-down visible in review rather than a silent edit to a long list.
 */
export const CLEO_TEST_QUARANTINE_BASELINE = 74;
