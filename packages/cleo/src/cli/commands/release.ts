/**
 * CLI release command group — release lifecycle management.
 *
 * Canonical 4-verb pipeline (SPEC-T9345):
 *   cleo release plan <version> --epic <id>  — build the Release Plan envelope
 *   cleo release open <version>              — dispatch release-prepare workflow
 *   cleo release reconcile <version>         — post-publish provenance backfill
 *   cleo release rollback <version>          — roll back a shipped release
 *
 * One-shot end-to-end smoke (dry-run by default — see ship-e2e-smoke.ts):
 *   cleo release ship-e2e-smoke <version> --epic <id> [--execute]
 *
 * Read-only helpers:
 *   cleo release list / show / cancel / pr-status / channel
 *
 * The legacy `ship` deprecation shim was deleted in T10103 (post-T9540
 * cleanup). The replacement surface is the explicit `plan` + `open` flow
 * documented in `docs/release/verb-matrix.md`. The new
 * `ship-e2e-smoke` verb replaces `ship` for end-to-end validation use
 * cases (it actually waits for PR + tag + npm publish before returning).
 *
 * @task T4467
 * @task T820
 * @task T9540 — Phase 6 cleanup: remove legacy start/verify/publish CLI verbs
 *               + `--workflow=false` escape hatch (their backing functions
 *               in pipeline.ts and releaseShip in engine-ops.ts were
 *               deleted alongside this change)
 * @task T9784 — rip out `release changelog` verb + release.changelog.* engine
 *               ops in favor of the canonical `cleo changeset add` +
 *               `cleo release plan` flow (Saga T9782 — single canonical
 *               system, no deprecation window)
 * @task T10103 — delete the deprecated `ship` shim + add `ship-e2e-smoke`
 *                (Saga T10099 release audit v2)
 * @epic T9498 — release v2 cutover
 * @epic T9499 — Phase 6 cleanup epic
 */

import { release } from '@cleocode/core';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';
import { shipE2eSmokeCommand } from './release/ship-e2e-smoke.js';

/** cleo release list — list all releases */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all releases' },
  async run() {
    await dispatchFromCli('query', 'pipeline', 'release.list', {}, { command: 'release' });
  },
});

/** cleo release show — show details for a specific release */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show release details' },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to show',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'release.show',
      { version: args.version },
      { command: 'release' },
    );
  },
});

/** cleo release cancel — cancel and remove a release in draft or prepared state */
const cancelCommand = defineCommand({
  meta: {
    name: 'cancel',
    description: 'Cancel and remove a release in draft or prepared state',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to cancel',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'release.cancel',
      { version: args.version },
      { command: 'release' },
    );
  },
});

/** cleo release rollback — roll back a shipped release (metadata only, no git ops) */
const rollbackCommand = defineCommand({
  meta: {
    name: 'rollback',
    description: 'Roll back a shipped release (marks it as rolled-back in CLEO records)',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to roll back',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for rollback',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'release.rollback',
      {
        version: args.version,
        reason: args.reason as string | undefined,
      },
      { command: 'release' },
    );
  },
});

/**
 * cleo release rollback-full — real rollback: delete git tag, revert commit, remove record.
 *
 * Unlike release.rollback (which only flips the status field in the DB),
 * this performs actual git operations to undo the release.
 *
 * @task T820 RELEASE-05
 */
const rollbackFullCommand = defineCommand({
  meta: {
    name: 'rollback-full',
    description: 'Full rollback: delete git tag, revert commit, remove release record',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version to fully roll back (e.g. 2026.4.77)',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for rollback',
    },
    force: {
      type: 'boolean',
      description: 'Continue even if some git operations fail',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'release.rollback.full',
      {
        version: args.version,
        reason: args.reason as string | undefined,
        force: args.force,
      },
      { command: 'release' },
    );
  },
});

/**
 * cleo release pr-status <version> — poll CI check status for an in-progress release PR.
 *
 * Resolves the open PR for the release branch `release/v<version>` and returns
 * the current GitHub CI check statuses.  Useful for manual polling when
 * `cleo release open` is dispatched and the operator wants to track CI
 * health while waiting for the release PR to go green.
 *
 * @task T9095
 */
const prStatusCommand = defineCommand({
  meta: {
    name: 'pr-status',
    description: 'Poll CI check status for an in-progress release PR (T9095)',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version (e.g. 2026.5.43)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'release.pr-status',
      { version: args.version },
      { command: 'release' },
    );
  },
});

/** cleo release channel — show the current release channel based on git branch */
const channelCommand = defineCommand({
  meta: {
    name: 'channel',
    description: 'Show the current release channel based on git branch (latest/beta/alpha)',
  },
  async run() {
    await dispatchFromCli('query', 'pipeline', 'release.channel.show', {}, { command: 'release' });
  },
});

