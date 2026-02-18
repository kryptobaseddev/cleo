/**
 * CLI reorder command - change task position within sibling group.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import type { Task } from '../../types/task.js';

/**
 * Get siblings of a task (same parent).
 */
function getSiblings(task: Task, tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.parentId === task.parentId && t.id !== task.id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export function registerReorderCommand(program: Command): void {
  program
    .command('reorder <task-id>')
    .description('Change task position within sibling group')
    .option('--position <n>', 'Move to specific position', parseInt)
    .option('--before <id>', 'Move before specified task')
    .option('--after <id>', 'Move after specified task')
    .option('--top', 'Move to first position')
    .option('--bottom', 'Move to last position')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const accessor = await getAccessor();
        const data = await accessor.loadTodoFile();

        const task = data.tasks.find((t) => t.id === taskId);
        if (!task) {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
        }

        const siblings = getSiblings(task, data.tasks);
        const allSiblings = [task, ...siblings].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const currentIndex = allSiblings.findIndex((t) => t.id === taskId);

        let newIndex: number;

        if (opts['top']) {
          newIndex = 0;
        } else if (opts['bottom']) {
          newIndex = allSiblings.length - 1;
        } else if (opts['position'] !== undefined) {
          const pos = opts['position'] as number;
          newIndex = Math.max(0, Math.min(pos - 1, allSiblings.length - 1));
        } else if (opts['before']) {
          const beforeId = opts['before'] as string;
          const beforeIndex = allSiblings.findIndex((t) => t.id === beforeId);
          if (beforeIndex === -1) {
            throw new CleoError(ExitCode.NOT_FOUND, `Reference task ${beforeId} not found among siblings`);
          }
          newIndex = beforeIndex > currentIndex ? beforeIndex - 1 : beforeIndex;
        } else if (opts['after']) {
          const afterId = opts['after'] as string;
          const afterIndex = allSiblings.findIndex((t) => t.id === afterId);
          if (afterIndex === -1) {
            throw new CleoError(ExitCode.NOT_FOUND, `Reference task ${afterId} not found among siblings`);
          }
          newIndex = afterIndex < currentIndex ? afterIndex + 1 : afterIndex;
        } else {
          throw new CleoError(ExitCode.INVALID_INPUT, 'Must specify --position, --before, --after, --top, or --bottom');
        }

        // Remove from current position and insert at new position
        allSiblings.splice(currentIndex, 1);
        allSiblings.splice(newIndex, 0, task);

        // Update positions
        const now = new Date().toISOString();
        for (let i = 0; i < allSiblings.length; i++) {
          const sibling = data.tasks.find((t) => t.id === allSiblings[i]!.id);
          if (sibling) {
            sibling.position = i + 1;
            sibling.positionVersion = (sibling.positionVersion ?? 0) + 1;
            sibling.updatedAt = now;
          }
        }

        // Update checksum
        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = now;

        await accessor.saveTodoFile(data);

        console.log(formatSuccess({
          task: taskId,
          reordered: true,
          newPosition: newIndex + 1,
          totalSiblings: allSiblings.length,
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
