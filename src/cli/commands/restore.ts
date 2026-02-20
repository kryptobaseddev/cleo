/**
 * CLI restore command - universal restoration (backup, archived, cancelled, completed tasks).
 * @task T4454
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { cliOutput } from '../renderers/index.js';
import { ExitCode } from '../../types/exit-codes.js';
import { restoreFromBackup, listBackups } from '../../store/backup.js';
import { getTaskPath, getConfigPath, getArchivePath, getBackupDir } from '../../core/paths.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import type { Task, TaskStatus } from '../../types/task.js';

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

        const accessor = await getAccessor();
        
        // First, check if task exists in active tasks
        const data = await accessor.loadTaskFile();
        const activeTask = data.tasks.find((t) => t.id === taskId);
        
        if (activeTask) {
          // Task is active but might be in terminal state (cancelled, done)
          if (activeTask.status === 'cancelled' || activeTask.status === 'done') {
            // Update status back to pending/active
            const newStatus: TaskStatus = opts['preserveStatus'] 
              ? activeTask.status 
              : (opts['status'] as TaskStatus) || 'pending';
            
            if (opts['dryRun']) {
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

            // Update the task
            const updatedTask: Task = {
              ...activeTask,
              status: newStatus,
              updatedAt: new Date().toISOString(),
            };

            const taskIndex = data.tasks.findIndex((t) => t.id === taskId);
            data.tasks[taskIndex] = updatedTask;
            data._meta.checksum = computeChecksum(data.tasks);
            data.lastUpdated = new Date().toISOString();
            await accessor.saveTaskFile(data);

            cliOutput({
              restored: true,
              taskId,
              title: activeTask.title,
              previousStatus: activeTask.status,
              newStatus,
              source: 'active-tasks',
            }, { command: 'restore', operation: 'tasks.restore' });
            return;
          } else {
            throw new CleoError(ExitCode.VALIDATION_ERROR, `Task ${taskId} is already active with status: ${activeTask.status}`);
          }
        }
        
        // Task not in active list - check archive
        const archiveData = await accessor.loadArchive();
        if (archiveData) {
          const archivedTasks = archiveData.archivedTasks as Task[] | undefined;
          if (Array.isArray(archivedTasks)) {
            const taskIndex = archivedTasks.findIndex((t) => t.id === taskId);
            if (taskIndex !== -1) {
              const task = archivedTasks[taskIndex]!;
              
              if (opts['dryRun']) {
                cliOutput({
                  dryRun: true,
                  taskId,
                  title: task.title,
                  previousStatus: task.status,
                  newStatus: opts['preserveStatus'] ? task.status : (opts['status'] as TaskStatus),
                  source: 'archive',
                }, { command: 'restore', message: 'Dry run - no changes made', operation: 'tasks.restore' });
                return;
              }

              // Determine new status
              let newStatus: TaskStatus;
              if (opts['preserveStatus']) {
                newStatus = task.status;
              } else {
                newStatus = (opts['status'] as TaskStatus) || 'pending';
              }

              // Update task - remove archive-specific fields
              const { archivedAt, archiveReason, ...restoredTaskBase } = task as Task & { archivedAt?: string; archiveReason?: string };
              const restoredTask: Task = {
                ...restoredTaskBase,
                status: newStatus,
                updatedAt: new Date().toISOString(),
              };

              // Add to tasks
              data.tasks.push(restoredTask);
              data._meta.checksum = computeChecksum(data.tasks);
              data.lastUpdated = new Date().toISOString();

              // Remove from archive
              archivedTasks.splice(taskIndex, 1);

              // Save both files
              await accessor.saveTaskFile(data);
              await accessor.saveArchive(archiveData);

              cliOutput({
                restored: true,
                taskId,
                title: task.title,
                previousStatus: task.status,
                newStatus,
                source: 'archive',
                archiveRemaining: archivedTasks.length,
              }, { command: 'restore', operation: 'tasks.restore' });
              return;
            }
          }
        }

        // Task not found anywhere
        throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found in active tasks or archive`, {
          fix: `cleo find "${taskId}" to search for the task`,
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
