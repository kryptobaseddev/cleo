/**
 * CLI promote command - remove parent from task, making it root-level.
 * @task T4454
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';

export function registerPromoteCommand(program: Command): void {
  program
    .command('promote <task-id>')
    .description('Remove parent from task, making it root-level')
    .option('--no-type-update', 'Skip auto-updating type from subtask to task')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const accessor = await getAccessor();
        const data = await accessor.loadTaskFile();

        const taskIndex = data.tasks.findIndex((t) => t.id === taskId);
        if (taskIndex === -1) {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
        }

        const task = data.tasks[taskIndex]!;
        if (!task.parentId) {
          cliOutput({ task: taskId, promoted: false }, { command: 'promote', message: 'Task is already root-level' });
          process.exit(ExitCode.NO_CHANGE);
          return;
        }

        const oldParent = task.parentId;
        task.parentId = null;
        task.updatedAt = new Date().toISOString();

        // Auto-update type if was subtask
        const updateType = opts['typeUpdate'] !== false;
        let typeChanged = false;
        if (updateType && task.type === 'subtask') {
          task.type = 'task';
          typeChanged = true;
        }

        // Update checksum
        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = new Date().toISOString();

        await accessor.saveTaskFile(data);

        cliOutput({
          task: taskId,
          promoted: true,
          previousParent: oldParent,
          typeChanged,
        }, { command: 'promote' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
