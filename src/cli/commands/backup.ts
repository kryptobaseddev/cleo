/**
 * CLI backup command - add and list backups.
 * @task T4454
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { createBackup, listBackups } from '../../store/backup.js';
import { getTaskPath, getConfigPath, getArchivePath, getLogPath, getBackupDir } from '../../core/paths.js';
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
    .description('Add backup of todo files or list available backups');

  backup
    .command('add')
    .alias('create')
    .description('Add a new backup of all CLEO data files')
    .option('--destination <dir>', 'Backup destination directory')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const backupDir = (opts['destination'] as string) || getBackupDir();
        const files = [
          getTaskPath(),
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

        cliOutput({
          created: true,
          backupDir,
          backedUp: backed.length,
          skipped: skipped.length,
          files: backed,
        }, { command: 'backup' });
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
        const dataFiles = ['tasks.json', 'config.json', 'tasks-archive.json', 'tasks-log.jsonl'];

        const allBackups: Array<{ file: string; backups: string[] }> = [];

        for (const fileName of dataFiles) {
          const backups = await listBackups(fileName, backupDir);
          if (backups.length > 0) {
            allBackups.push({ file: fileName, backups });
          }
        }

        cliOutput({
          backupDir,
          files: allBackups,
          totalBackups: allBackups.reduce((sum, f) => sum + f.backups.length, 0),
        }, { command: 'backup' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Default action: add backup
  backup
    .action(async () => {
      try {
        const backupDir = getBackupDir();
        const todoPath = getTaskPath();

        if (await fileExists(todoPath)) {
          const path = await createBackup(todoPath, backupDir);
          cliOutput({
            created: true,
            backupDir,
            file: path,
          }, { command: 'backup' });
        } else {
          throw new CleoError(ExitCode.NOT_FOUND, 'No tasks.json to backup');
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
