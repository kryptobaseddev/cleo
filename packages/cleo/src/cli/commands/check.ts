/**
 * CLI check command group — dispatches to the check domain.
 *
 * Subcommands: schema, coherence, task, output, chain-validate, canon, protocol, provenance
 * @task T132
 * @task T260 — generic protocol subcommand exposing all 12 protocols
 * @task T476 — output and chain-validate subcommands
 * @task T864 — check.schema args derived from registry (SSoT proof-of-concept)
 * @task T1136 — provenance subcommand: audit git log for untagged commits
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';
import { cliError } from '../renderers/index.js';

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

/** cleo check chain-validate — validate a WarpChain definition from a JSON file */
const checkChainValidateCommand = defineCommand({
  meta: {
    name: 'chain-validate',
    description: 'Validate a WarpChain definition from a JSON file',
  },
  args: {
    file: {
      type: 'positional',
      description: 'JSON file containing the WarpChain definition',
      required: true,
    },
  },
  async run({ args }) {
    const { readFileSync } = await import('node:fs');
    let chain: unknown;
    try {
      chain = JSON.parse(readFileSync(args.file as string, 'utf8'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`Failed to read or parse chain file: ${message}`, 2, {
        name: 'E_FILE_READ',
        fix: 'Verify the file exists and contains valid JSON.',
      });
      process.exit(2);
    }
    await dispatchFromCli(
      'query',
      'check',
      'chain.validate',
      { chain },
      { command: 'check', operation: 'check.chain.validate' },
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
 * cleo check arch — run all 5 SG-ARCH-SOLID architectural lint gates and
 * emit a LAFS-compliant summary envelope.
 *
 * Gates (Saga T9831 · Epic T9837):
 *   Gate 1 (T9837a): lint-no-raw-define-command.mjs   — no defineCommand() outside lib factory
 *   Gate 2 (T9837b): lint-no-direct-db-open.mjs       — no DatabaseSync outside core/store
 *   Gate 3 (T9837c): lint-contracts-fan-out.mjs        — no inline types imported by >2 files
 *   Gate 4 (T9837d): lint-no-ssot-exempt.mjs           — no SSoT-EXEMPT without task ID
 *   Gate 5 (T9837e): lint-cli-package-boundary.mjs     — no helper > 30 LOC in CLI commands
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

    /** The 5 SG-ARCH-SOLID gates in order. */
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

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(envelope)}\n`);

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
 * Root check command group — validation and compliance checks.
 *
 * Dispatches to the check domain. Supports schema validation, coherence,
 * task checks, output validation, WarpChain validation, canon drift
 * detection, and RCASD-IVTR+C protocol checks.
 */
export const checkCommand = defineCommand({
  meta: { name: 'check', description: 'Validation and compliance checks' },
  subCommands: {
    schema: checkSchemaCommand,
    coherence: checkCoherenceCommand,
    task: checkTaskCommand,
    output: checkOutputCommand,
    'chain-validate': checkChainValidateCommand,
    canon: checkCanonCommand,
    protocol: checkProtocolCommand,
    provenance: checkProvenanceCommand,
    arch: checkArchCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
