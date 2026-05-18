/**
 * CLI provenance command group — provenance-graph maintenance verbs.
 *
 * Commands:
 *   cleo provenance backfill --since <version>   — Phase 2 of T9493 (T9528).
 *     Walks historical git tags from `--since` forward and populates the 11
 *     provenance tables (commits, task_commits, commit_files, pull_requests,
 *     pr_commits, pr_tasks, releases, release_commits, release_changes,
 *     release_artifacts, brain_release_links) for every release in the range.
 *
 * Dispatches via `provenance.backfill` operation to the provenance domain
 * handler. UPSERT semantics, idempotent, restartable via checkpoint file at
 * `.cleo/release/backfill-state.json`.
 *
 * @task T9528
 * @epic T9493
 * @adr  ADR-T9345 (IVTR-release-overhaul)
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §8.3
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo provenance backfill — walk historical tags + populate provenance tables.
 *
 * Required: `--since <version>` (exclusive lower bound — tags strictly newer
 * than this are reconciled). Pass an empty string `--since ""` to walk every
 * reachable tag from the beginning of history.
 *
 * Idempotent: re-running over already-reconciled tags is a no-op (reconcile
 * short-circuits when `releases.status='reconciled'`).
 *
 * Restartable: per-tag checkpoint at `.cleo/release/backfill-state.json`. If
 * Ctrl-C interrupts mid-walk, the next invocation resumes from the next
 * un-processed tag.
 */
const backfillCommand = defineCommand({
  meta: {
    name: 'backfill',
    description: 'Walk historical git tags from --since and populate the 11 provenance tables',
  },
  args: {
    since: {
      type: 'string',
      description:
        'Lower-bound version (exclusive). Tags newer than this are reconciled. Empty string = all tags.',
      required: true,
    },
    'force-overwrite': {
      type: 'boolean',
      description:
        'UPDATE existing rows on conflict (audit-logged). Default: UPSERT-on-insert only.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Enumerate the tag set + return the plan without writing to the DB',
    },
    'reset-checkpoint': {
      type: 'boolean',
      description:
        'Clear the existing .cleo/release/backfill-state.json before starting (do NOT resume)',
    },
    json: { type: 'boolean', description: 'Emit LAFS envelope' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'provenance',
      'provenance.backfill',
      {
        since: args.since,
        forceOverwrite: args['force-overwrite'] === true,
        dryRun: args['dry-run'] === true,
        resetCheckpoint: args['reset-checkpoint'] === true,
      },
      { command: 'provenance' },
    );
  },
});

/**
 * Root provenance command group — provenance-graph maintenance.
 *
 * Houses every verb that operates on the 11-table provenance graph WITHOUT
 * driving a release lifecycle transition. `cleo release reconcile` stays on
 * the release group because it is a step in the canonical 5-state FSM.
 */
export const provenanceCommand = defineCommand({
  meta: {
    name: 'provenance',
    description: 'Provenance-graph maintenance: backfill, verify, repair',
  },
  subCommands: {
    backfill: backfillCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
