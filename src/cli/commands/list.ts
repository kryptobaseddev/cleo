/**
 * CLI list command.
 * @task T4460
 * @task T4668
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import { cliOutput, cliError } from '../renderers/index.js';
import { ExitCode } from '../../types/exit-codes.js';
import { createPage } from '../../core/pagination.js';

/**
 * Register the list command.
 * @task T4460
 * @task T4668
 */
export function registerListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List tasks with optional filters')
    .option('--status <status>', 'Filter by status')
    .option('--priority <priority>', 'Filter by priority')
    .option('--type <type>', 'Filter by type')
    .option('--parent <id>', 'Filter by parent ID')
    .option('--phase <phase>', 'Filter by phase')
    .option('--label <label>', 'Filter by label')
    .option('--children', 'Show direct children only (requires --parent)')
    .option('--limit <n>', 'Limit number of results', parseInt)
    .option('--offset <n>', 'Skip first N results', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      const limit = opts['limit'] as number | undefined;
      const offset = opts['offset'] as number | undefined;

      const params: Record<string, unknown> = {};
      if (opts['status'] !== undefined) params['status'] = opts['status'];
      if (opts['priority'] !== undefined) params['priority'] = opts['priority'];
      if (opts['type'] !== undefined) params['type'] = opts['type'];
      if (opts['parent'] !== undefined) params['parent'] = opts['parent'];
      if (opts['phase'] !== undefined) params['phase'] = opts['phase'];
      if (opts['label'] !== undefined) params['label'] = opts['label'];
      if (opts['children'] !== undefined) params['children'] = opts['children'];
      if (limit !== undefined) params['limit'] = limit;
      if (offset !== undefined) params['offset'] = offset;

      const response = await dispatchRaw('query', 'tasks', 'list', params);

      if (!response.success) {
        cliError(response.error?.message ?? 'Unknown error', response.error?.exitCode ?? 1);
        process.exit(response.error?.exitCode ?? 1);
        return;
      }

      const rawData = response.data;
      const data = (Array.isArray(rawData)
        ? { tasks: rawData, total: rawData.length }
        : rawData as Record<string, unknown>) ?? {};
      const tasks = (data?.tasks as unknown[]) ?? [];

      if (tasks.length === 0) {
        cliOutput(data, { command: 'list', message: 'No tasks found', operation: 'tasks.list' });
        process.exit(ExitCode.NO_DATA);
        return;
      }

      const total = (data?.total as number) ?? tasks.length;
      const page = createPage({ total, limit, offset });
      cliOutput(data, { command: 'list', operation: 'tasks.list', page });
    });
}
