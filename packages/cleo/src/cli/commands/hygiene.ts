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
          "Report worktree retention and usage across registered projects; --apply reaps only the current project's proven-safe terminal worktrees. Foreign projects and branches stay report-only. Partial reports exit 124.",
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
        'budget-ms': {
          type: 'string',
          description:
            'Read-only report bound in ms (default: 180000; use 600000 for large repositories).',
        },
      },
      async run({ args }) {
        const dryRun = args.report === true || args['dry-run'] === true;
        if (dryRun && args.apply === true) {
          cliError('Pass --report/--dry-run or --apply, not both.', 2);
          process.exit(2);
          return;
        }
        let deadline: number | undefined;
        if (args['budget-ms'] !== undefined) {
          const budgetMs = Number(args['budget-ms']);
          if (
            !Number.isSafeInteger(budgetMs) ||
            budgetMs < 1 ||
            budgetMs > 2_147_483_647 ||
            args.apply === true
          ) {
            cliError(
              '--budget-ms requires a positive integer up to 2147483647 and a read-only report.',
              2,
            );
            process.exitCode = 2;
            return;
          }
          deadline = Date.now() + budgetMs;
        }
        const { reportWorktreeCensus, runWorktreeCensus } = await import(
          '@cleocode/core/hygiene/census'
        );
        let projectRoot: string | null = null;
        try {
          projectRoot = getProjectRoot();
        } catch {
          projectRoot = null;
        }
        const options = {
          applyProjects: projectRoot !== null ? [projectRoot] : [],
          allProjects: args['all-projects'] === true,
          ttlDays: args['ttl-days'] !== undefined ? Number(args['ttl-days']) : undefined,
          maxBytes: args['max-bytes'] !== undefined ? Number(args['max-bytes']) : undefined,
          exemptRegenerable: args['include-build-output'] === true,
          deadline,
        };
        const result = await (async () => {
          if (args.apply === true) return runWorktreeCensus({ ...options, apply: true });
          const controller = new AbortController();
          let interrupted = 0;
          const interrupt = () => {
            interrupted = 130;
            controller.abort();
          };
          const terminate = () => {
            interrupted = 143;
            controller.abort();
          };
          process.on('SIGINT', interrupt);
          process.on('SIGTERM', terminate);
          try {
            return await reportWorktreeCensus(options, controller.signal, (message) => {
              process.stderr.write(`[cleo hygiene] ${message}\n`); // json-stream-hygiene-allowed: T14538 scan progress; stdout carries the result envelope
            });
          } finally {
            process.removeListener('SIGINT', interrupt);
            process.removeListener('SIGTERM', terminate);
            if (interrupted !== 0) process.exitCode = interrupted;
          }
        })();
        if ('skipped' in result) {
          cliOutput(result, {
            command: 'hygiene',
            operation: 'hygiene.census',
            message: `Census skipped: ${result.skipped}.`,
          });
          return;
        }
        const { counts, reclaimedApparentBytes, mode } = result.record;
        if (mode === 'report' && result.record.partial && !process.exitCode) process.exitCode = 124;
        cliOutput(
          { ...result.record, recordPath: result.recordPath },
          {
            command: 'hygiene',
            operation: 'hygiene.census',
            message:
              `Worktree census (${mode}): ${counts.active} active, ${counts.redundant} redundant, ` +
              `${counts.keep} keep, ${counts.unknown} unknown` +
              (mode === 'apply' ? `; reclaimed ${reclaimedApparentBytes} bytes (apparent)` : '') +
              (result.record.partial
                ? `; partial: ${result.record.partialReason ?? 'scan incomplete'}`
                : '') +
              `. Record: ${result.recordPath}`,
          },
        );
      },
    }),
  },
});
