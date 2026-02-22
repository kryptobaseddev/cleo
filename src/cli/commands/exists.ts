/**
 * CLI exists command - check if a task ID exists.
 * @task T4454
 */

import { Command } from 'commander';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import { cliOutput, cliError } from '../renderers/index.js';
import { ExitCode } from '../../types/exit-codes.js';

export function registerExistsCommand(program: Command): void {
  program
    .command('exists <task-id>')
    .description('Check if a task ID exists (exit 0=exists, 4=not found)')
    .option('--include-archive', 'Search archive file too')
    .option('--verbose', 'Show which file contains the task')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const response = await dispatchRaw('query', 'tasks', 'exists', {
        taskId,
        includeArchive: opts['includeArchive'] as boolean | undefined,
        verbose: opts['verbose'] as boolean | undefined,
      });

      if (!response.success) {
        cliError(response.error?.message ?? 'Unknown error', response.error?.exitCode ?? 1);
        process.exit(response.error?.exitCode ?? 1);
        return;
      }

      const data = response.data as Record<string, unknown>;

      if (data?.exists) {
        cliOutput(data, { command: 'exists' });
      } else {
        cliOutput(data, { command: 'exists' });
        process.exit(ExitCode.NOT_FOUND);
      }
    });
}
