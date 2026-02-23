/**
 * CLI find command.
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
 * Register the find command.
 * @task T4460
 * @task T4668
 */
export function registerFindCommand(program: Command): void {
  program
    .command('find [query]')
    .alias('search')
    .description('Fuzzy search tasks by title/description')
    .option('--id <id>', 'Search by ID prefix')
    .option('--exact', 'Exact title match')
    .option('--status <status>', 'Filter by status')
    .option('--field <field>', 'Field to search in')
    .option('--include-archive', 'Include archived tasks')
    .option('--limit <n>', 'Max results (default: 20)', parseInt)
    .option('--offset <n>', 'Skip first N results', parseInt)
    .action(async (query: string | undefined, opts: Record<string, unknown>) => {
      const limit = opts['limit'] as number | undefined;
      const offset = opts['offset'] as number | undefined;

      const params: Record<string, unknown> = {};
      if (query !== undefined) params['query'] = query;
      if (opts['id'] !== undefined) params['id'] = opts['id'];
      if (opts['exact'] !== undefined) params['exact'] = opts['exact'];
      if (opts['status'] !== undefined) params['status'] = opts['status'];
      if (opts['field'] !== undefined) params['field'] = opts['field'];
      if (opts['includeArchive'] !== undefined) params['includeArchive'] = opts['includeArchive'];
      if (limit !== undefined) params['limit'] = limit;
      if (offset !== undefined) params['offset'] = offset;

      const response = await dispatchRaw('query', 'tasks', 'find', params);

      if (!response.success) {
        cliError(response.error?.message ?? 'Unknown error', response.error?.exitCode ?? 1);
        process.exit(response.error?.exitCode ?? 1);
        return;
      }

      const rawData = response.data;
      const data = (Array.isArray(rawData)
        ? { results: rawData, total: rawData.length }
        : rawData as Record<string, unknown>) ?? {};
      const results = (data?.results as unknown[]) ?? [];

      if (results.length === 0) {
        cliOutput(data, { command: 'find', message: 'No matching tasks found', operation: 'tasks.find' });
        process.exit(ExitCode.NO_DATA);
        return;
      }

      const total = (data?.total as number) ?? results.length;
      const page = createPage({ total, limit, offset });
      cliOutput(data, { command: 'find', operation: 'tasks.find', page });
    });
}
