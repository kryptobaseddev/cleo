/**
 * CLI backup command - create and list backups.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { createBackup, listBackups } from '../../store/backup.js';
import { getTodoPath, getConfigPath, getArchivePath, getLogPath, getBackupDir } from '../../core/paths.js';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command('backup')
    .description('Create backup of todo files or list available backups');

  backup
    .command('create')
    .description('Create a new backup of all CLEO data files')
    .option('--destination <dir>', 'Backup destination directory')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const backupDir = (opts['destination'] as string) || getBackupDir();
        const files = [
          getTodoPath(),
          getConfigPath(),
          getArchivePath(),
          getLogPath(),
        ];

        const backed: string[] = [];
        const skipped: string[] = [];

        for (const file of files) {
          if (await fileExists(file)) {
            const path = await createBackup(file, backupDir);
            backed.push(path);
          } else {
            skipped.push(file);
          }
        }

        console.log(formatSuccess({
          created: true,
          backupDir,
          backedUp: backed.length,
          skipped: skipped.length,
          files: backed,
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  backup
    .command('list')
    .description('List available backups')
    .action(async () => {
      try {
        const backupDir = getBackupDir();
        const dataFiles = ['todo.json', 'config.json', 'todo-archive.json', 'todo-log.jsonl'];

        const allBackups: Array<{ file: string; backups: string[] }> = [];

        for (const fileName of dataFiles) {
          const backups = await listBackups(fileName, backupDir);
          if (backups.length > 0) {
            allBackups.push({ file: fileName, backups });
          }
        }

        console.log(formatSuccess({
          backupDir,
          files: allBackups,
          totalBackups: allBackups.reduce((sum, f) => sum + f.backups.length, 0),
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Default action: create backup
  backup
    .action(async () => {
      try {
        const backupDir = getBackupDir();
        const todoPath = getTodoPath();

        if (await fileExists(todoPath)) {
          const path = await createBackup(todoPath, backupDir);
          console.log(formatSuccess({
            created: true,
            backupDir,
            file: path,
          }));
        } else {
          throw new CleoError(ExitCode.NOT_FOUND, 'No todo.json to backup');
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
