/**
 * CLI reopen command - restore completed tasks back to pending.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import type { TaskStatus } from '../../types/task.js';

export function registerReopenCommand(program: Command): void {
  program
    .command('reopen <task-id>')
    .description('Restore completed tasks back to pending status')
    .option('--status <status>', 'Target status: pending (default) or active', 'pending')
    .option('--reason <reason>', 'Reason for reopening')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const targetStatus = (opts['status'] as string) || 'pending';
        if (targetStatus !== 'pending' && targetStatus !== 'active') {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid target status: ${targetStatus}. Must be 'pending' or 'active'`);
        }

        const accessor = await getAccessor();
        const data = await accessor.loadTodoFile();

        const taskIndex = data.tasks.findIndex((t) => t.id === taskId);
        if (taskIndex === -1) {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
            fix: `ct find --id ${taskId.replace('T', '')}`,
          });
        }

        const task = data.tasks[taskIndex]!;
        if (task.status !== 'done') {
          throw new CleoError(ExitCode.INVALID_INPUT, `Task ${taskId} is not completed (status: ${task.status}). Only done tasks can be reopened.`);
        }

        if (opts['dryRun']) {
          console.log(formatSuccess({
            dryRun: true,
            task: taskId,
            currentStatus: task.status,
            targetStatus,
            wouldReopen: true,
          }, 'Dry run - no changes made'));
          return;
        }

        const previousStatus = task.status;
        task.status = targetStatus as TaskStatus;
        task.completedAt = undefined;
        task.updatedAt = new Date().toISOString();

        // Add note about reopening
        const reason = opts['reason'] as string | undefined;
        const note = `Reopened from ${previousStatus}${reason ? ': ' + reason : ''}`;
        if (!task.notes) task.notes = [];
        task.notes.push(note);

        // Update checksum
        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = new Date().toISOString();

        await accessor.saveTodoFile(data);

        console.log(formatSuccess({
          task: taskId,
          reopened: true,
          previousStatus,
          newStatus: targetStatus,
          reason: reason ?? null,
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