/**
 * cleo release validate-changelog <version> — canonical CHANGELOG.md header
 * validator. Replaces the brittle `grep -qF "## [VERSION]"` step in
 * `.github/workflows/release.yml` (and any consumer-shipped release workflow)
 * with a typed CLEO verb that:
 *
 *  - Normalises both `v2026.5.94` and `2026.5.94` inputs to the canonical
 *    no-v header form (ADR-028 §2.5).
 *  - Returns a LAFS envelope with `valid`, `headerFound`, and a
 *    human-readable `reason` when the gate fails.
 *  - Exits non-zero on `valid=false` so CI workflows can treat it as a hard
 *    gate (the dispatch layer's `wrapResult` already surfaces the error
 *    envelope and sets the process exit code).
 *
 * @task T9937
 * @saga T9862
 * @adr ADR-028 §2.5
 */
const validateChangelogCommand = defineCommand({
  meta: {
    name: 'validate-changelog',
    description: 'Validate that CHANGELOG.md contains the canonical `## [VERSION]` header (T9937)',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version (accepts v2026.5.94 or 2026.5.94)',
      required: true,
    },
    path: {
      type: 'string',
      description: 'Override the CHANGELOG file path (default: <projectRoot>/CHANGELOG.md)',
      required: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'release',
      'validate-changelog',
      {
        version: args.version,
        ...(typeof args.path === 'string' && args.path.length > 0
          ? { changelogPath: args.path }
          : {}),
      },
      { command: 'release' },
    );
  },
});

// ---------------------------------------------------------------------------
// Canonical SPEC-T9345 release pipeline v2 (T9492 / T9494 / T9495)
//
// Legacy 4-step verbs (`start`, `verify`, `publish`) and their backing
// functions in `packages/core/src/release/pipeline.ts` were deleted in
// T9540 (Phase 6 of T9499) — superseded by `plan` / `open` / `reconcile`.
// `cleo verify <task> --gate X --evidence …` replaces `release verify` per
// SPEC-T9345 §12 R-422 / ADR-051.
// ---------------------------------------------------------------------------

/**
 * cleo release plan — Phase 1 verb of SPEC-T9345 release pipeline v2.
 *
 * Builds the canonical Release Plan envelope from `tasks.db` + git log +
 * previous-release state; writes `.cleo/release/<resolved-version>.plan.json`;
 * INSERTs/UPDATEs one row in the `releases` table with `status='planned'`.
 *
 * Read-mostly: NO git mutations, NO `gh` calls, NO network. Only writes are
 * the plan file under `.cleo/release/` and the `releases` table row.
 *
 * @task T9525
 * @epic T9492
 * @spec SPEC-T9345 §4.2
 */
const planCommand = defineCommand({
  meta: {
    name: 'plan',
    description: 'Build the canonical Release Plan envelope and persist status=planned (T9525)',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Candidate release version (e.g. v2026.6.0 or 2026.6.0)',
      required: true,
    },
    epic: {
      type: 'string',
      description: 'Epic task ID — children (or leaf Epic itself per ADR-073) are candidates',
      required: false,
    },
    saga: {
      type: 'string',
      description:
        'Saga task ID — walks task_relations type=groups to aggregate member Epics (ADR-073). Mutually exclusive with --epic. (T9838)',
      required: false,
    },
    scheme: {
      type: 'string',
      description: 'Versioning scheme: calver | semver | calver-suffix',
    },
    channel: {
      type: 'string',
      description: 'Release channel: latest | beta | alpha | rc',
    },
    hotfix: {
      type: 'boolean',
      description: 'Mark plan as release_kind=hotfix',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Compute plan + envelope without writing the plan file or DB row',
    },
    'no-changelog': {
      type: 'boolean',
      description:
        'Skip CHANGELOG.md auto-write (default: write/replace the ## [<version>] section). (T9838)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'release',
      'plan',
      {
        version: args.version,
        epicId: args.epic,
        sagaId: args.saga,
        scheme: args.scheme as string | undefined,
        channel: args.channel as string | undefined,
        hotfix: args.hotfix === true,
        dryRun: args['dry-run'] === true,
        writeChangelog: args['no-changelog'] !== true,
      },
      { command: 'release' },
    );
  },
});

/**
 * cleo release open <version> — Phase 3 of the new release pipeline (T9530).
 *
 * Consumes `.cleo/release/<version>.plan.json`, dispatches the
 * `release-prepare.yml` workflow via `gh workflow run`, and UPDATEs the
 * `releases` row's status to `pr-opened`. Implements SPEC-T9345 §4.3.
 *
 * @task T9530
 * @epic T9494
 * @spec SPEC-T9345 §4.3
 */
