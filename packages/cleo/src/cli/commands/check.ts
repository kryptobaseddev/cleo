/**
 * CLI check command group — dispatches to the check domain.
 *
 * Subcommands: schema, coherence, task, output, canon, protocol, provenance
 * @task T132
 * @task T260 — generic protocol subcommand exposing all 12 protocols
 * @task T476 — output subcommand
 * @task T864 — check.schema args derived from registry (SSoT proof-of-concept)
 * @task T1136 — provenance subcommand: audit git log for untagged commits
 */

import { formatPrGateSummary, type PrGateSummary, runPrGate } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';
import { cliError } from '../renderers/index.js';

/**
 * Render a {@link PrGateSummary} as a LAFS envelope on stdout plus a
 * human-readable summary on stderr. Kept module-local (not a CLI-command
 * helper) and under the boundary threshold; the gate LOGIC lives in
 * `@cleocode/core` per the Package-Boundary Check.
 *
 * @param summary the aggregate result of a `cleo check pr` run
 * @task T11956
 */
function emitPrGateSummary(summary: PrGateSummary): void {
  const envelope = {
    success: summary.passed,
    data: {
      passed: summary.passed,
      summary: summary.summary,
      gates: summary.gates,
      repoRoot: summary.repoRoot,
    },
    meta: { operation: 'check.pr', timestamp: new Date().toISOString() },
  };
  // Single stdout write — the canonical LAFS envelope (CLI Output Contract).
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  // Human report is formatted in core; single stderr write keeps the CLI thin.
  process.stderr.write(`${formatPrGateSummary(summary)}\n`);
}

/**
 * The 12 supported protocol types — must stay in sync with
 * packages/core/src/orchestration/protocol-validators.ts#PROTOCOL_TYPES.
 *
 * @task T260
 */
const SUPPORTED_PROTOCOL_TYPES = [
  'research',
  'consensus',
  'architecture-decision',
  'specification',
  'decomposition',
  'implementation',
  'contribution',
  'validation',
  'testing',
  'release',
  'artifact-publish',
  'provenance',
] as const;

/**
 * cleo check schema — validate schema by type.
 *
 * Args derived from registry via `paramsToCittyArgs` (T864 SSoT).
 */
const checkSchemaCommand = defineCommand({
  meta: {
    name: 'schema',
    description: 'Validate schema (type: todo, config, archive, log, sessions)',
  },
  args: paramsToCittyArgs(getOperationParams('query', 'check', 'schema')),
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'schema',
      { type: args['type'] as string },
      { command: 'check' },
    );
  },
});

/** cleo check coherence — run coherence check across task data */
const checkCoherenceCommand = defineCommand({
  meta: { name: 'coherence', description: 'Run coherence check across task data' },
  async run() {
    await dispatchFromCli('query', 'check', 'coherence', {}, { command: 'check' });
  },
});

/** cleo check task — validate a specific task */
const checkTaskCommand = defineCommand({
  meta: { name: 'task', description: 'Validate a specific task' },
  args: { taskId: { type: 'positional', description: 'Task ID to validate', required: true } },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'task',
      { taskId: args.taskId as string },
      { command: 'check' },
    );
  },
});

/** cleo check output — validate an agent output file against the manifest schema */
const checkOutputCommand = defineCommand({
  meta: {
    name: 'output',
    description: 'Validate an agent output file against the manifest schema',
  },
  args: {
    filePath: { type: 'positional', description: 'Path to agent output file', required: true },
    'task-id': { type: 'string', description: 'Task ID the output file belongs to' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'output',
      { filePath: args.filePath as string, taskId: args['task-id'] as string | undefined },
      { command: 'check', operation: 'check.output' },
    );
  },
});

