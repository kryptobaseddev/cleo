/**
 * CLI export-tasks command - export tasks to portable package for cross-project transfer.
 * Thin dispatch wrapper routing to admin.export.tasks.
 *
 * @task T4551, T5323, T5328
 * @epic T4545
 */

import { Command } from 'commander';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

export function registerExportTasksCommand(program: Command): void {
  program
    .command('export-tasks [taskIds...]')
    .description('Export tasks to portable .cleo-export.json package for cross-project transfer')
    .option('-o, --output <file>', 'Output file path (stdout if omitted)')
    .option('--subtree', 'Include all descendants of specified task(s)')
    .option('--filter <filters...>', 'Filter tasks by criteria (key=value, repeatable)')
    .option('--include-deps', 'Auto-include task dependencies')
    .option('--dry-run', 'Preview selection without creating export file')
    .action(async (taskIds: string[], opts: Record<string, unknown>) => {
      const hasOutput = !!opts['output'];

      const params = {
        taskIds: taskIds.length > 0 ? taskIds : undefined,
        output: opts['output'],
        subtree: opts['subtree'],
        filter: opts['filter'],
        includeDeps: opts['includeDeps'],
        dryRun: opts['dryRun'],
      };

      if (hasOutput || opts['dryRun']) {
        await dispatchFromCli('query', 'admin', 'export.tasks', params, { command: 'export-tasks' });
      } else {
        // No output file — write content directly to stdout for piping
        const response = await dispatchRaw('query', 'admin', 'export.tasks', params);
        handleRawError(response, { command: 'export-tasks', operation: 'admin.export.tasks' });
        const data = response.data as { content?: string } | undefined;
        if (data?.content) {
          process.stdout.write(data.content);
          if (!data.content.endsWith('\n')) process.stdout.write('\n');
        }
      }
    });
}
