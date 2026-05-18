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
 *   cleo release ship    — alias that forwards to plan + open + (auto-)publish
 *   cleo release start   — alias for plan
 *   cleo release verify  — see `cleo verify <task> --gate X --evidence …` (ADR-051)
 *   cleo release publish — see `cleo release open <version>`
 *
 * Read-only helpers:
 *   cleo release list / show / cancel / changelog / pr-status / channel
 *
 * @task T4467
 * @task T820
 * @task T9538 — ship deprecation shim
 * @epic T9498 — release v2 cutover
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
 * @spec SPEC-T9345 §12 R-420
 */
export const SHIP_DEPRECATION_NOTICE =
  '[DEPRECATED] `cleo release ship` is a deprecated alias and will be removed no earlier than the third release cycle after T9498. ' +
  'Use `cleo release plan <version> --epic <id>` followed by `cleo release open <version>`; publish runs via GHA workflow. ' +
  'Emergency escape hatch (audit-logged to .cleo/audit/release-workflow-bypass.jsonl): pass `--workflow=false` to run the legacy 12-step monolith locally. ' +
  'Docs: T9345-CHILD-1.';

/**
 * cleo release ship — DEPRECATED alias per SPEC-T9345 §12 R-420.
 *
 * Default behavior (workflow !== false): emits {@link SHIP_DEPRECATION_NOTICE}
 * to stderr and forwards to the new 4-verb pipeline by calling
 * `release.plan` then `release.open` via dispatch. Publish happens through
 * the GHA `release-prepare.yml` workflow dispatched by `release.open`, so
 * the CLI returns once the workflow has been triggered.
 *
 * Emergency escape hatch (`--workflow=false`): bypasses the new flow and
 * runs the legacy 12-step monolith via the existing `release.ship` dispatch
 * route. Each such invocation MUST append a CRITICAL-severity record to
 * `.cleo/audit/release-workflow-bypass.jsonl` (R-441). This flag is slated
 * for removal in Phase 6 (T9540).
 *
 * The deprecation warning is written to **stderr** (NOT stdout) so JSON
 * envelope output on stdout stays parseable for downstream tooling.
 *
 * @task T9538
 * @spec SPEC-T9345 §12 R-420 / R-440 / R-441
 */
const shipCommand = defineCommand({
  meta: {
    name: 'ship',
    description:
      '[DEPRECATED] Forwards to `release plan` + `release open` (use --workflow=false for legacy path)',
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
    workflow: {
      type: 'boolean',
      description:
        'Default true: route through new plan+open verbs. Pass --workflow=false (or --no-workflow) to run the legacy 12-step monolith (CRITICAL audit-logged)',
      default: true,
    },
    'workflow-bypass-reason': {
      type: 'string',
      description: 'Operator-supplied rationale recorded in the workflow-bypass audit log',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview all actions without writing anything (legacy path only)',
    },
    push: {
      type: 'boolean',
      description: 'Push commit and tag (legacy path only — default: true)',
      default: true,
    },
    bump: {
      type: 'boolean',
      description: 'Bump version files (legacy path only — default: true)',
      default: true,
    },
    remote: {
      type: 'string',
      description: 'Git remote to push to (legacy path only — default: origin)',
    },
    force: {
      type: 'boolean',
      description: 'Bypass IVTR gate check (legacy path only — breaks accountability chain)',
    },
  },
  async run({ args }) {
    // R-420: deprecation warning MUST go to stderr so JSON envelope on stdout
    // stays parseable for piped tooling.
    process.stderr.write(`${SHIP_DEPRECATION_NOTICE}\n`);

    // R-440 / R-441: --workflow=false retains the legacy releaseShip monolith
    // path and audits the bypass to `.cleo/audit/release-workflow-bypass.jsonl`.
    if (args.workflow === false) {
      release.appendReleaseWorkflowBypass({
        projectRoot: process.cwd(),
        version: args.version,
        reason:
          (args['workflow-bypass-reason'] as string | undefined) ??
          '(no reason supplied — set --workflow-bypass-reason)',
        epicId: args.epic,
        source: 'cli-flag',
      });
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'release.ship',
        {
          version: args.version,
          epicId: args.epic,
          dryRun: args['dry-run'],
          push: args.push !== false,
          bump: args.bump !== false,
          remote: args.remote as string | undefined,
          force: args.force,
        },
        { command: 'release' },
      );
      return;
    }

    // Default: forward to the new 4-verb pipeline (R-420). Plan first, then
    // open — publish runs in the dispatched GHA workflow.
    await dispatchFromCli(
      'mutate',
      'release',
      'release.plan',
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
      'release.open',
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
// Canonical 4-step release pipeline (T1597 / ADR-063)
// ---------------------------------------------------------------------------

/** cleo release start — Step 1: validate version, capture branch, persist handle. */
const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Begin a release (validates version, captures branch, persists handle)',
  },
  args: {
    version: { type: 'positional', description: 'Version to release', required: true },
    epic: { type: 'string', description: 'Epic ID this release ships' },
    branch: { type: 'string', description: 'Override detected branch' },
  },
  async run({ args }) {
    const handle = await release.releaseStart(args.version, {
      epicId: args.epic as string | undefined,
      branch: args.branch as string | undefined,
    });
    cliOutput(handle, { command: 'release', operation: 'release.start' });
  },
});

