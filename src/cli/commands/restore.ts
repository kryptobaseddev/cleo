/**
 * CLI restore command - restore todo files from backup.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { restoreFromBackup, listBackups } from '../../store/backup.js';
import { getTodoPath, getConfigPath, getArchivePath, getBackupDir } from '../../core/paths.js';

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore')
    .description('Restore todo files from backup')
    .option('--file <name>', 'Specific file to restore (todo.json, config.json, etc.)')
    .option('--dry-run', 'Preview what would be restored')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const backupDir = getBackupDir();
        const fileName = (opts['file'] as string) || 'todo.json';

        // Map file name to target path
        const targetPathMap: Record<string, string> = {
          'todo.json': getTodoPath(),
          'config.json': getConfigPath(),
          'todo-archive.json': getArchivePath(),
        };

        const targetPath = targetPathMap[fileName];
        if (!targetPath) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Unknown file: ${fileName}. Valid: ${Object.keys(targetPathMap).join(', ')}`);
        }

        // Check available backups
        const backups = await listBackups(fileName, backupDir);
        if (backups.length === 0) {
          throw new CleoError(ExitCode.NOT_FOUND, `No backups found for ${fileName}`, {
            fix: 'cleo backup create',
          });
        }

        if (opts['dryRun']) {
          console.log(formatSuccess({
            dryRun: true,
            file: fileName,
            wouldRestore: backups[0],
            availableBackups: backups.length,
          }, 'Dry run - no changes made'));
          return;
        }

        const restoredFrom = await restoreFromBackup(fileName, backupDir, targetPath);

        console.log(formatSuccess({
          restored: true,
          file: fileName,
          restoredFrom,
          targetPath,
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
