/**
 * CLI update command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { updateTask } from '../../core/tasks/update.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import type { TaskStatus, TaskPriority, TaskType, TaskSize } from '../../types/task.js';

/**
 * Register the update command.
 * @task T4461
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command('update <taskId>')
    .description('Update a task')
    .option('--title <title>', 'New title')
    .option('-s, --status <status>', 'New status')
    .option('-p, --priority <priority>', 'New priority')
    .option('-t, --type <type>', 'New type')
    .option('--size <size>', 'New size')
    .option('-P, --phase <phase>', 'New phase')
    .option('-d, --description <desc>', 'New description')
    .option('-l, --labels <labels>', 'Set labels (comma-separated)')
    .option('--add-labels <labels>', 'Add labels (comma-separated)')
    .option('--remove-labels <labels>', 'Remove labels (comma-separated)')
    .option('-D, --depends <ids>', 'Set dependencies (comma-separated)')
    .option('--add-depends <ids>', 'Add dependencies (comma-separated)')
    .option('--remove-depends <ids>', 'Remove dependencies (comma-separated)')
    .option('--notes <note>', 'Add a note')
    .option('--acceptance <criteria>', 'Set acceptance criteria (comma-separated)')
    .option('--files <files>', 'Set files (comma-separated)')
    .option('--blocked-by <reason>', 'Set blocked-by reason')
    .option('--parent <id>', 'Set parent ID')
    .option('--no-auto-complete', 'Disable auto-complete for epic')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await updateTask({
          taskId,
          title: opts['title'] as string | undefined,
          status: opts['status'] as TaskStatus | undefined,
          priority: opts['priority'] as TaskPriority | undefined,
          type: opts['type'] as TaskType | undefined,
          size: opts['size'] as TaskSize | undefined,
          phase: opts['phase'] as string | undefined,
          description: opts['description'] as string | undefined,
          labels: opts['labels'] ? (opts['labels'] as string).split(',').map(s => s.trim()) : undefined,
          addLabels: opts['addLabels'] ? (opts['addLabels'] as string).split(',').map(s => s.trim()) : undefined,
          removeLabels: opts['removeLabels'] ? (opts['removeLabels'] as string).split(',').map(s => s.trim()) : undefined,
          depends: opts['depends'] ? (opts['depends'] as string).split(',').map(s => s.trim()) : undefined,
          addDepends: opts['addDepends'] ? (opts['addDepends'] as string).split(',').map(s => s.trim()) : undefined,
          removeDepends: opts['removeDepends'] ? (opts['removeDepends'] as string).split(',').map(s => s.trim()) : undefined,
          notes: opts['notes'] as string | undefined,
          acceptance: opts['acceptance'] ? (opts['acceptance'] as string).split(',').map(s => s.trim()) : undefined,
          files: opts['files'] ? (opts['files'] as string).split(',').map(s => s.trim()) : undefined,
          blockedBy: opts['blockedBy'] as string | undefined,
          noAutoComplete: opts['autoComplete'] === false ? true : undefined,
        }, undefined, accessor);

        console.log(formatSuccess({ task: result.task, changes: result.changes }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