/**
 * cleo check canon docs — CI gate: detect raw markdown writes against
 * `.cleo/canon.yml`.
 *
 * Walks `git diff --diff-filter=A` between `--base` (default `origin/main`)
 * and `HEAD`, then blocks any newly-added `*.md` file that lands inside a
 * `rawMdPaths` directory whose owning DocKind has `rawMdAllowed: false`.
 *
 * Exits 0 on pass, 1 on violation (so CI fails the job), 2 on tool error
 * (invalid canon.yml, etc.).
 *
 * @task T9796
 */
const checkCanonDocsCommand = defineCommand({
  meta: {
    name: 'docs',
    description: 'CI gate: block raw *.md writes that bypass the docs SSoT (T9796)',
  },
  args: {
    base: {
      type: 'string',
      description: 'Git ref to diff against (default: origin/main)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'canon.docs',
      { baseRef: args.base as string | undefined },
      { command: 'check', operation: 'check.canon.docs' },
    );
  },
});

/** cleo check canon — CI gate: detect canon drift between docs and live code */
const checkCanonCommand = defineCommand({
  meta: { name: 'canon', description: 'CI gate: detect canon drift between docs and live code' },
  subCommands: {
    docs: checkCanonDocsCommand,
  },
  async run({ cmd, rawArgs }) {
    // When a recognised subcommand was supplied, citty already dispatched —
    // bail out so we don't double-fire the legacy code/doc drift check.
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await dispatchFromCli('query', 'check', 'canon', {}, { command: 'check' });
  },
});

