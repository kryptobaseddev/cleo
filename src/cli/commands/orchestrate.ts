/**
 * CLI orchestrate command group.
 * @task T4466
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerOrchestrateCommand(program: Command): void {
  const orch = program
    .command('orchestrate')
    .description('Multi-agent orchestration commands');

  orch
    .command('start <epicId>')
    .description('Start orchestrator session for an epic')
    .action(async (epicId: string) => {
      await dispatchFromCli('mutate', 'orchestrate', 'start', { epicId }, { command: 'orchestrate' });
    });

  orch
    .command('analyze <epicId>')
    .description('Analyze epic dependency structure')
    .action(async (epicId: string) => {
      await dispatchFromCli('query', 'orchestrate', 'analyze', { epicId }, { command: 'orchestrate' });
    });

  orch
    .command('ready <epicId>')
    .description('Get parallel-safe ready tasks')
    .action(async (epicId: string) => {
      await dispatchFromCli('query', 'orchestrate', 'ready', { epicId }, { command: 'orchestrate' });
    });

  orch
    .command('next <epicId>')
    .description('Get next task to spawn')
    .action(async (epicId: string) => {
      await dispatchFromCli('query', 'orchestrate', 'next', { epicId }, { command: 'orchestrate' });
    });

  orch
    .command('spawn <taskId>')
    .description('Prepare spawn context for a subagent')
    .action(async (taskId: string) => {
      await dispatchFromCli('mutate', 'orchestrate', 'spawn', { taskId }, { command: 'orchestrate' });
    });

  orch
    .command('validate <taskId>')
    .description('Validate subagent output')
    .option('--file <path>', 'Output file path')
    .option('--manifest', 'Manifest entry was appended')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'orchestrate', 'validate', {
        taskId, file: opts['file'], manifestEntry: opts['manifest'],
      }, { command: 'orchestrate' });
    });

  orch
    .command('context <epicId>')
    .description('Get orchestrator context summary')
    .action(async (epicId: string) => {
      await dispatchFromCli('query', 'orchestrate', 'context', { epicId }, { command: 'orchestrate' });
    });
}
