/**
 * CLI relates command - task relationship management.
 * @task T4538
 * @epic T4454
 */

import type { Command } from 'commander';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the relates command group.
 * @task T4538
 */
export function registerRelatesCommand(program: Command): void {
  const relates = program
    .command('relates')
    .description('Semantic relationship discovery and management between tasks');

  relates
    .command('suggest <taskId>')
    .description('Suggest related tasks based on shared attributes')
    .option('--threshold <n>', 'Minimum similarity threshold (0-100)', '50')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const response = await dispatchRaw('query', 'tasks', 'relates.find', {
        taskId,
        mode: 'suggest',
        threshold: opts['threshold'] ? Number(opts['threshold']) : 50,
      });
      handleRawError(response, { command: 'relates', operation: 'relates.find' });
      cliOutput(response.data ?? {}, { command: 'relates' });
    });

  relates
    .command('add <from> <to> <type> <reason>')
    .description('Add a relates entry to a task')
    .action(async (from: string, to: string, type: string, reason: string) => {
      await dispatchFromCli(
        'mutate',
        'tasks',
        'relates.add',
        { taskId: from, relatedId: to, type, reason },
        { command: 'relates' },
      );
    });

  relates
    .command('discover <taskId>')
    .description('Discover related tasks using various methods')
    .action(async (taskId: string) => {
      const response = await dispatchRaw('query', 'tasks', 'relates.find', {
        taskId,
        mode: 'discover',
      });
      handleRawError(response, { command: 'relates', operation: 'relates.find' });
      cliOutput(response.data ?? {}, { command: 'relates' });
    });

  relates
    .command('list <taskId>')
    .description('Show existing relates entries for a task')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'tasks', 'relates', { taskId }, { command: 'relates' });
    });
}
