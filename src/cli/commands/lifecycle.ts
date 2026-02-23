/**
 * CLI lifecycle command group.
 * @task T4467
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';

export function registerLifecycleCommand(program: Command): void {
  const lifecycle = program
    .command('lifecycle')
    .description('RCSD pipeline lifecycle management');

  lifecycle
    .command('show <epicId>')
    .description('Show lifecycle state for an epic')
    .action(async (epicId: string) => {
      await dispatchFromCli('query', 'pipeline', 'stage.status', { epicId }, { command: 'lifecycle' });
    });

  lifecycle
    .command('start <epicId> <stage>')
    .description('Start a lifecycle stage')
    .action(async (epicId: string, stage: string) => {
      await dispatchFromCli('mutate', 'pipeline', 'stage.record', {
        taskId: epicId, stage, status: 'in_progress',
      }, { command: 'lifecycle' });
    });

  lifecycle
    .command('complete <epicId> <stage>')
    .description('Complete a lifecycle stage')
    .option('--artifacts <artifacts>', 'Comma-separated artifact paths')
    .option('--notes <notes>', 'Completion notes')
    .action(async (epicId: string, stage: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'pipeline', 'stage.record', {
        taskId: epicId, stage, status: 'completed', notes: opts['notes'],
      }, { command: 'lifecycle' });
    });

  lifecycle
    .command('skip <epicId> <stage>')
    .description('Skip a lifecycle stage')
    .requiredOption('--reason <reason>', 'Reason for skipping')
    .action(async (epicId: string, stage: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'pipeline', 'stage.skip', {
        taskId: epicId, stage, reason: opts['reason'],
      }, { command: 'lifecycle' });
    });

  lifecycle
    .command('gate <epicId> <stage>')
    .description('Check lifecycle gate for a stage')
    .action(async (epicId: string, stage: string) => {
      const result = await dispatchRaw('query', 'pipeline', 'stage.validate', {
        epicId, targetStage: stage,
      });
      if (result.success) {
        const { cliOutput } = await import('../renderers/index.js');
        cliOutput(result.data, { command: 'lifecycle' });
        const data = result.data as Record<string, unknown> | undefined;
        if (data && !data['allowed']) {
          process.exit(80);
        }
      } else {
        const { cliError } = await import('../renderers/index.js');
        cliError(result.error?.message ?? 'Gate check failed', result.error?.exitCode ?? 1);
        process.exit(result.error?.exitCode ?? 1);
      }
    });
}