/**
 * cleo release verify — Step 2: run gates + audit child tasks of release epic.
 *
 * Injects a real ADR-061-based gate runner so each gate (test, lint,
 * typecheck, audit, security-scan) actually executes the resolved tool
 * command. Prior to T9503 the runner was always-failing theater.
 */
const verifyCommand = defineCommand({
  meta: { name: 'verify', description: 'Verify release gates + child task gate state' },
  async run() {
    const projectRoot = process.cwd();
    const handle = release.loadActiveReleaseHandle(projectRoot);
    const result = await release.releaseVerify(handle, {
      runGate: release.makeAdr061GateRunner(projectRoot),
    });
    cliOutput(result, { command: 'release', operation: 'release.verify' });
    if (!result.passed) process.exit(1);
  },
});

/** cleo release publish — Step 3: invoke project-context publish.command. */
const publishCommand = defineCommand({
  meta: { name: 'publish', description: 'Publish release artifact (project-context driven)' },
  args: { 'dry-run': { type: 'boolean', description: 'Print command without executing' } },
  async run({ args }) {
    const result = await release.releasePublish(release.loadActiveReleaseHandle(process.cwd()), {
      dryRun: args['dry-run'] === true,
    });
    cliOutput(result, { command: 'release', operation: 'release.publish' });
    if (!result.success) process.exit(1);
  },
});

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
      'release.plan',
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
      'release.open',
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
 * `rollback`) as the canonical entry points. Legacy verbs (`ship`, `start`,
 * `verify`, `publish`) remain wired for the compatibility window (R-420 →
 * R-423) but are listed under the Deprecated section of the command
 * description (T9538).
 *
 * Dispatches to `release.*` for the new verbs and to `pipeline.release.*`
 * for the legacy compatibility shim path.
 *
 * @task T9538
 * @spec SPEC-T9345 §12
 */
export const releaseCommand = defineCommand({
  meta: {
    name: 'release',
    description:
      'Release lifecycle management — 4-verb pipeline: plan → open → reconcile / rollback. ' +
      'Deprecated: ship/start/verify/publish (use the 4 verbs above; see SPEC-T9345 §12).',
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
    // R-420: ship → plan + open + (auto-)publish
    ship: shipCommand,
    // R-421: start → plan
    start: startCommand,
    // R-422: verify → cleo verify <task> --gate X --evidence …
    verify: verifyCommand,
    // R-423: publish → release open
    publish: publishCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
