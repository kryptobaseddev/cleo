/**
 * CLI unarchive command - restore archived tasks back to todo.json.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import type { Task, TaskStatus } from '../../types/task.js';

export function registerUnarchiveCommand(program: Command): void {
  program
    .command('unarchive <task-id>')
    .description('Restore archived tasks back to todo.json')
    .option('--status <status>', 'Status to restore task as (default: pending)', 'pending')
    .option('--preserve-status', 'Keep the original task status')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const accessor = await getAccessor();
        const archiveData = await accessor.loadArchive();
        if (!archiveData) {
          throw new CleoError(ExitCode.NOT_FOUND, 'No archive file found');
        }

        const archivedTasks = archiveData.archivedTasks as Task[] | undefined;
        if (!Array.isArray(archivedTasks)) {
          throw new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid archive format');
        }

        const taskIndex = archivedTasks.findIndex((t) => t.id === taskId);
        if (taskIndex === -1) {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found in archive`, {
            fix: `ct find --id ${taskId.replace('T', '')} or check todo.json`,
          });
        }

        const task = archivedTasks[taskIndex]!;

        if (opts['dryRun']) {
          console.log(formatSuccess({
            dryRun: true,
            task: taskId,
            title: task.title,
            currentStatus: task.status,
            wouldRestoreAs: opts['preserveStatus'] ? task.status : (opts['status'] as string),
          }, 'Dry run - no changes made'));
          return;
        }

        // Load todo data
        const todoData = await accessor.loadTodoFile();

        // Check for ID collision
        if (todoData.tasks.some((t) => t.id === taskId)) {
          throw new CleoError(ExitCode.ID_COLLISION, `Task ${taskId} already exists in todo.json`);
        }

        // Set status
        if (!opts['preserveStatus']) {
          const targetStatus = (opts['status'] as string) || 'pending';
          task.status = targetStatus as TaskStatus;
          if (targetStatus !== 'done') {
            task.completedAt = undefined;
          }
        }

        task.updatedAt = new Date().toISOString();

        // Add to todo.json
        todoData.tasks.push(task);
        todoData._meta.checksum = computeChecksum(todoData.tasks);
        todoData.lastUpdated = new Date().toISOString();

        // Remove from archive
        archivedTasks.splice(taskIndex, 1);

        // Save both files
        await accessor.saveTodoFile(todoData);
        await accessor.saveArchive(archiveData);

        console.log(formatSuccess({
          task: taskId,
          unarchived: true,
          title: task.title,
          status: task.status,
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
