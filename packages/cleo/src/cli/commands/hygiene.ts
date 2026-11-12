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

import { runSpawnReadinessHygieneCli } from '@cleocode/core/hygiene/validate-spawn-readiness.js';
import { getProjectRoot } from '@cleocode/core/project-scope';
import { defineCommand } from '../lib/define-cli-command.js';
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
          "Report worktree retention and usage across registered projects; --apply reaps only the current project's proven-safe terminal worktrees. Foreign projects and branches stay report-only.",
      },
      args: {
        report: {
          type: 'boolean',
          description:
            'List every worktree and the removal plan without removing anything (default)',
          default: false,
        },
        apply: {
          type: 'boolean',
          description:
            "Remove only this project's proven-redundant terminal worktrees; foreign projects remain report-only",
          default: false,
        },
        'dry-run': {
          type: 'boolean',
          description:
            'Preview the same reaper plan without removing worktrees or releasing locks.',
          default: false,
        },
        'all-projects': {
          type: 'boolean',
          description: 'Report all registered projects; foreign worktrees remain report-only.',
          default: false,
        },
        'ttl-days': {
          type: 'string',
          description: 'Minimum idle age in days; a size budget never overrides this (default: 0).',
        },
        'max-bytes': {
          type: 'string',
          description:
            'Target retained apparent bytes; removes oldest eligible worktrees first (default: 0).',
        },
        'include-build-output': {
          type: 'boolean',
          description:
            'Also allow merged ignored build output to be regenerated; never force-archive it.',
          default: false,
        },
      },
      async run({ args }) {
        const dryRun = args.report === true || args['dry-run'] === true;
        if (dryRun && args.apply === true) {
          cliError('Pass --report/--dry-run or --apply, not both.', 2);
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
          allProjects: args['all-projects'] === true,
          ttlDays: args['ttl-days'] !== undefined ? Number(args['ttl-days']) : undefined,
          maxBytes: args['max-bytes'] !== undefined ? Number(args['max-bytes']) : undefined,
          exemptRegenerable: args['include-build-output'] === true,
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
