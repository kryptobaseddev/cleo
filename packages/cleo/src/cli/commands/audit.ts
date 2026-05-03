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
 * All output routes through cliOutput() / cliError() — no raw stdout writes.
 *
 * @task T1322, T1729
 * @epic T1216, T1691
 */

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

/**
 * Root `cleo audit` command group.
 *
 * Provides git-backed audit tooling for the T1216 audit epic.
 */
export const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description: 'Git-backed audit tooling (lineage reconstruction, integrity checks)',
  },
  subCommands: {
    reconstruct: reconstructCommand,
  },
  async run({ args: _args }) {
    await showUsage(auditCommand as Parameters<typeof showUsage>[0]);
  },
});
