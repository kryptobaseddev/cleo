/**
 * CLI verify command — view or modify verification gates for a task.
 *
 * Routes through the dispatch layer to check.gate.set (mutate),
 * check.gate.status (query, default view), and check.verify.explain
 * (query, when --explain is passed — T1006 / T1013).
 *
 * As of v2026.4.78 (T832 / ADR-051), gate writes MUST be accompanied by
 * structured `--evidence` backing the claim (commit SHAs, files, test runs,
 * tool results).  `--all` alone is rejected with E_EVIDENCE_MISSING.
 *
 * The `--explain` flag (T1013) enriches a read-only view with:
 *   - `gates[]`   : per-gate {name, state, timestamp} records
 *   - `evidence[]`: per-gate evidence atoms with re-validation status
 *   - `blockers[]`: human-readable reasons why `cleo complete` cannot yet run
 *
 * Without `--explain` the response shape is identical to prior releases.
 *
 * The `--shared-evidence` flag (T1502 / P0-6) acknowledges that the same
 * evidence atom is being applied to more than 3 distinct tasks in this
 * session.  Without the flag such reuse triggers a warning on stderr; in
 * strict mode (`CLEO_STRICT_EVIDENCE=1`) it is a hard reject.
 *
 * The `--acceptance-check` flag (T9192 / ADR-070) resolves
 * `scripts/verify-<taskId>-fu.mjs` (or `scripts/verify-<taskId>.mjs`)
 * and runs it via `node`. If the verifier exits non-zero, the command
 * exits non-zero and blocks gate writes. This is the programmatic AC gate.
 *
 * @task T4454
 * @task T832
 * @task T1006
 * @task T1013
 * @task T1502
 * @task T9192
 * @adr ADR-051
 * @adr ADR-059
 * @adr ADR-070
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Resolve the verifier script path for a given task ID.
 *
 * Search order:
 *   1. scripts/verify-<taskId>-fu.mjs  (recovery follow-up convention)
 *   2. scripts/verify-<taskId>.mjs      (general convention)
 *   3. scripts/verify-<lowercase-id>-fu.mjs
 *   4. scripts/verify-<lowercase-id>.mjs
 *
 * @param taskId - Task ID (e.g. "T9188").
 * @param projectRoot - Project root to search from.
 * @returns Absolute path to verifier script, or null if not found.
 */
