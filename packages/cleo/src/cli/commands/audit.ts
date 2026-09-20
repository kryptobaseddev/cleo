/**
 * CLI audit command group — git-backed audit and lineage reconstruction.
 *
 * Subcommands:
 *   cleo audit reconstruct <taskId>  — reconstruct git-log + release-tag
 *                                      lineage for a task and its children
 *
 * The `reconstruct` subcommand is the CLI surface for the
 * `reconstructLineage` SDK primitive in `packages/core/src/audit/reconstruct.ts`.
 * It treats git as the immutable ledger (no parallel `.jsonl` emission) per
 * the FP peer note and T1322 council verdict (2026-04-24).
 *
 * The `verifier` subcommand was removed per T9337 / Council 20260515T211404Z —
 * the per-task `.mjs` substrate is deprecated and replaced by the ADR-051
 * evidence-atom Pre-Complete Gate Ritual. Independent re-verification of a
 * task's completion claims happens via `cleo verify <taskId> --explain`
 * which re-validates every evidence atom against git/fs/toolchain.
 *
 * All output routes through cliOutput() / cliError() — no raw stdout writes.
 *
 * @task T1322, T1729, T9337
 * @epic T1216, T1691
 * @adr ADR-051
 */

import { reconstructLineage } from '@cleocode/core/audit/reconstruct';
import { getProjectRoot } from '@cleocode/core/project-scope';
import { renderAuditReconstruct } from '@cleocode/core/render/orchestration/audit-reconstruct';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
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
    'budget-ms': {
      type: 'string',
      description: 'Shared bounded assessment deadline in milliseconds',
      default: '2000',
    },
    'max-output-bytes': {
      type: 'string',
      description: 'Combined Git capture byte ceiling',
      default: '8388608',
    },
    'repo-root': {
      type: 'string',
      description: 'Path to the git repository root (defaults to current project root)',
    },
  },
  async run({ args }) {
    const taskId = args.taskId.toUpperCase();
    const budgetMs = Number(args['budget-ms']);
    const maxOutputBytes = Number(args['max-output-bytes']);
    const deadlineAt = Date.now() + budgetMs;

    if (
      !/^T\d+$/.test(taskId) ||
      !/^\d+$/.test(args['budget-ms']) ||
      !/^\d+$/.test(args['max-output-bytes']) ||
      !Number.isSafeInteger(budgetMs) ||
      !Number.isSafeInteger(maxOutputBytes) ||
      !Number.isSafeInteger(deadlineAt)
    ) {
      cliError(
        'Task ID must be T followed by digits; budget-ms and max-output-bytes must be nonnegative safe integers.',
        1,
        { name: 'E_VALIDATION' },
        { operation: 'audit.reconstruct' },
      );
      process.exitCode = 1;
      return;
    }

    const repoRoot = args['repo-root'] ?? getProjectRoot(process.cwd()) ?? process.cwd();
    const result = await reconstructLineage(taskId, repoRoot, {
      execution: { deadlineAt },
      maxOutputBytes,
    });
    if (result.assessment?.coverage !== 'current') {
      process.exitCode = 1;
      cliError(
        renderAuditReconstruct({ ...result }, false),
        1,
        {
          name: 'E_AUDIT_INCOMPLETE',
          details: result,
          fix: 'Inspect assessment diagnostics; request an explicit larger budget or restore missing evidence before retrying.',
        },
        { operation: 'audit.reconstruct' },
      );
      return;
    }

    cliOutput(result, {
      command: 'audit-reconstruct',
      operation: 'audit.reconstruct',
      message: `Lineage for ${result.taskId}`,
    });
  },
});

/**
 * Root `cleo audit` command group.
 *
 * Provides git-backed audit tooling. Independent re-verification of a task's
 * completion claims happens via `cleo verify <taskId> --explain` which
 * re-validates every ADR-051 evidence atom against git/fs/toolchain.
 *
 * @task T1216, T9337
 * @adr ADR-051
 */
export const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description:
      'Git-backed audit tooling (lineage reconstruction, integrity checks). ' +
      'Independent re-verification of task completion claims is handled by ' +
      '`cleo verify <taskId> --explain` which re-validates ADR-051 evidence atoms.',
  },
  subCommands: {
    reconstruct: reconstructCommand,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    await showUsage(cmd);
  },
});
