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
 * The `backfill` subcommand (T9218 / ADR-070) auto-generates verifier stubs
 * from AC text for existing tasks that lack one. Idempotent: refuses to
 * overwrite without `--force`.
 *
 * @task T4454
 * @task T832
 * @task T1006
 * @task T1013
 * @task T1502
 * @task T9192
 * @task T9218
 * @adr ADR-051
 * @adr ADR-059
 * @adr ADR-070
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateVerifierStub, getProjectRoot, writeVerifierStub } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';

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

// ---------------------------------------------------------------------------
// backfill subcommand (T9218 / ADR-070)
// ---------------------------------------------------------------------------

/**
 * cleo verify backfill <taskId> — auto-generate a verifier stub from AC text.
 *
 * Generates `scripts/verify-<lowercase-taskId>.mjs` with one `process.exit(1)`
 * stub per AC bullet. The stubs are intentionally non-passing; replacing them
 * with real checks is the implementer's job.
 *
 * Idempotent: refuses to overwrite an existing verifier without `--force`.
 *
 * @task T9218
 * @adr ADR-070
 */
const backfillCommand = defineCommand({
  meta: {
    name: 'backfill',
    description:
      'Auto-generate a verifier stub from AC text for a task lacking one (T9218 / ADR-070)',
  },
  args: {
    taskId: {
      type: 'positional',
      description:
        'Task ID to generate a verifier stub for (e.g. T9213). Omit when using --all-pending.',
      required: false,
    },
    'all-pending': {
      type: 'boolean',
      description: 'Process all critical/large/epic tasks that lack a verifier script (T9218)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite an existing verifier without error (idempotency override)',
    },
  },
  async run({ args, cmd }) {
    const projectRoot = getProjectRoot();
    const force = !!args.force;

    if (args['all-pending']) {
      await backfillAllPending(projectRoot, force);
      return;
    }

    if (!args.taskId) {
      await showUsage(cmd);
      return;
    }

    await backfillSingle(String(args.taskId), projectRoot, force);
  },
});

/**
 * Generate a verifier stub for a single task.
 *
 * @param taskId - Task ID to process.
 * @param projectRoot - Absolute path to the project root.
 * @param force - Overwrite existing verifier when true.
 */
async function backfillSingle(taskId: string, projectRoot: string, force: boolean): Promise<void> {
  // Fetch the task via dispatch
  const response = await dispatchRaw('query', 'tasks', 'show', { taskId });
  if (!response.success) {
    process.stderr.write(
      `Error: could not fetch task ${taskId}: ${(response.error as { message?: string })?.message ?? 'unknown error'}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const task = (response.data as { task?: Record<string, unknown> })?.task;
  if (!task) {
    process.stderr.write(`Error: task ${taskId} not found.\n`);
    process.exitCode = 1;
    return;
  }

  // Check idempotency — refuse if verifier already exists and --force not set
  const existing = resolveVerifierScript(taskId, projectRoot);
  if (existing && !force) {
    process.stderr.write(
      `Error: verifier already exists: ${existing}\n` +
        `  Use --force to overwrite. (T9218 idempotency guard)\n`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    // The dispatch response gives us a plain record; cast via unknown for type safety
    const source = generateVerifierStub(
      task as unknown as Parameters<typeof generateVerifierStub>[0],
    );
    const outPath = writeVerifierStub(taskId, source, projectRoot, force);
    process.stdout.write(`Generated: ${outPath}\n`);
    process.stdout.write(
      `\nNext steps:\n` +
        `  1. Replace each \`fail('STUB — ...')\` block with a real check.\n` +
        `  2. Verify manually: node ${outPath}\n` +
        `  3. When the script exits 0: cleo verify ${taskId} --acceptance-check\n`,
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`Error generating verifier for ${taskId}: ${msg}\n`);
    process.exitCode = 1;
  }
}

/**
 * Enumerate all critical/large/epic tasks lacking a verifier and process each.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param force - Overwrite existing verifiers when true.
 */
async function backfillAllPending(projectRoot: string, force: boolean): Promise<void> {
  // Collect tasks via multiple queries: critical priority, large size, epic type.
  // We use separate queries and deduplicate by task ID to cover all three axes.
  const seen = new Set<string>();
  const pending: Array<Record<string, unknown>> = [];

  const queries = [
    dispatchRaw('query', 'tasks', 'list', { priority: 'critical', limit: 200 }),
    dispatchRaw('query', 'tasks', 'list', { size: 'large', limit: 200 }),
    dispatchRaw('query', 'tasks', 'list', { type: 'epic', limit: 200 }),
  ];

  const results = await Promise.all(queries);
  for (const response of results) {
    if (!response.success) continue;
    const tasks = (response.data as { tasks?: Array<Record<string, unknown>> })?.tasks ?? [];
    for (const t of tasks) {
      const id = String(t.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      pending.push(t);
    }
  }

  // Filter to tasks that lack a verifier script
  const lacking = pending.filter((t) => {
    const id = String(t.id ?? '');
    return !resolveVerifierScript(id, projectRoot);
  });

  if (lacking.length === 0) {
    process.stdout.write(
      'All critical/large/epic tasks already have verifier scripts. Nothing to do.\n',
    );
    return;
  }

  process.stdout.write(
    `Found ${lacking.length} task(s) lacking a verifier script. Generating stubs...\n\n`,
  );

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of lacking) {
    const id = String(task.id ?? '');
    try {
      const source = generateVerifierStub(
        task as unknown as Parameters<typeof generateVerifierStub>[0],
      );
      const outPath = writeVerifierStub(id, source, projectRoot, force);
      process.stdout.write(`  [OK] ${id} → ${outPath}\n`);
      succeeded++;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes('verifier already exists')) {
        process.stdout.write(
          `  [SKIP] ${id}: verifier already exists (use --force to overwrite)\n`,
        );
        skipped++;
      } else {
        process.stderr.write(`  [FAIL] ${id}: ${msg}\n`);
        failed++;
      }
    }
  }

  process.stdout.write(
    `\nDone: ${succeeded} generated, ${skipped} skipped (already exist), ${failed} failed.\n`,
  );
  process.stdout.write(
    `\nNext steps for each generated file:\n` +
      `  1. Replace each \`fail('STUB — ...')\` block with a real check.\n` +
      `  2. node scripts/verify-<id>.mjs   (must exit 0 before cleo complete)\n`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Main verify command (with backfill subcommand)
// ---------------------------------------------------------------------------

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
 *
 * Use `cleo verify backfill <taskId>` to auto-generate a stub verifier for
 * an existing task (T9218 / ADR-070).
 */
export const verifyCommand = defineCommand({
  meta: { name: 'verify', description: 'View or modify verification gates for a task' },
  subCommands: {
    backfill: backfillCommand,
  },
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