function resolveVerifierScript(taskId: string, projectRoot: string): string | null {
  const id = taskId.toLowerCase();
  const candidates = [
    join(projectRoot, 'scripts', `verify-${taskId}-fu.mjs`),
    join(projectRoot, 'scripts', `verify-${taskId}.mjs`),
    join(projectRoot, 'scripts', `verify-${id}-fu.mjs`),
    join(projectRoot, 'scripts', `verify-${id}.mjs`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run the verifier script for a task and return the exit code.
 *
 * @param verifierPath - Absolute path to the verifier script.
 * @returns Exit code (0 = pass, non-zero = fail).
 */
function runVerifier(verifierPath: string): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [verifierPath], { encoding: 'utf8' });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * cleo verify <task-id> — view or modify verification gates.
 *
 * @remarks
 * Read-only view is the default when no write flag is provided.  Passing
 * `--explain` enriches the view with the blocker breakdown described in
 * ADR-051 §2.3 (T1013).
 *
 * Pass `--shared-evidence` when knowingly applying the same evidence atom
 * across more than 3 tasks in one session (T1502 / ADR-059).
 *
 * Pass `--acceptance-check [script]` to run the task's verifier script before
 * any gate writes. A non-zero exit from the verifier blocks the operation
 * (T9192 / ADR-070).
 */
export const verifyCommand = defineCommand({
  meta: { name: 'verify', description: 'View or modify verification gates for a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to inspect or update',
      required: false,
    },
    gate: {
      type: 'string',
      description: 'Set a specific gate by name',
    },
    value: {
      type: 'string',
      description: 'Gate value: true or false',
      default: 'true',
    },
    agent: {
      type: 'string',
      description: 'Agent setting the gate',
    },
    all: {
      type: 'boolean',
      description: 'Mark all required gates as passed',
    },
    reset: {
      type: 'boolean',
      description: 'Reset verification to initial state',
    },
    evidence: {
      type: 'string',
      description:
        "Evidence for the gate (T832/ADR-051). Semicolon-separated atoms: 'commit:<sha>', 'files:<p1,p2>', 'test-run:<json>', 'tool:<name>', 'url:<url>', 'note:<text>'.",
    },
    explain: {
      type: 'boolean',
      description:
        'Enrich read-only view with per-gate evidence breakdown, re-validation status, and blockers[] preventing `cleo complete` (T1013 / ADR-051).',
    },
    'shared-evidence': {
      type: 'boolean',
      description:
        'Acknowledge that the same evidence atom is applied to >3 distinct tasks in this session (T1502 / ADR-059). Without this flag, such reuse triggers a warning; in strict mode (CLEO_STRICT_EVIDENCE=1) it is a hard reject.',
    },
    'acceptance-check': {
      type: 'string',
      description:
        'Run the task acceptance verifier before any gate write. Resolves scripts/verify-<taskId>-fu.mjs (or pass an explicit path). Blocks if verifier exits non-zero. (T9192 / ADR-070)',
      required: false,
    },
  },
  async run({ args, cmd }) {
    if (!args.taskId) {
      await showUsage(cmd);
      return;
    }

    // --acceptance-check: resolve and run the verifier script (T9192 / ADR-070)
    const acceptanceCheckRaw = args['acceptance-check'] as string | boolean | undefined;
    const shouldRunAcceptanceCheck =
      acceptanceCheckRaw !== undefined && acceptanceCheckRaw !== false;

    if (shouldRunAcceptanceCheck) {
      const projectRoot = resolve(process.cwd());
      let verifierPath: string | null = null;

      if (typeof acceptanceCheckRaw === 'string' && acceptanceCheckRaw.length > 0) {
        // Explicit path provided — use it directly
        const explicit = resolve(projectRoot, acceptanceCheckRaw);
        verifierPath = existsSync(explicit) ? explicit : null;
        if (!verifierPath) {
          process.stderr.write(
            `Error: --acceptance-check path not found: ${explicit}\n` +
              `  T9192 / ADR-070: verifier script must exist before gate writes are allowed.\n`,
          );
          process.exitCode = 1;
          return;
        }
      } else {
        // Auto-resolve by task ID
        verifierPath = resolveVerifierScript(String(args.taskId), projectRoot);
      }

      if (!verifierPath) {
        process.stderr.write(
          `Error: --acceptance-check: no verifier script found for ${args.taskId}.\n` +
            `  Looked for: scripts/verify-${args.taskId}-fu.mjs, scripts/verify-${args.taskId}.mjs\n` +
            `  T9192 / ADR-070: create the verifier script before using --acceptance-check.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const { exitCode, stdout, stderr } = runVerifier(verifierPath);
      process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);

      if (exitCode !== 0) {
        process.stderr.write(
          `\nE_ACCEPTANCE_VERIFIER_FAILED: verifier exited ${exitCode}.\n` +
            `  Verifier: ${verifierPath}\n` +
            `  Gate writes blocked until verifier exits 0. (T9192 / ADR-070)\n`,
        );
        process.exitCode = exitCode;
        return;
      }

      process.stdout.write(`Verifier passed (exit 0). Proceeding with gate operation.\n`);
    }

    const isWrite = !!(args.gate || args.all || args.reset);
    // --explain is a read-only enrichment; writes ignore it and keep prior behavior.
    const useExplain = !isWrite && args.explain === true;

    const operation = isWrite ? 'gate.set' : useExplain ? 'verify.explain' : 'gate.status';

    await dispatchFromCli(
      isWrite ? 'mutate' : 'query',
      'check',
      operation,
      {
        taskId: args.taskId,
        gate: args.gate as string | undefined,
        value: args.value === 'false' ? false : args.gate ? true : undefined,
        agent: args.agent as string | undefined,
        all: args.all as boolean | undefined,
        reset: args.reset as boolean | undefined,
        evidence: args.evidence as string | undefined,
        sharedEvidence: (args['shared-evidence'] as boolean | undefined) ?? false,
      },
      { command: 'verify' },
    );
  },
});
