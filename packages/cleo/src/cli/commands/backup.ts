/**
 * CLI backup command - add and list backups.
 * @task T4454
 * @task T4903
 * @task T306 — added --global flag to backup add; --scope filter to backup list (epic T299)
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command('backup')
    .description('Add backup of todo files or list available backups');

  backup
    .command('add')
    .alias('create')
    .description('Add a new backup of all CLEO data files')
    .option('--destination <dir>', 'Backup destination directory')
    .option('--global', 'Also snapshot global-tier databases (nexus.db)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'backup',
        {
          type: 'snapshot',
          note: opts['destination'] ? `destination:${opts['destination']}` : undefined,
          includeGlobal: opts['global'] === true,
        },
        { command: 'backup' },
      );
    });

  backup
    .command('list')
    .description('List available backups')
    .option(
      '--scope <scope>',
      'Filter by backup scope: project, global, or all (default: all)',
      'all',
    )
    .action(async (opts: Record<string, unknown>) => {
      const scope = (opts['scope'] as string) || 'all';
      await dispatchFromCli(
        'query',
        'admin',
        'backup',
        {
          type: 'list',
          scope,
        },
        { command: 'backup' },
      );
    });

  // Default action: add backup
  backup.action(async () => {
    await dispatchFromCli('mutate', 'admin', 'backup', {}, { command: 'backup' });
  });
}
