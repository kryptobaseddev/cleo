/**
 * CLI restore command - universal restoration (backup, archived, cancelled, completed tasks).
 * Delegates task restoration to core functions.
 * @task T4454
 * @task T4795
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { cliOutput } from '../renderers/index.js';
import { ExitCode } from '../../types/exit-codes.js';
import { restoreFromBackup, listBackups } from '../../store/backup.js';
import { getTaskPath, getConfigPath, getArchivePath, getBackupDir, getProjectRoot } from '../../core/paths.js';
import { getAccessor } from '../../store/data-accessor.js';
import { coreTaskRestore, coreTaskReopen, coreTaskUnarchive } from '../../core/tasks/task-ops.js';

export function registerRestoreCommand(program: Command): void {
  const restoreCmd = program
    .command('restore')
    .description('Restore from backup or restore tasks from terminal states (archived, cancelled, completed)');

  // Subcommand: restore backup
  restoreCmd
    .command('backup')
    .description('Restore todo files from backup')
    .option('--file <name>', 'Specific file to restore (tasks.json, config.json, etc.)')
    .option('--dry-run', 'Preview what would be restored')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const backupDir = getBackupDir();
        const fileName = (opts['file'] as string) || 'tasks.json';

        // Map file name to target path
        const targetPathMap: Record<string, string> = {
          'tasks.json': getTaskPath(),
          'config.json': getConfigPath(),
          'tasks-archive.json': getArchivePath(),
        };

        const targetPath = targetPathMap[fileName];
        if (!targetPath) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Unknown file: ${fileName}. Valid: ${Object.keys(targetPathMap).join(', ')}`);
        }

        // Check available backups
        const backups = await listBackups(fileName, backupDir);
        if (backups.length === 0) {
          throw new CleoError(ExitCode.NOT_FOUND, `No backups found for ${fileName}`, {
            fix: 'cleo backup add',
          });
        }

        if (opts['dryRun']) {
          cliOutput({
            dryRun: true,
            file: fileName,
            wouldRestore: backups[0],
            availableBackups: backups.length,
          }, { command: 'restore', message: 'Dry run - no changes made', operation: 'restore.backup' });
          return;
        }

        const restoredFrom = await restoreFromBackup(fileName, backupDir, targetPath);

        cliOutput({
          restored: true,
          file: fileName,
          restoredFrom,
          targetPath,
        }, { command: 'restore', operation: 'restore.backup' });
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
    .alias('unarchive')
    .alias('reopen')
    .alias('uncancel')
    .description('Restore task from terminal state (archived, cancelled, or completed) back to active')
    .option('--status <status>', 'Status to restore task as (default: pending)', 'pending')
    .option('--preserve-status', 'Keep the original task status')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const projectRoot = getProjectRoot();
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
            const result = await coreTaskRestore(projectRoot, taskId);
            cliOutput({
              restored: true,
              taskId: result.task,
              count: result.count,
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
              }, { command: 'restore', message: 'Dry run - no changes made', operation: 'tasks.restore' });
              return;
            }
            const targetStatus = opts['preserveStatus'] ? undefined : (opts['status'] as string);
            const result = await coreTaskReopen(projectRoot, taskId, {
              status: targetStatus,
            });
            cliOutput({
              restored: true,
              taskId: result.task,
              previousStatus: result.previousStatus,
              newStatus: result.newStatus,
              source: 'active-tasks',
            }, { command: 'restore', operation: 'tasks.restore' });
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
                }, { command: 'restore', message: 'Dry run - no changes made', operation: 'tasks.restore' });
                return;
              }
            }
          }
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found in active tasks or archive`, {
            fix: `cleo find "${taskId}" to search for the task`,
          });
        }

        // Delegate to core unarchive
        try {
          const targetStatus = opts['preserveStatus'] ? undefined : (opts['status'] as string);
          const result = await coreTaskUnarchive(projectRoot, taskId, {
            status: targetStatus,
            preserveStatus: !!opts['preserveStatus'],
          });
          cliOutput({
            restored: true,
            taskId: result.task,
            title: result.title,
            newStatus: result.status,
            source: 'archive',
          }, { command: 'restore', operation: 'tasks.restore' });
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
