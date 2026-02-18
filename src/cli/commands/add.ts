/**
 * CLI add command.
 * @task T4460
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { addTask } from '../../core/tasks/add.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import type { TaskStatus, TaskPriority, TaskType, TaskSize } from '../../types/task.js';

/**
 * Register the add command.
 * @task T4460
 */
export function registerAddCommand(program: Command): void {
  program
    .command('add <title>')
    .description('Create a new task')
    .option('-s, --status <status>', 'Task status (pending|active|blocked|done)')
    .option('-p, --priority <priority>', 'Priority: low, medium, high, critical')
    .option('-t, --type <type>', 'Task type: epic, task, subtask')
    .option('--parent <id>', 'Parent task ID')
    .option('--size <size>', 'Scope size: small, medium, large')
    .option('-P, --phase <phase>', 'Phase slug')
    .option('--add-phase', 'Create new phase if it does not exist')
    .option('-d, --description <desc>', 'Task description')
    .option('-l, --labels <labels>', 'Comma-separated labels')
    .option('--files <files>', 'Comma-separated file paths')
    .option('--acceptance <criteria>', 'Comma-separated acceptance criteria')
    .option('-D, --depends <ids>', 'Comma-separated dependency IDs')
    .option('--notes <note>', 'Initial note entry')
    .option('--position <pos>', 'Position within sibling group', parseInt)
    .option('--dry-run', 'Show what would be created without making changes')
    .option('--json', 'Output in JSON format (default)')
    .action(async (title: string, opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await addTask({
          title,
          status: opts['status'] as TaskStatus | undefined,
          priority: opts['priority'] as TaskPriority | undefined,
          type: opts['type'] as TaskType | undefined,
          parentId: opts['parent'] as string | undefined,
          size: opts['size'] as TaskSize | undefined,
          phase: opts['phase'] as string | undefined,
          addPhase: opts['addPhase'] as boolean | undefined,
          description: opts['description'] as string | undefined,
          labels: opts['labels'] ? (opts['labels'] as string).split(',').map(s => s.trim()) : undefined,
          files: opts['files'] ? (opts['files'] as string).split(',').map(s => s.trim()) : undefined,
          acceptance: opts['acceptance'] ? (opts['acceptance'] as string).split(',').map(s => s.trim()) : undefined,
          depends: opts['depends'] ? (opts['depends'] as string).split(',').map(s => s.trim()) : undefined,
          notes: opts['notes'] as string | undefined,
          position: opts['position'] as number | undefined,
          dryRun: opts['dryRun'] as boolean | undefined,
        }, undefined, accessor);

        if (result.duplicate) {
          console.log(formatSuccess(
            { task: result.task, duplicate: true },
            `Task with identical title was created recently`,
          ));
        } else if (result.dryRun) {
          console.log(formatSuccess(
            { wouldCreate: result.task, dryRun: true },
            'Dry run - no changes made',
          ));
        } else {
          console.log(formatSuccess({ task: result.task }));
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
