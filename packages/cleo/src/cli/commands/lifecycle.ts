/**
 * CLI lifecycle command group.
 * @task T4467
 * @epic T4454
 */

import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerLifecycleCommand(program: Command): void {
  const lifecycle = program
    .command('lifecycle')
    .description('RCASD-IVTR+C lifecycle pipeline management');

  lifecycle
    .command('show <epicId>')
    .description('Show lifecycle state for an epic')
    .action(async (epicId: string) => {
      await dispatchFromCli(
        'query',
        'pipeline',
        'stage.status',
        { epicId },
        { command: 'lifecycle' },
      );
    });

  lifecycle
    .command('start <epicId> <stage>')
    .description('Start a lifecycle stage')
    .action(async (epicId: string, stage: string) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'stage.record',
        {
          taskId: epicId,
          stage,
          status: 'in_progress',
        },
        { command: 'lifecycle' },
      );
    });

  lifecycle
    .command('complete <epicId> <stage>')
    .description('Complete a lifecycle stage')
    .option('--artifacts <artifacts>', 'Comma-separated artifact paths')
    .option('--notes <notes>', 'Completion notes')
    .action(async (epicId: string, stage: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'stage.record',
        {
          taskId: epicId,
          stage,
          status: 'completed',
          notes: opts['notes'],
        },
        { command: 'lifecycle' },
      );
    });

  lifecycle
    .command('skip <epicId> <stage>')
    .description('Skip a lifecycle stage')
    .requiredOption('--reason <reason>', 'Reason for skipping')
    .action(async (epicId: string, stage: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'stage.skip',
        {
          taskId: epicId,
          stage,
          reason: opts['reason'],
        },
        { command: 'lifecycle' },
      );
    });

  lifecycle
    .command('gate <epicId> <stage>')
    .description('Check lifecycle gate for a stage')
    .action(async (epicId: string, stage: string) => {
      const result = await dispatchRaw('query', 'pipeline', 'stage.validate', {
        epicId,
        targetStage: stage,
      });
      if (result.success) {
        const { cliOutput } = await import('../renderers/index.js');
        cliOutput(result.data, { command: 'lifecycle' });
        const data = result.data as Record<string, unknown> | undefined;
        if (data && !data['canProgress']) {
          process.exit(80);
        }
      } else {
        handleRawError(result, { command: 'lifecycle', operation: 'pipeline.stage.validate' });
      }
    });

  lifecycle
    .command('guidance [stage]')
    .description(
      'Get stage-aware LLM prompt guidance (Phase 2). Pi extensions shell out to this on before_agent_start.',
    )
    .option('--epicId <id>', 'Resolve stage from current epic pipeline status if no stage arg')
    .option('--format <fmt>', 'Output format: markdown | json', 'markdown')
    .action(async (stage: string | undefined, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'pipeline',
        'stage.guidance',
        {
          stage,
          epicId: opts['epicId'],
          format: opts['format'],
        },
        { command: 'lifecycle' },
      );
    });

  lifecycle
    .command('history <taskId>')
    .description('Show full lifecycle stage history for a task or epic')
    .action(async (taskId: string) => {
      await dispatchFromCli(
        'query',
        'pipeline',
        'stage.history',
        { taskId },
        { command: 'lifecycle' },
      );
    });

  lifecycle
    .command('reset <epicId> <stage>')
    .description('Reset a lifecycle stage back to pending')
    .requiredOption('--reason <reason>', 'Reason for resetting the stage')
    .action(async (epicId: string, stage: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'stage.reset',
        {
          taskId: epicId,
          stage,
          reason: opts['reason'],
        },
        { command: 'lifecycle' },
      );
    });

  const gate = lifecycle
    .command('gate-record')
    .description('Record a gate pass or fail for a lifecycle stage');

  gate
    .command('pass <epicId> <gateName>')
    .description('Record a gate as passed for a lifecycle stage')
    .option('--agent <agent>', 'Agent that performed the gate check')
    .option('--notes <notes>', 'Notes on gate outcome')
    .action(async (epicId: string, gateName: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'stage.gate.pass',
        {
          taskId: epicId,
          gateName,
          agent: opts['agent'],
          notes: opts['notes'],
        },
        { command: 'lifecycle' },
      );
    });

  gate
    .command('fail <epicId> <gateName>')
    .description('Record a gate as failed for a lifecycle stage')
    .option('--reason <reason>', 'Reason the gate failed')
    .action(async (epicId: string, gateName: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'stage.gate.fail',
        {
          taskId: epicId,
          gateName,
          reason: opts['reason'],
        },
        { command: 'lifecycle' },
      );
    });
}
