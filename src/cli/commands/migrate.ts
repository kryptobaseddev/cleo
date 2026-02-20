/**
 * CLI migrate command.
 * @task T4468
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getMigrationStatus,
  runMigration,
  runAllMigrations,
} from '../../core/migration/index.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the migrate command group.
 * @task T4468
 */
export function registerMigrateCommand(program: Command): void {
  const migrate = program
    .command('migrate')
    .description('Schema migration system');

  migrate
    .command('status')
    .description('Check migration status for all data files')
    .action(async () => {
      try {
        const result = await getMigrationStatus();
        cliOutput(result, { command: 'migrate' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  migrate
    .command('run [fileType]')
    .description('Run migrations (all files if no type given)')
    .option('--dry-run', 'Preview migrations without applying')
    .action(async (fileType: string | undefined, opts: Record<string, unknown>) => {
      try {
        if (fileType) {
          const result = await runMigration(fileType, {
            dryRun: opts['dryRun'] as boolean | undefined,
          });
          cliOutput(result, { command: 'migrate' });
        } else {
          const results = await runAllMigrations({
            dryRun: opts['dryRun'] as boolean | undefined,
          });
          cliOutput({ migrations: results, count: results.length }, { command: 'migrate' });
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
