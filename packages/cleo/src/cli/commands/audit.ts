/**
 * CLI audit command group — git-backed audit, lineage reconstruction, and
 * independent verifier re-runs for the auditor-loop protocol.
 *
 * Subcommands:
 *   cleo audit reconstruct <taskId>  — reconstruct git-log + release-tag
 *                                      lineage for a task and its children
 *   cleo audit verifier <taskId>     — independently re-run the acceptance
 *                                      verifier script (ADR-070 auditor-loop).
 *                                      Does NOT trust prior Implementer claims.
 *                                      Exits 0 only if verifier exits 0.
 *
 * The `reconstruct` subcommand is the CLI surface for the
 * `reconstructLineage` SDK primitive in `packages/core/src/audit/reconstruct.ts`.
 * It treats git as the immutable ledger (no parallel `.jsonl` emission) per
 * the FP peer note and T1322 council verdict (2026-04-24).
 *
 * The `verifier` subcommand (T9192 / ADR-070) implements the independent
 * acceptance-check arm of the auditor-loop pattern. It resolves the task's
 * verifier script and runs it in isolation — providing an authoritative,
 * independent result that cannot be faked by the Implementer.
 *
 * All output routes through cliOutput() / cliError() — no raw stdout writes.
 *
 * @task T1322, T1729, T9192
 * @epic T1216, T1691
 * @adr ADR-070
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getProjectRoot, reconstructLineage } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * cleo audit reconstruct <taskId> — reconstruct git-backed lineage for a task.
 *
 * Queries git log and release tags to produce a {@link ReconstructResult}
 * for the given task ID and all inferred children. Output is printed as
 * formatted JSON to stdout (LAFS-envelope-compatible via the `--json` flag).
 *
 * @example
 * ```sh
 * cleo audit reconstruct T991
 * cleo audit reconstruct T991 --json
 * ```
 */
const reconstructCommand = defineCommand({
  meta: {
    name: 'reconstruct',
    description: 'Reconstruct git-backed lineage (commits + release tags) for a task',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to reconstruct (e.g. T991)',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Emit raw JSON output instead of formatted summary',
      default: false,
    },
    'repo-root': {
      type: 'string',
      description: 'Path to the git repository root (defaults to current project root)',
    },
  },
  async run({ args }) {
    const taskId = args['taskId'] as string;

    if (!taskId || !/^T\d+$/i.test(taskId)) {
      cliError(
        `taskId must match /^T\\d+$/ (e.g. T991). Got: ${JSON.stringify(taskId)}`,
        1,
        { name: 'E_VALIDATION' },
        { operation: 'audit.reconstruct' },
      );
      process.exit(1);
    }

    // Resolve repo root: explicit flag > project root detection > cwd
    let repoRoot: string;
    if (args['repo-root']) {
      repoRoot = args['repo-root'] as string;
    } else {
      try {
        repoRoot = getProjectRoot(process.cwd()) ?? process.cwd();
      } catch {
        repoRoot = process.cwd();
      }
    }

    const result = await reconstructLineage(taskId, repoRoot);

    cliOutput(result, {
      command: 'audit-reconstruct',
      operation: 'audit.reconstruct',
      message: `Lineage for ${result.taskId}`,
    });
  },
});

// ---------------------------------------------------------------------------
// Verifier script resolution (shared with verify.ts, duplicated for isolation)
// ---------------------------------------------------------------------------

/**
 * Resolve the acceptance verifier script path for a given task ID.
 *
 * Convention (ADR-070):
 *   1. scripts/verify-<taskId>-fu.mjs   (recovery follow-up convention)
 *   2. scripts/verify-<taskId>.mjs      (general convention)
 *   3. Same with lowercase ID
 *
 * @param taskId - Task ID (e.g. "T9188").
 * @param projectRoot - Project root to search from.
 * @returns Absolute path, or null if not found.
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
 * `cleo audit verifier <taskId>` — independent acceptance verifier re-run.
 *
 * Implements the Auditor arm of the ADR-070 auditor-loop pattern.
 * Does NOT read any Implementer claims — runs the verifier script in isolation
 * and reports the exit code.
 *
 * @task T9192
 * @adr ADR-070
 */
const verifierCommand = defineCommand({
  meta: {
    name: 'verifier',
    description:
      'Independent acceptance verifier re-run (ADR-070 auditor-loop). ' +
      'Resolves scripts/verify-<taskId>-fu.mjs and runs it independently. ' +
      'Does NOT trust prior Implementer claims. Exits non-zero if verifier fails.',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID whose acceptance verifier script to run independently (e.g. T9188)',
      required: true,
    },
    script: {
      type: 'string',
      description: 'Explicit path to the verifier script (overrides auto-resolution)',
    },
  },
  async run({ args }) {
    const taskId = String(args.taskId);

    let projectRoot: string;
    try {
      projectRoot = getProjectRoot(process.cwd()) ?? resolve(process.cwd());
    } catch {
      projectRoot = resolve(process.cwd());
    }

    let verifierPath: string | null;

    if (args.script) {
      const explicit = resolve(projectRoot, String(args.script));
      verifierPath = existsSync(explicit) ? explicit : null;
      if (!verifierPath) {
        cliError(`Verifier script not found: ${explicit}`, 1, { name: 'E_NOT_FOUND' });
        process.exitCode = 1;
        return;
      }
    } else {
      verifierPath = resolveVerifierScript(taskId, projectRoot);
    }

    if (!verifierPath) {
      cliError(
        `No verifier script found for ${taskId}.\n` +
          `  Looked for: scripts/verify-${taskId}-fu.mjs, scripts/verify-${taskId}.mjs\n` +
          `  Create the verifier script per ADR-070 before running the auditor.`,
        1,
        { name: 'E_NOT_FOUND' },
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`[AUDITOR] Independent verifier run for ${taskId}\n`);
    process.stdout.write(`[AUDITOR] Script: ${verifierPath}\n`);
    process.stdout.write(`[AUDITOR] Note: Does NOT trust any prior Implementer claims.\n\n`);

    const result = spawnSync('node', [verifierPath], { encoding: 'utf8', stdio: 'inherit' });
    const exitCode = result.status ?? 1;

    if (exitCode === 0) {
      process.stdout.write(
        `\n[AUDITOR] Audit pass. Verifier exit-code 0. Task ${taskId} acceptance verified.\n`,
      );
    } else {
      process.stderr.write(
        `\n[AUDITOR] Audit fail. Verifier exit-code ${exitCode}. Task ${taskId} NOT verified.\n` +
          `  E_ACCEPTANCE_VERIFIER_FAILED. Implementation must be re-worked. (ADR-070)\n`,
      );
      process.exitCode = exitCode;
    }
  },
});

/**
 * Root `cleo audit` command group.
 *
 * Provides git-backed audit tooling and independent verifier re-runs for the
 * ADR-070 auditor-loop pattern.
 *
 * @task T1216, T9192
 * @adr ADR-070
 */
export const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description:
      'Git-backed audit tooling (lineage reconstruction, integrity checks). ' +
      'Also provides independent acceptance verifier re-runs for the ADR-070 auditor-loop ' +
      'pattern (verifier subcommand — does not trust Implementer claims, runs script independently).',
  },
  subCommands: {
    reconstruct: reconstructCommand,
    verifier: verifierCommand,
  },
  async run({ args: _args }) {
    await showUsage(auditCommand as Parameters<typeof showUsage>[0]);
  },
});