/** cleo check protocol — validate any of the 12 RCASD-IVTR+C protocols */
const checkProtocolCommand = defineCommand({
  meta: {
    name: 'protocol',
    description: `Validate any of the 12 RCASD-IVTR+C protocols: ${SUPPORTED_PROTOCOL_TYPES.join(', ')}`,
  },
  args: {
    protocolType: {
      type: 'positional',
      description: 'Protocol type to validate',
      required: true,
    },
    'task-id': { type: 'string', description: 'Task ID to validate (mode=task, default)' },
    'manifest-file': { type: 'string', description: 'Manifest file to validate (mode=manifest)' },
    strict: { type: 'boolean', description: 'Exit with error code on violations' },
    'voting-matrix-file': { type: 'string', description: 'consensus: voting matrix JSON file' },
    'epic-id': { type: 'string', description: 'decomposition: parent epic ID' },
    'sibling-count': { type: 'string', description: 'decomposition: actual sibling count' },
    'max-siblings': { type: 'string', description: 'decomposition: configured max siblings' },
    'spec-file': { type: 'string', description: 'specification: path to spec markdown' },
    'has-code-changes': {
      type: 'boolean',
      description: 'research: code changes detected (forbidden)',
    },
    'has-task-tags': {
      type: 'boolean',
      description: 'implementation: @task tags present in code',
    },
    'has-contribution-tags': {
      type: 'boolean',
      description: 'contribution: @contribution tags present',
    },
    version: { type: 'string', description: 'release: target version (semver/calver)' },
    'has-changelog': { type: 'boolean', description: 'release: changelog updated' },
    'artifact-type': {
      type: 'string',
      description: 'artifact-publish: artifact handler (npm-package, docker-image, ...)',
    },
    'build-passed': { type: 'boolean', description: 'artifact-publish: build step succeeded' },
    'has-attestation': {
      type: 'boolean',
      description: 'provenance: in-toto attestation generated',
    },
    'has-sbom': {
      type: 'boolean',
      description: 'provenance: SBOM (CycloneDX/SPDX) generated',
    },
    'adr-content': { type: 'string', description: 'ADR: ADR markdown body for section check' },
    status: {
      type: 'string',
      description: 'ADR: lifecycle status (proposed|accepted|superseded|deprecated)',
    },
    'hitl-reviewed': { type: 'boolean', description: 'ADR: HITL review completed' },
    'downstream-flagged': {
      type: 'boolean',
      description: 'ADR: downstream artifacts flagged for review',
    },
    'persisted-in-db': {
      type: 'boolean',
      description: 'ADR: persisted in canonical decisions table',
    },
    'spec-match-confirmed': {
      type: 'boolean',
      description: 'validation: implementation matches spec',
    },
    'test-suite-passed': {
      type: 'boolean',
      description: 'validation: existing test suite passed',
    },
    'protocol-compliance-checked': {
      type: 'boolean',
      description: 'validation: upstream protocols checked',
    },
    framework: { type: 'string', description: 'testing: detected test framework' },
    'tests-run': { type: 'string', description: 'testing: total tests executed' },
    'tests-passed': { type: 'string', description: 'testing: tests that passed' },
    'tests-failed': { type: 'string', description: 'testing: tests that failed' },
    'coverage-percent': { type: 'string', description: 'testing: coverage percentage' },
    'coverage-threshold': { type: 'string', description: 'testing: configured coverage threshold' },
    'ivt-loop-converged': { type: 'boolean', description: 'testing: IVT loop converged on spec' },
    'ivt-loop-iterations': { type: 'string', description: 'testing: IVT iteration count' },
  },
  async run({ args }) {
    const protocolType = args.protocolType as string;
    if (!(SUPPORTED_PROTOCOL_TYPES as readonly string[]).includes(protocolType)) {
      cliError(
        `Unknown protocol type "${protocolType}". Supported: ${SUPPORTED_PROTOCOL_TYPES.join(', ')}`,
        2,
        {
          name: 'E_VALIDATION',
          fix: `Use one of: ${SUPPORTED_PROTOCOL_TYPES.join(', ')}`,
        },
      );
      process.exit(2);
    }
    const mode: 'task' | 'manifest' = args['manifest-file'] ? 'manifest' : 'task';
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType,
        mode,
        taskId: args['task-id'] as string | undefined,
        manifestFile: args['manifest-file'] as string | undefined,
        strict: args.strict as boolean | undefined,
        votingMatrixFile: args['voting-matrix-file'] as string | undefined,
        epicId: args['epic-id'] as string | undefined,
        siblingCount:
          args['sibling-count'] !== undefined
            ? Number.parseInt(args['sibling-count'] as string, 10)
            : undefined,
        maxSiblings:
          args['max-siblings'] !== undefined
            ? Number.parseInt(args['max-siblings'] as string, 10)
            : undefined,
        specFile: args['spec-file'] as string | undefined,
        hasCodeChanges: args['has-code-changes'] as boolean | undefined,
        hasTaskTags: args['has-task-tags'] as boolean | undefined,
        hasContributionTags: args['has-contribution-tags'] as boolean | undefined,
        version: args.version as string | undefined,
        hasChangelog: args['has-changelog'] as boolean | undefined,
        artifactType: args['artifact-type'] as string | undefined,
        buildPassed: args['build-passed'] as boolean | undefined,
        hasAttestation: args['has-attestation'] as boolean | undefined,
        hasSbom: args['has-sbom'] as boolean | undefined,
        adrContent: args['adr-content'] as string | undefined,
        status: args.status as string | undefined,
        hitlReviewed: args['hitl-reviewed'] as boolean | undefined,
        downstreamFlagged: args['downstream-flagged'] as boolean | undefined,
        persistedInDb: args['persisted-in-db'] as boolean | undefined,
        specMatchConfirmed: args['spec-match-confirmed'] as boolean | undefined,
        testSuitePassed: args['test-suite-passed'] as boolean | undefined,
        protocolComplianceChecked: args['protocol-compliance-checked'] as boolean | undefined,
        framework: args.framework as string | undefined,
        testsRun:
          args['tests-run'] !== undefined
            ? Number.parseInt(args['tests-run'] as string, 10)
            : undefined,
        testsPassed:
          args['tests-passed'] !== undefined
            ? Number.parseInt(args['tests-passed'] as string, 10)
            : undefined,
        testsFailed:
          args['tests-failed'] !== undefined
            ? Number.parseInt(args['tests-failed'] as string, 10)
            : undefined,
        coveragePercent:
          args['coverage-percent'] !== undefined
            ? Number.parseFloat(args['coverage-percent'] as string)
            : undefined,
        coverageThreshold:
          args['coverage-threshold'] !== undefined
            ? Number.parseFloat(args['coverage-threshold'] as string)
            : undefined,
        ivtLoopConverged: args['ivt-loop-converged'] as boolean | undefined,
        ivtLoopIterations:
          args['ivt-loop-iterations'] !== undefined
            ? Number.parseInt(args['ivt-loop-iterations'] as string, 10)
            : undefined,
      },
      { command: 'check' },
    );
  },
});