const openCommand = defineCommand({
  meta: {
    name: 'open',
    description: 'Dispatch release-prepare workflow + transition releases.status to pr-opened',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Release version (e.g. v2026.6.0)',
      required: true,
    },
    workflow: {
      type: 'string',
      description: 'Workflow file to dispatch (default: release-prepare.yml)',
    },
    watch: {
      type: 'boolean',
      description: 'Poll gh run watch until the run reaches a terminal state',
    },
    'commit-plan': {
      type: 'boolean',
      description: 'Commit the plan file to the active branch before dispatching',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'release',
      'open',
      {
        version: args.version,
        workflow: args.workflow as string | undefined,
        watch: args.watch === true,
        commitPlan: args['commit-plan'] === true,
      },
      { command: 'release' },
    );
  },
});

/**
 * cleo release reconcile <version> — v2 reconcile verb (T9526 / SPEC-T9345 §4.4).
 *
 * Post-publish: backfills the 11 provenance tables (commits, task_commits,
 * commit_files, pull_requests, pr_commits, pr_tasks, releases, release_commits,
 * release_changes, release_artifacts, brain_release_links) from git log and
 * gh api. Single SQLite transaction, UPSERT-everywhere, full idempotency.
 *
 * Coexists with the legacy 4-step pipeline reconcile (`releaseReconcile`).
 * The legacy path stays available via the dispatch handler for backward
 * compatibility; the CLI routes to v2.
 */
const reconcileCommand = defineCommand({
  meta: {
    name: 'reconcile',
    description: 'Reconcile a published release: backfill the 11 provenance tables',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Version string (e.g. v2026.6.0)',
      required: true,
    },
    'from-workflow': {
      type: 'boolean',
      description: 'Indicates invocation from release-publish.yml (affects logging only)',
    },
    rollback: {
      type: 'boolean',
      description: 'Reconcile a rollback rather than a publish (deferred to T9528)',
    },
    json: { type: 'boolean', description: 'Emit LAFS envelope' },
  },
  async run({ args }) {
    const result = await release.releaseReconcileV2(args.version, {
      fromWorkflow: args['from-workflow'] === true,
      rollback: args.rollback === true,
    });
    // releaseReconcileV2 returns an EngineResult discriminated union
    // ({success:true,data} | {success:false,error}). Passing the union
    // directly to cliOutput would double-wrap into {success:true,
    // data:{success:false,error}}. Unwrap to surface the inner result
    // as the canonical CLI envelope (T9686-A bug A3).
    if (result.success) {
      cliOutput(result.data, { command: 'release', operation: 'release.reconcile' });
      return;
    }
    cliError(
      result.error.message,
      result.error.code,
      {
        name: result.error.code,
        ...(result.error.details ? { details: result.error.details } : {}),
        ...(result.error.fix ? { fix: result.error.fix } : {}),
      },
      { operation: 'release.reconcile' },
    );
    process.exit(1);
  },
});

/**
 * Root release command group — release lifecycle management.
 *
 * Surfaces the SPEC-T9345 4-verb pipeline (`plan`, `open`, `reconcile`,
 * `rollback`) as the canonical entry points, plus the `ship-e2e-smoke`
 * one-shot walker that validates the full plan → open → wait-PR →
 * wait-tag → verify-npm flow (dry-run by default; `--execute` to run for
 * real). The legacy `start`, `verify`, `publish`, and `ship` shim verbs
 * were deleted (T9540 + T10103); see `docs/release/verb-matrix.md` for
 * the post-cleanup state-transition map.
 *
 * Dispatches to `release.*` for the new verbs.
 *
 * @task T9540 — Phase 6 cleanup
 * @task T10103 — deleted ship shim + added ship-e2e-smoke
 * @spec SPEC-T9345 §12
 */
export const releaseCommand = defineCommand({
  meta: {
    name: 'release',
    description:
      'Release lifecycle management — 4-verb pipeline: plan → open → reconcile / rollback. ' +
      'Use `ship-e2e-smoke` for end-to-end validation (dry-run by default).',
  },
  subCommands: {
    // Canonical SPEC-T9345 4-verb pipeline — list these first so `--help`
    // surfaces them as the documented default.
    plan: planCommand,
    open: openCommand,
    reconcile: reconcileCommand,
    rollback: rollbackCommand,
    // End-to-end smoke walker — see docs/release/verb-matrix.md.
    'ship-e2e-smoke': shipE2eSmokeCommand,
    // Read-only helpers — not deprecated.
    list: listCommand,
    show: showCommand,
    cancel: cancelCommand,
    'pr-status': prStatusCommand,
    channel: channelCommand,
    'rollback-full': rollbackFullCommand,
    // T9937 — canonical CHANGELOG.md header validator (Saga T9862).
    'validate-changelog': validateChangelogCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
