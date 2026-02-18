/**
 * CLI list command.
 * @task T4460
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { listTasks } from '../../core/tasks/list.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TaskStatus, TaskPriority, TaskType } from '../../types/task.js';

/**
 * Register the list command.
 * @task T4460
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
      try {
        const accessor = await getAccessor();
        const result = await listTasks({
          status: opts['status'] as TaskStatus | undefined,
          priority: opts['priority'] as TaskPriority | undefined,
          type: opts['type'] as TaskType | undefined,
          parentId: opts['parent'] as string | undefined,
          phase: opts['phase'] as string | undefined,
          label: opts['label'] as string | undefined,
          children: opts['children'] as boolean | undefined,
          limit: opts['limit'] as number | undefined,
          offset: opts['offset'] as number | undefined,
        }, undefined, accessor);

        if (result.tasks.length === 0) {
          console.log(formatSuccess(result, 'No tasks found'));
          process.exit(ExitCode.NO_DATA);
        }

        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
