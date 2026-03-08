/**
 * CLI restore command - universal restoration (backup, archived, cancelled, completed tasks).
 * Delegates to dispatch operations (tasks.restore, tasks.reopen, tasks.unarchive, admin.backup.restore).
 * @task T4454
 * @task T4795
 * @task T4904
 * @task T5329
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { cliOutput } from '../renderers/index.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';

export function registerRestoreCommand(program: Command): void {
  const restoreCmd = program
    .command('restore')
    .description('Restore from backup or restore tasks from terminal states (archived, cancelled, completed)');

  // Subcommand: restore backup
  restoreCmd
    .command('backup')
    .description('Restore todo files from backup')
    .option('--file <name>', 'Specific file to restore (tasks.db, config.json, etc.)')
    .option('--dry-run', 'Preview what would be restored')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const fileName = (opts['file'] as string) || 'tasks.db';

        const response = await dispatchRaw('mutate', 'admin', 'backup', {
          action: 'restore',
          file: fileName,
          dryRun: opts['dryRun'] as boolean | undefined,
        });

        if (!response.success) {
          const code = ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
          throw new CleoError(code, response.error?.message ?? 'Backup restore failed');
        }

        const data = response.data as Record<string, unknown>;

        if (opts['dryRun']) {
          cliOutput({
            dryRun: true,
            file: fileName,
            wouldRestore: data?.from,
            targetPath: data?.targetPath,
          }, { command: 'restore', message: 'Dry run - no changes made', operation: 'admin.backup.restore' });
          return;
        }

        cliOutput({
          restored: true,
          file: fileName,
          restoredFrom: data?.from,
          targetPath: data?.targetPath,
        }, { command: 'restore', operation: 'admin.backup.restore' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Universal task restore - handles archived, cancelled, and completed tasks
  restoreCmd
    .command('task <task-id>')
    .description('Restore task from terminal state (archived, cancelled, or completed) back to active')
    .option('--status <status>', 'Status to restore task as (default: pending)', 'pending')
    .option('--preserve-status', 'Keep the original task status')
    .option('--reason <reason>', 'Reason for restoring/reopening the task')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const accessor = await getAccessor();

        // First, check if task exists in active tasks
        const data = await accessor.loadTaskFile();
        const activeTask = data.tasks.find((t) => t.id === taskId);

        if (activeTask) {
          // Task is active but might be in terminal state (cancelled, done)
          if (activeTask.status === 'cancelled') {
            if (opts['dryRun']) {
              cliOutput({
                dryRun: true,
                taskId,
                title: activeTask.title,
                previousStatus: activeTask.status,
                newStatus: opts['preserveStatus'] ? activeTask.status : (opts['status'] as string),
                source: 'active-tasks',
              }, { command: 'restore', message: 'Dry run - no changes made', operation: 'tasks.restore' });
              return;
            }
            const response = await dispatchRaw('mutate', 'tasks', 'restore', { taskId });
            if (!response.success) {
              const code = ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
              throw new CleoError(code, response.error?.message ?? 'Task restore failed');
            }
            const resultData = response.data as Record<string, unknown>;
            cliOutput({
              restored: true,
              taskId: resultData?.task,
              count: resultData?.count,
              source: 'active-tasks',
            }, { command: 'restore', operation: 'tasks.restore' });
            return;
          } else if (activeTask.status === 'done') {
            if (opts['dryRun']) {
              const newStatus = opts['preserveStatus'] ? activeTask.status : (opts['status'] as string);
              cliOutput({
                dryRun: true,
                taskId,
                title: activeTask.title,
                previousStatus: activeTask.status,
                newStatus,
                source: 'active-tasks',
              }, { command: 'restore', message: 'Dry run - no changes made', operation: 'tasks.reopen' });
              return;
            }
            const targetStatus = opts['preserveStatus'] ? undefined : (opts['status'] as string);
            const response = await dispatchRaw('mutate', 'tasks', 'reopen', {
              taskId,
              status: targetStatus,
              reason: opts['reason'] as string | undefined,
            });
            if (!response.success) {
              const code = ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
              throw new CleoError(code, response.error?.message ?? 'Task reopen failed');
            }
            const resultData = response.data as Record<string, unknown>;
            cliOutput({
              restored: true,
              taskId: resultData?.task,
              previousStatus: resultData?.previousStatus,
              newStatus: resultData?.newStatus,
              source: 'active-tasks',
            }, { command: 'restore', operation: 'tasks.reopen' });
            return;
          } else {
            throw new CleoError(ExitCode.VALIDATION_ERROR, `Task ${taskId} is already active with status: ${activeTask.status}`);
          }
        }

        // Task not in active list - check archive
        if (opts['dryRun']) {
          const archiveData = await accessor.loadArchive();
          if (archiveData) {
            const archivedTasks = archiveData.archivedTasks as Array<{ id: string; title: string; status: string }> | undefined;
            if (Array.isArray(archivedTasks)) {
              const task = archivedTasks.find((t) => t.id === taskId);
              if (task) {
                cliOutput({
                  dryRun: true,
                  taskId,
                  title: task.title,
                  previousStatus: task.status,
                  newStatus: opts['preserveStatus'] ? task.status : (opts['status'] as string),
                  source: 'archive',
                }, { command: 'restore', message: 'Dry run - no changes made', operation: 'tasks.unarchive' });
                return;
              }
            }
          }
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found in active tasks or archive`, {
            fix: `cleo find "${taskId}" to search for the task`,
          });
        }

        // Delegate to unarchive via dispatch
        try {
          const targetStatus = opts['preserveStatus'] ? undefined : (opts['status'] as string);
          const response = await dispatchRaw('mutate', 'tasks', 'unarchive', {
            taskId,
            status: targetStatus,
            preserveStatus: !!opts['preserveStatus'],
          });
          if (!response.success) {
            const code = ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
            throw new CleoError(code, response.error?.message ?? 'Task unarchive failed');
          }
          const resultData = response.data as Record<string, unknown>;
          cliOutput({
            restored: true,
            taskId: resultData?.task,
            title: resultData?.title,
            newStatus: resultData?.status,
            source: 'archive',
          }, { command: 'restore', operation: 'tasks.unarchive' });
        } catch {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found in active tasks or archive`, {
            fix: `cleo find "${taskId}" to search for the task`,
          });
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
