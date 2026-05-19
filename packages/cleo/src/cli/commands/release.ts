/**
 * CLI release command group — release lifecycle management.
 *
 * Canonical 4-verb pipeline (SPEC-T9345):
 *   cleo release plan <version> --epic <id>  — build the Release Plan envelope
 *   cleo release open <version>              — dispatch release-prepare workflow
 *   cleo release reconcile <version>         — post-publish provenance backfill
 *   cleo release rollback <version>          — roll back a shipped release
 *
 * Deprecated (kept for the migration window — see SPEC-T9345 §12):
 *   cleo release ship    — alias that ALWAYS forwards to plan + open (T9540
 *                          removed the `--workflow=false` legacy fallback)
 *
 * Read-only helpers:
 *   cleo release list / show / cancel / changelog / pr-status / channel
 *
 * @task T4467
 * @task T820
 * @task T9538 — ship deprecation shim
 * @task T9540 — Phase 6 cleanup: remove legacy start/verify/publish CLI verbs
 *               + `--workflow=false` escape hatch (their backing functions
 *               in pipeline.ts and releaseShip in engine-ops.ts were
 *               deleted alongside this change)
 * @epic T9498 — release v2 cutover
 * @epic T9499 — Phase 6 cleanup epic
 */

import { release } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Deprecation notice emitted to stderr by {@link shipCommand} per
 * SPEC-T9345 §12 R-420 / R-431. The notice MUST include the replacement
 * invocation and the target removal release per R-431.
 *
 * @task T9538
 * @task T9540 — removed `--workflow=false` escape hatch from the notice
 *               (legacy `releaseShip` monolith was deleted; no fallback exists)
 * @spec SPEC-T9345 §12 R-420
 */
export const SHIP_DEPRECATION_NOTICE =
  '[DEPRECATED] `cleo release ship` is a deprecated alias and will be removed no earlier than the third release cycle after T9498. ' +
  'Use `cleo release plan <version> --epic <id>` followed by `cleo release open <version>`; publish runs via GHA workflow. ' +
  'Docs: T9345-CHILD-1.';

/**
 * cleo release ship — DEPRECATED alias per SPEC-T9345 §12 R-420.
 *
 * Emits {@link SHIP_DEPRECATION_NOTICE} to stderr and forwards to the new
 * 4-verb pipeline by calling `release.plan` then `release.open` via
 * dispatch. Publish happens through the GHA `release-prepare.yml` workflow
 * dispatched by `release.open`, so the CLI returns once the workflow has
 * been triggered.
 *
 * The deprecation warning is written to **stderr** (NOT stdout) so JSON
 * envelope output on stdout stays parseable for downstream tooling.
 *
 * Historical note: prior to T9540, this shim accepted `--workflow=false`
 * as an emergency escape hatch that ran the legacy 12-step `releaseShip`
 * monolith locally. T9540 (Phase 6 of T9499) deleted that monolith — the
 * flag and its audit hook are removed because no legacy fallback exists.
 *
 * @task T9538
 * @task T9540 — removed `--workflow=false` + audit hook
 * @spec SPEC-T9345 §12 R-420 / R-441 (escape-hatch removal)
 */
const shipCommand = defineCommand({
  meta: {
    name: 'ship',
    description: '[DEPRECATED] Forwards to `release plan` + `release open`',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Version string (e.g. 2026.4.77)',
      required: true,
    },
    epic: {
      type: 'string',
      description: 'Epic task ID (forwarded to release plan / release open)',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview all actions without writing anything (plan dry-run only)',
    },
  },
  async run({ args }) {
    // R-420: deprecation warning MUST go to stderr so JSON envelope on stdout
    // stays parseable for piped tooling.
    process.stderr.write(`${SHIP_DEPRECATION_NOTICE}\n`);

    // T9540: --workflow=false escape hatch and the legacy releaseShip
    // monolith were removed. Ship ALWAYS forwards to the new 4-verb
    // pipeline: plan, then open. Publish runs in the dispatched GHA
    // workflow.
    await dispatchFromCli(
      'mutate',
      'release',
      'plan',
      {
        version: args.version,
        epicId: args.epic,
        dryRun: args['dry-run'] === true,
      },
      { command: 'release' },
    );
    if (args['dry-run'] === true) {
      // Match the new-verb semantics: dry-run stops after plan with no side
      // effects, so don't trip the open workflow when the operator asked
      // for a preview.
      return;
    }
    await dispatchFromCli(
      'mutate',
      'release',
      'open',
      {
        version: args.version,
      },
      { command: 'release' },
    );
  },
});

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

/**
 * cleo release changelog — generate CHANGELOG from git log since a given tag.
 *
 * Parses epic/task IDs from commit messages (T\d+ patterns),
 * groups by epic, and produces a structured CHANGELOG entry.
 *
 * @task T820 RELEASE-02
 */
const changelogCommand = defineCommand({
  meta: {
    name: 'changelog',
    description: 'Generate CHANGELOG from git log since a given tag, with task/epic grouping',
  },
  args: {
    since: {
      type: 'string',
      description: 'Git tag or ref to generate changelog from (e.g. v2026.4.75)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'pipeline',
      'release.changelog.since',
      { sinceTag: args.since },
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
 * `cleo release ship` is interrupted or times out.
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
      description: 'Epic task ID whose children are candidates for inclusion',
      required: true,
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
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'release',
      'plan',
      {
        version: args.version,
        epicId: args.epic,
        scheme: args.scheme as string | undefined,
        channel: args.channel as string | undefined,
        hotfix: args.hotfix === true,
        dryRun: args['dry-run'] === true,
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
    cliOutput(result, { command: 'release', operation: 'release.reconcile' });
    if (!result.success) process.exit(1);
  },
});

/**
 * Root release command group — release lifecycle management.
 *
 * Surfaces the SPEC-T9345 4-verb pipeline (`plan`, `open`, `reconcile`,
 * `rollback`) as the canonical entry points. The `ship` alias is the only
 * remaining deprecated verb (kept for the migration window — R-420); it
 * forwards to `plan` + `open`. The legacy `start`, `verify`, `publish`
 * verbs and the `--workflow=false` legacy fallback were deleted in T9540
 * (Phase 6 of T9499) along with the backing functions in
 * `packages/core/src/release/pipeline.ts` and the `releaseShip` monolith
 * in `engine-ops.ts`.
 *
 * Dispatches to `release.*` for the new verbs.
 *
 * @task T9538
 * @task T9540 — Phase 6 cleanup
 * @spec SPEC-T9345 §12
 */
export const releaseCommand = defineCommand({
  meta: {
    name: 'release',
    description:
      'Release lifecycle management — 4-verb pipeline: plan → open → reconcile / rollback. ' +
      'Deprecated: ship (forwards to plan + open; see SPEC-T9345 §12).',
  },
  subCommands: {
    // Canonical SPEC-T9345 4-verb pipeline — list these first so `--help`
    // surfaces them as the documented default (T9538 / R-420).
    plan: planCommand,
    open: openCommand,
    reconcile: reconcileCommand,
    rollback: rollbackCommand,
    // Read-only helpers — not deprecated.
    list: listCommand,
    show: showCommand,
    cancel: cancelCommand,
    changelog: changelogCommand,
    'pr-status': prStatusCommand,
    channel: channelCommand,
    'rollback-full': rollbackFullCommand,
    // Deprecated verbs (kept for the migration window — SPEC-T9345 §12).
    // R-420: ship → plan + open
    ship: shipCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