/**
 * cleo check provenance — audit git log for commits missing a Task ID.
 *
 * Walks the git log from `--since` (default: all history) and flags any
 * commit subject that does not contain `T<digits>`. Merge commits and
 * revert commits are exempt (matching the commit-msg hook policy).
 *
 * Exit code 0 = all audited commits have Task IDs.
 * Exit code 1 = one or more untagged commits found (with --strict).
 * Without --strict, always exits 0 but prints the report.
 *
 * @task T1136
 */
const checkProvenanceCommand = defineCommand({
  meta: {
    name: 'provenance',
    description: 'Audit git log for commits missing a Task ID (T####)',
  },
  args: {
    since: {
      type: 'string',
      description: 'Git revision range start (e.g. "v2026.5.0", "HEAD~50", "main")',
    },
    branch: {
      type: 'string',
      description: 'Branch to audit (default: HEAD)',
    },
    strict: {
      type: 'boolean',
      description: 'Exit with code 1 if any untagged commits are found',
    },
    limit: {
      type: 'string',
      description: 'Maximum number of commits to audit (default: 200)',
    },
  },
  async run({ args }) {
    const { execSync } = await import('node:child_process');

    const since = args.since as string | undefined;
    const branch = (args.branch as string | undefined) || 'HEAD';
    const strict = Boolean(args.strict);
    const limit = args.limit ? Number.parseInt(args.limit as string, 10) : 200;

    // Build the git log range
    const range = since ? `${since}..${branch}` : branch;

    let logOutput: string;
    try {
      logOutput = execSync(`git log --no-merges --pretty=format:"%H\t%s" -n ${limit} ${range}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`git log failed: ${message}`, 1, {
        name: 'E_GIT_LOG',
        fix: 'Ensure you are inside a git repository and the range is valid.',
      });
      process.exit(1);
    }

    const lines = logOutput.trim().split('\n').filter(Boolean);
    const TASK_ID_RE = /T[0-9]+/;
    const EXEMPT_RE = /^(Merge |Revert |fixup! |squash! |amend! )/;

    const untagged: Array<{ sha: string; subject: string }> = [];
    const total = lines.length;

    for (const line of lines) {
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) continue;
      const sha = line.slice(0, tabIdx).trim();
      const subject = line.slice(tabIdx + 1).trim();

      if (EXEMPT_RE.test(subject)) continue;
      if (!TASK_ID_RE.test(subject)) {
        untagged.push({ sha: sha.slice(0, 12), subject });
      }
    }

    const tagged = total - untagged.length;
    const result = {
      success: true,
      data: {
        audited: total,
        tagged,
        untagged: untagged.length,
        untaggedCommits: untagged,
        range,
        passed: untagged.length === 0,
      },
      meta: { operation: 'check.provenance' },
    };

    process.stdout.write(`${JSON.stringify(result)}\n`);

    if (strict && untagged.length > 0) {
      process.stderr.write(
        `[provenance] ${untagged.length} of ${total} audited commits lack a Task ID.\n`,
      );
      process.exit(1);
    }
  },
});

/**
 * cleo check arch — run all SG-ARCH-SOLID architectural lint gates and
 * emit a LAFS-compliant summary envelope.
 *
 * Gates (Saga T9831 · Epic T9837):
 *   Gate 1 (T9837a): lint-no-raw-define-command.mjs    — no defineCommand() outside lib factory
 *   Gate 2 (T9837b): lint-no-direct-db-open.mjs        — no DatabaseSync outside core/store
 *   Gate 3 (T9837c): lint-contracts-fan-out.mjs        — no inline types imported by >2 files
 *   Gate 4 (T9837d): lint-no-ssot-exempt.mjs           — no SSoT-EXEMPT without task ID
 *   Gate 5 (T9837e): lint-cli-package-boundary.mjs     — no helper > 30 LOC in CLI commands
 *   Gate 6 (T11640): lint-no-bare-get-active-session.mjs — no NEW bare getActiveSession() callsites
 *   Gate 7 (T12041): lint-no-domain-db-singleton.mjs    — no NEW per-domain DB singleton cache
 *   Gate 8 (T12087): lint-vitest-memory-safe.mjs       — every vitest config bounds fork count + heap
 *   Gate 9 (T12093): lint-workflow-cleo-commands.mjs   — no workflow invokes a nonexistent cleo verb
 *   Gate 10 (T12076): lint-cli-startup-barrel-imports.mjs — no NEW static core-barrel import in the CLI
 *
 * Each gate is run in --check mode (baseline tolerance). A gate whose script
 * does not yet exist on disk is reported as "skipped" (non-blocking) to allow
 * incremental rollout as sibling tasks land.
 *
 * Exit codes:
 *   0 — all present gates passed (skipped gates are non-blocking)
 *   1 — one or more gates failed
 *
 * @task T10076
 * @epic T9837
 * @saga T9831
 */
const checkArchCommand = defineCommand({
  meta: {
    name: 'arch',
    description:
      'Run all 5 SG-ARCH-SOLID architectural lint gates and emit a LAFS envelope (T9837)',
  },
  args: {
    strict: {
      type: 'boolean',
      description: 'Fail even if gates are in baseline mode (passes --strict to each script)',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON envelope only (no human output)',
    },
  },
  async run({ args }) {
    const { spawnSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');

    const strict = Boolean(args.strict);
    const jsonOnly = Boolean(args.json);
    const repoRoot = resolve(process.cwd());

    /** The SG-ARCH-SOLID gates, in order. */
    const gates = [
      {
        id: 'gate-1',
        task: 'T9837a',
        script: 'scripts/lint-no-raw-define-command.mjs',
        description: 'No defineCommand() outside cli/lib factory',
      },
      {
        id: 'gate-2',
        task: 'T9837b',
        script: 'scripts/lint-no-direct-db-open.mjs',
        description: 'No DatabaseSync outside core/store',
      },
      {
        id: 'gate-3',
        task: 'T9837c',
        script: 'scripts/lint-contracts-fan-out.mjs',
        description: 'No inline types imported by >2 files',
      },
      {
        id: 'gate-4',
        task: 'T9837d',
        script: 'scripts/lint-no-ssot-exempt.mjs',
        description: 'No SSoT-EXEMPT without linked task ID',
      },
      {
        id: 'gate-5',
        task: 'T9837e',
        script: 'scripts/lint-cli-package-boundary.mjs',
        description: 'No business-logic helper > 30 LOC in CLI commands',
      },
      {
        id: 'gate-6',
        task: 'T11640',
        script: 'scripts/lint-no-bare-get-active-session.mjs',
        description: 'No NEW bare getActiveSession() callsites (use resolveCurrentSession)', // get-active-session-allowed: gate description string, not a callsite
      },
      {
        id: 'gate-7',
        task: 'T12041',
        script: 'scripts/lint-no-domain-db-singleton.mjs',
        description:
          'No NEW per-domain DB singleton cache (bind via the ProjectStore/GlobalStore ports)',
      },
      {
        // T12087: zero-tolerance. An unbounded fork pool froze this machine
        // twice, and it only ever bites locally — CI runners have 2-4 cores, so
        // the unsafe default passes there and takes down the developer instead.
        id: 'gate-8',
        task: 'T12087',
        script: 'scripts/lint-vitest-memory-safe.mjs',
        description: 'Every vitest config spreads the memory-safe fork bounds (workers + heap cap)',
      },
      {
        // T12076: ratchet, not zero-tolerance. 106 static core-barrel imports
        // force the full 1266-module @cleocode/core graph to load before any
        // command runs (measured: 2.54 s for the barrel vs 0.12 s for a deep
        // module). Converting them one at a time produced an
        // EnvironmentTeardownError, so the count is allowed to fall but never
        // rise, and the measurement travels with the gate.
        id: 'gate-10',
        task: 'T12076',
        script: 'scripts/lint-cli-startup-barrel-imports.mjs',
        description: 'No NEW static @cleocode/core barrel import in the CLI (startup cost)',
      },
      {
        // T12093: zero-tolerance. `release-prepare.yml` invoked two commands
        // that never existed (`cleo version-bump`, `cleo release changelog`),
        // each discovered only after a full ~20-minute green preflight — and
        // the same break shipped in the template every consuming project
        // renders. A manifest read answers it in 200 ms.
        id: 'gate-9',
        task: 'T12093',
        script: 'scripts/lint-workflow-cleo-commands.mjs',
        description: 'Every `cleo` command invoked by a workflow (or its template) exists',
      },
      // ---------------------------------------------------------------------
      // T12122 (GH #1251): the nine gates below were documented in AGENTS.md's
      // gate table but were NEVER bundled here, so `cleo check arch` reported
      // a green that covered 10 of the 15 documented gates. Every agent is
      // told to run this command to self-check before pushing, so the command
      // silently covering two-thirds of its own documentation is the same
      // defect class as a filter that is accepted and not applied.
      //
      // All nine were measured before bundling: none needs a build, network
      // access, or non-trivial time (~800 ms for all nine combined), so there
      // was no reason for the omission and nothing has to be skipped.
      // ---------------------------------------------------------------------
      {
        id: 'gate-11',
        task: 'T9802',
        script: 'scripts/lint-paths-ssot.mjs',
        description:
          'env-paths / XDG_DATA_HOME / worktree path strings live in packages/paths only',
      },
      {
        id: 'gate-12',
        task: 'T9860',
        script: 'scripts/lint-deployed-template-parity.mjs',
        description: '.github/workflows/* matches the rendered core workflow templates',
      },
      {
        id: 'gate-13',
        task: 'T11281',
        script: 'scripts/lint-node-engine-ssot.mjs',
        description: 'Every package engines.node equals the root floor',
      },
      {
        id: 'gate-14',
        task: 'T11400',
        script: 'scripts/lint-publish-surface.mjs',
        description: 'release.yml publish_pkg list is the npm publish SSoT',
      },
      {
        id: 'gate-15',
        task: 'T11418',
        script: 'scripts/lint-no-runtime-in-contracts.mjs',
        description: 'packages/contracts is types-only (no net-new runtime helper)',
      },
      {
        id: 'gate-16',
        task: 'T11409',
        script: 'scripts/lint-tools-vs-skills-boundary.mjs',
        description: 'Atomic tool primitives are defined only in their home packages',
      },
      {
        id: 'gate-17',
        task: 'T11389',
        script: 'scripts/lint-no-crate-publish.mjs',
        description: 'Every crate declares publish = false (zero crates.io)',
      },
      {
        id: 'gate-18',
        task: 'T11783',
        script: 'scripts/lint-llm-chokepoint.mjs',
        description: 'LLM resolution + client/transport construction stay in the chokepoint',
      },
      {
        id: 'gate-19',
        task: 'T12069',
        script: 'scripts/lint-injection-commands.mjs',
        description: 'Every `cleo` command named in CLEO-INJECTION.md exists',
      },
      {
        // T12122: the gate on the gates. Without it, this list and the
        // AGENTS.md table drift apart again the moment someone adds one and
        // not the other — which is exactly how the 10-vs-15 split happened.
        id: 'gate-20',
        task: 'T12122',
        script: 'scripts/lint-arch-gate-parity.mjs',
        description: 'The bundled gate list and the AGENTS.md gate table are the same set',
      },
      {
        // gh#1283: some tables live in BOTH cleo.db scopes, and nexus ATTACHes
        // the global file onto the shared project handle. A bare name then
        // resolves by SQLite search order and answers without saying which
        // file it read. Narrow by design — qualifying EVERYTHING would break
        // the nexus registry fall-through that depends on bare names.
        id: 'gate-21',
        task: 'T12156',
        script: 'scripts/lint-dual-scope-unqualified-reads.mjs',
        description: 'No unqualified SQL reads of tables resident in both cleo.db scopes',
      },
      {
        // gh#1223: every module reaching the AI SDK can emit on stdout via
        // `ai@6`'s console.info banner. An INVENTORY rather than a per-module
        // rule — the guard is installed once at the envelope funnel by design.
        id: 'gate-22',
        task: 'T12169',
        script: 'scripts/lint-ai-sdk-surface.mjs',
        description: 'No unreviewed module reaches the AI SDK at runtime',
      },
      {
        // T12138 / gh#1207: SCOPE differs from gate 19 deliberately. Gate 19
        // ratchets a repo-wide count (106, may fall never rise); this permits
        // ZERO across the 16 modules reachable from the entrypoint's static
        // import graph, because those are paid on EVERY invocation including
        // `cleo --version` — one import was 87% of CLI startup. Neither
        // subsumes the other; the filenames carry the distinction.
        id: 'gate-23',
        task: 'T12138',
        script: 'scripts/lint-cli-startup-barrel-entrypoint.mjs',
        description: 'No module reachable from the CLI entrypoint statically imports a core barrel',
      },
    ] as const;

    const scriptArgs = strict ? ['--strict'] : ['--check'];

    type GateStatus = 'pass' | 'fail' | 'skipped';

    interface GateResult {
      id: string;
      task: string;
      script: string;
      description: string;
      status: GateStatus;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }

    const results: GateResult[] = [];
    let anyFailed = false;

    for (const gate of gates) {
      const scriptPath = join(repoRoot, gate.script);

      if (!existsSync(scriptPath)) {
        results.push({
          id: gate.id,
          task: gate.task,
          script: gate.script,
          description: gate.description,
          status: 'skipped',
          exitCode: null,
          stdout: '',
          stderr: `Script not yet created (task ${gate.task} pending).`,
        });
        continue;
      }

      const result = spawnSync('node', [scriptPath, ...scriptArgs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: repoRoot,
      });

      const passed = result.status === 0;
      if (!passed) anyFailed = true;

      results.push({
        id: gate.id,
        task: gate.task,
        script: gate.script,
        description: gate.description,
        status: passed ? 'pass' : 'fail',
        exitCode: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
    }

    const passCount = results.filter((r) => r.status === 'pass').length;
    const failCount = results.filter((r) => r.status === 'fail').length;
    const skipCount = results.filter((r) => r.status === 'skipped').length;

    const envelope = {
      success: !anyFailed,
      data: {
        saga: 'T9831',
        epic: 'T9837',
        mode: strict ? 'strict' : 'baseline',
        summary: { pass: passCount, fail: failCount, skipped: skipCount, total: gates.length },
        gates: results,
        passed: !anyFailed,
      },
      meta: {
        operation: 'check.arch',
        timestamp: new Date().toISOString(),
      },
    };

    // ADR-086: exactly one LAFS envelope on stdout, always — the `jsonOnly`
    // branch used to duplicate this identical write, differing only in whether
    // the human summary followed on stderr.
    process.stdout.write(`${JSON.stringify(envelope)}\n`); // stdout-write-allowed: the single ADR-086 envelope for `check arch` // stdout-discipline-allowed: raw JSON envelope, not rendered output

    if (!jsonOnly) {
      // Human-readable summary to stderr so JSON envelope stays clean on stdout
      process.stderr.write(`\n`);
      process.stderr.write(`SG-ARCH-SOLID Architectural Boundary Check (T9837)\n`);
      process.stderr.write(`${'─'.repeat(52)}\n`);
      for (const r of results) {
        const icon = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
        process.stderr.write(`  [${icon}] ${r.id} (${r.task}) — ${r.description}\n`);
        if (r.status === 'fail' && r.stderr.trim()) {
          const lines = r.stderr.trim().split('\n').slice(0, 3);
          for (const line of lines) {
            process.stderr.write(`         ${line}\n`);
          }
        }
        if (r.status === 'skipped') {
          process.stderr.write(`         ${r.stderr.trim()}\n`);
        }
      }
      process.stderr.write(`${'─'.repeat(52)}\n`);
      process.stderr.write(
        `  Result: ${passCount} passed, ${failCount} failed, ${skipCount} skipped\n`,
      );
      process.stderr.write(`\n`);
    }

    if (anyFailed) process.exit(1);
  },
});

/**
 * cleo check pr — unified local pre-PR gate (T11956 · DHQ-073).
 *
 * Runs the SAME gates CI runs (biome, lockfile, `cleo check arch`, canon-drift,
 * full typecheck, build, tests, and — with `--full` — the complete standalone
 * lint surface) locally in one command, reporting a single pass/fail summary so
 * an agent can self-verify BEFORE opening a PR. Heavy gates are cgroup-capped
 * on Linux.
 *
 * The gate registry + runner live in `@cleocode/core` (see
 * `packages/core/src/check/pr-gate.ts`); this handler is a thin dispatch.
 *
 * Exit codes: 0 — all selected gates passed; 1 — one or more failed.
 *
 * @task T11956
 * @epic T11679
 */
const checkPrCommand = defineCommand({
  meta: {
    name: 'pr',
    description: 'Run the CI required-gates locally and report one pass/fail summary (T11956)',
  },
  args: {
    full: {
      type: 'boolean',
      description: 'Also run the complete standalone-lint surface (slower, exhaustive)',
    },
    only: {
      type: 'string',
      description: 'Comma-separated gate ids to run (e.g. "biome,typecheck,test")',
    },
    'memory-max': {
      type: 'string',
      description: 'MemoryMax for cgroup-capped heavy gates on Linux (default: 16G)',
    },
    'no-keep-going': {
      type: 'boolean',
      description: 'Stop at the first failing gate instead of running them all',
    },
  },
  async run({ args }) {
    const onlyRaw = args.only as string | undefined;
    const summary = runPrGate({
      full: Boolean(args.full),
      only: onlyRaw
        ? onlyRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      memoryMax: args['memory-max'] as string | undefined,
      keepGoing: !args['no-keep-going'],
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    emitPrGateSummary(summary);
    if (!summary.passed) process.exit(1);
  },
});

/**
 * Root check command group — validation and compliance checks.
 *
 * Dispatches to the check domain. Supports schema validation, coherence,
 * task checks, output validation, canon drift
 * detection, and RCASD-IVTR+C protocol checks.
 */
export const checkCommand = defineCommand({
  meta: { name: 'check', description: 'Validation and compliance checks' },
  subCommands: {
    schema: checkSchemaCommand,
    coherence: checkCoherenceCommand,
    task: checkTaskCommand,
    output: checkOutputCommand,
    canon: checkCanonCommand,
    protocol: checkProtocolCommand,
    provenance: checkProvenanceCommand,
    arch: checkArchCommand,
    pr: checkPrCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
