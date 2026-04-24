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
 * @task T1322
 * @epic T1216
 */

import type { CommitEntry } from '@cleocode/contracts';
import { getProjectRoot, reconstructLineage } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';

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
      process.stderr.write(
        `Error: taskId must match /^T\\d+$/ (e.g. T991). Got: ${JSON.stringify(taskId)}\n`,
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

    if (args['json']) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    // Human-readable summary output
    const lines: string[] = [
      `Lineage for ${result.taskId}`,
      `${'='.repeat(40)}`,
      '',
      `Direct commits: ${result.directCommits.length}`,
    ];

    for (const c of result.directCommits) {
      lines.push(`  ${c.sha.slice(0, 10)}  ${c.subject}`);
    }

    lines.push('');
    if (result.childIdRange) {
      lines.push(
        `Inferred children: ${result.inferredChildren.join(', ')} (${result.childIdRange.min} → ${result.childIdRange.max})`,
      );
    } else {
      lines.push('Inferred children: none');
    }

    const childEntries: [string, CommitEntry[]][] = Object.entries(result.childCommits);
    if (childEntries.length > 0) {
      lines.push('');
      lines.push('Child commits:');
      for (const [childId, commits] of childEntries) {
        lines.push(`  ${childId}: ${commits.length} commit(s)`);
        for (const c of commits) {
          lines.push(`    ${c.sha.slice(0, 10)}  ${c.subject}`);
        }
      }
    }

    lines.push('');
    if (result.releaseTags.length > 0) {
      lines.push(`Release tags (${result.releaseTags.length}):`);
      for (const t of result.releaseTags) {
        lines.push(`  ${t.tag}  ${t.commitSha.slice(0, 10)}  ${t.subject}`);
      }
    } else {
      lines.push('Release tags: none found');
    }

    lines.push('');
    lines.push(`First seen: ${result.firstSeenAt ?? 'n/a'}`);
    lines.push(`Last seen:  ${result.lastSeenAt ?? 'n/a'}`);

    process.stdout.write(`${lines.join('\n')}\n`);
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
