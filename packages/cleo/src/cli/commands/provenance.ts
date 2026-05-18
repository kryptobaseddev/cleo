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
 *   cleo provenance verify [version]             — Phase 2 of T9493 (T9529).
 *     READ-ONLY audit of the 11 provenance tables for a release. Checks FK
 *     integrity, orphan rows, and ADR-051 evidence-atom staleness. Returns
 *     LAFS envelope with detailed pass/fail per category. Exit code 0 on
 *     pass, non-zero on any fail. `--all [--limit N]` verifies the
 *     most-recent N releases (default 5).
 *
 * Dispatches via `provenance.backfill` / `provenance.verify` operations to
 * the provenance domain handler. UPSERT semantics, idempotent, restartable
 * via checkpoint file at `.cleo/release/backfill-state.json`.
 *
 * @task T9528
 * @task T9529
 * @epic T9493
 * @adr  ADR-T9345 (IVTR-release-overhaul)
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §4.6, §8.3
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
 * cleo provenance verify — audit the 11 provenance tables for one or more
 * releases.
 *
 * Two modes:
 *   - Single-version: `cleo provenance verify <version>` — verifies one tag.
 *   - --all: `cleo provenance verify --all [--limit N]` — verifies the
 *     most-recent N releases (default 5).
 *
 * READ-ONLY: never writes to the DB. Returns a LAFS envelope with
 * `data.passed`, `data.categories`, and `data.releases[]`. Exit code 0 on
 * pass, non-zero on any category fail.
 */
const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description:
      'Audit the 11 provenance tables for a release (FK integrity, orphans, evidence staleness)',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to verify (e.g. v2026.6.0). Optional when --all is set.',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Verify the most-recent N releases instead of a single version',
    },
    limit: {
      type: 'string',
      description: 'How many releases to verify in --all mode (default 5)',
    },
    json: { type: 'boolean', description: 'Emit LAFS envelope' },
  },
  async run({ args }) {
    const version = typeof args.version === 'string' ? args.version : undefined;
    const all = args.all === true;
    const limitArg = typeof args.limit === 'string' ? args.limit : undefined;
    const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;

    await dispatchFromCli(
      'query',
      'provenance',
      'provenance.verify',
      {
        ...(version ? { version } : {}),
        all,
        ...(limit && Number.isFinite(limit) ? { limit } : {}),
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
    verify: verifyCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
