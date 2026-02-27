/**
 * CLI delete command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the delete command.
 * @task T4461
 */
export function registerDeleteCommand(program: Command): void {
  program
    .command('delete <taskId>')
    .alias('rm')
    .description('Delete a task (soft delete to archive)')
    .option('--force', 'Force delete even with dependents or children')
    .option('--cascade', 'Delete children recursively')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const response = await dispatchRaw('mutate', 'tasks', 'delete', {
        taskId,
        force: opts['force'] as boolean | undefined,
        cascade: opts['cascade'] as boolean | undefined,
      });

      if (!response.success) {
        handleRawError(response, { command: 'delete', operation: 'tasks.delete' });
      }

      const data = response.data as Record<string, unknown>;
      const output: Record<string, unknown> = { deletedTask: data?.deletedTask };
      if ((data?.cascadeDeleted as unknown[] | undefined)?.length) {
        output['cascadeDeleted'] = data['cascadeDeleted'];
      }

      cliOutput(output, { command: 'delete', operation: 'tasks.delete' });
    });
}
