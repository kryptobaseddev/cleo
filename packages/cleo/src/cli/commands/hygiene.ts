/**
 * CLI hygiene command — spawn-readiness pre-flight checks (T10451).
 *
 * Subcommands: `validate-spawn-readiness` (T10451) and `census` (T14275), the
 * machine-wide worktree census (`packages/core/src/hygiene/census.ts`).
 *
 * @task T10451
 * @task T14275
 * @saga T10431
 */

import { getProjectRoot } from '@cleocode/core';
import { runSpawnReadinessHygieneCli } from '@cleocode/core/hygiene/validate-spawn-readiness.js';
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

export const hygieneCommand = defineCommand({
  meta: {
    name: 'hygiene',
    description: 'Run spawn-readiness hygiene checks',
  },
  subCommands: {
    'validate-spawn-readiness': defineCommand({
      meta: {
        name: 'validate-spawn-readiness',
        description:
          'Run all pre-spawn hygiene gates (changeset lint, changelog drift, worktree location)',
      },
      args: {
        'project-root': {
          type: 'string',
          description: 'Project root directory (default: auto-detect)',
        },
        'worktree-path': {
          type: 'string',
          description: 'Expected worktree path for location validation',
        },
      },
      async run({ args }) {
        const projectRoot =
          (args['project-root'] as string | undefined) || getProjectRoot() || process.cwd();
        const worktreePath = args['worktree-path'] as string | undefined;
        await runSpawnReadinessHygieneCli(projectRoot, worktreePath);
      },
    }),
    census: defineCommand({
      meta: {
        name: 'census',
        description:
          'Classify every worktree under the machine worktree root by its disposal proof and record it (report only unless --apply)',
      },
      args: {
        report: {
          type: 'boolean',
          description:
            'List every worktree by project with its category, bytes and keep reason (default)',
          default: false,
        },
        apply: {
          type: 'boolean',
          description:
            "Also remove this project's proven-redundant worktrees; other projects stay report-only",
          default: false,
        },
      },
      async run({ args }) {
        if (args.report === true && args.apply === true) {
          cliError('Pass --report or --apply, not both.', 2);
          process.exit(2);
          return;
        }
        const { runWorktreeCensus } = await import('@cleocode/core/hygiene/census');
        let projectRoot: string | null = null;
        try {
          projectRoot = getProjectRoot();
        } catch {
          projectRoot = null;
        }
        const result = await runWorktreeCensus({
          apply: args.apply === true,
          applyProjects: projectRoot !== null ? [projectRoot] : [],
        });
        if ('skipped' in result) {
          cliOutput(result, {
            command: 'hygiene',
            operation: 'hygiene.census',
            message: `Census skipped: ${result.skipped}.`,
          });
          return;
        }
        const { counts, reclaimedApparentBytes, mode } = result.record;
        cliOutput(
          { ...result.record, recordPath: result.recordPath },
          {
            command: 'hygiene',
            operation: 'hygiene.census',
            message:
              `Worktree census (${mode}): ${counts.active} active, ${counts.redundant} redundant, ` +
              `${counts.keep} keep, ${counts.unknown} unknown` +
              (mode === 'apply' ? `; reclaimed ${reclaimedApparentBytes} bytes (apparent)` : '') +
              `. Record: ${result.recordPath}`,
          },
        );
      },
    }),
  },
});
