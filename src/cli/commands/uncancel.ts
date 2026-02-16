/**
 * CLI uncancel command - restore cancelled tasks back to pending.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { readJson, saveJson, computeChecksum } from '../../store/json.js';
import { getTodoPath, getBackupDir } from '../../core/paths.js';
import type { TodoFile } from '../../types/task.js';

export function registerUncancelCommand(program: Command): void {
  program
    .command('uncancel <task-id>')
    .description('Restore cancelled tasks back to pending status')
    .option('--cascade', 'Also restore cancelled child tasks')
    .option('--notes <note>', 'Add note about restoration')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const todoPath = getTodoPath();
        const data = await readJson<TodoFile>(todoPath);
        if (!data) {
          throw new CleoError(ExitCode.NOT_FOUND, 'No todo.json found. Run: cleo init');
        }

        const task = data.tasks.find((t) => t.id === taskId);
        if (!task) {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
            fix: `ct find --id ${taskId.replace('T', '')}`,
          });
        }

        if (task.status !== 'cancelled') {
          throw new CleoError(ExitCode.INVALID_INPUT, `Task ${taskId} is not cancelled (status: ${task.status}). Only cancelled tasks can be uncancelled.`);
        }

        // Collect tasks to uncancel (including children if cascade)
        const tasksToUncancel = [task];
        if (opts['cascade']) {
          const findCancelledChildren = (parentId: string): void => {
            const children = data.tasks.filter(
              (t) => t.parentId === parentId && t.status === 'cancelled',
            );
            for (const child of children) {
              tasksToUncancel.push(child);
              findCancelledChildren(child.id);
            }
          };
          findCancelledChildren(taskId);
        }

        if (opts['dryRun']) {
          console.log(formatSuccess({
            dryRun: true,
            task: taskId,
            wouldUncancel: tasksToUncancel.map((t) => ({
              id: t.id,
              title: t.title,
            })),
            count: tasksToUncancel.length,
          }, 'Dry run - no changes made'));
          return;
        }

        const now = new Date().toISOString();
        const note = opts['notes'] as string | undefined;
        const restored: string[] = [];

        for (const t of tasksToUncancel) {
          t.status = 'pending';
          t.cancelledAt = undefined;
          t.cancellationReason = undefined;
          t.updatedAt = now;

          if (!t.notes) t.notes = [];
          t.notes.push(`Restored from cancelled${note ? ': ' + note : ''}`);
          restored.push(t.id);
        }

        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = now;

        await saveJson(todoPath, data, { backupDir: getBackupDir() });

        console.log(formatSuccess({
          task: taskId,
          uncancelled: true,
          restored,
          count: restored.length,
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
