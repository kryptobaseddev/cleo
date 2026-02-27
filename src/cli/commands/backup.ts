/**
 * CLI backup command - add and list backups.
 * @task T4454
 * @task T4903
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
      await dispatchFromCli('mutate', 'admin', 'backup', {
        type: 'snapshot',
        note: opts['destination'] ? `destination:${opts['destination']}` : undefined,
      }, { command: 'backup' });
    });

  backup
    .command('list')
    .description('List available backups')
    .action(async () => {
      await dispatchFromCli('mutate', 'admin', 'backup', {
        type: 'list',
      }, { command: 'backup' });
    });

  // Default action: add backup
  backup
    .action(async () => {
      await dispatchFromCli('mutate', 'admin', 'backup', {}, { command: 'backup' });
    });
}
