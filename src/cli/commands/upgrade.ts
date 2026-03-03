/**
 * CLI upgrade command - unified project maintenance.
 *
 * Delegates to core upgrade logic. Handles:
 *   - Storage migration (JSON → SQLite, automatic)
 *   - Schema version upgrades
 *   - Structural repairs (checksums, missing fields)
 *   - Global ~/.cleo data checks
 *
 * @task T4699
 * @task T5243
 * @epic T4454
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { runUpgrade } from '../../core/upgrade.js';
import { createUpgradeProgress } from '../progress.js';

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Unified project maintenance (storage migration, schema repair, structural fixes)')
    .option('--status', 'Show what needs updating without making changes')
    .option('--dry-run', 'Preview changes without applying')
    .option('--include-global', 'Also check global ~/.cleo data')
    .option('--no-auto-migrate', 'Skip automatic JSON→SQLite migration')
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      const opts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
      const isHuman = opts['human'] === true || (!!process.stdout.isTTY && opts['json'] !== true);
      const progress = createUpgradeProgress(isHuman);
      
      try {
        const isDryRun = !!opts['dryRun'] || !!opts['status'];
        const includeGlobal = !!opts['includeGlobal'];
        const autoMigrate = opts['autoMigrate'] !== false;

        progress.start();
        progress.step(0, 'Analyzing current state');
        
        if (includeGlobal) {
          progress.step(1, 'Checking global ~/.cleo data');
        } else {
          progress.step(1, 'Checking storage migration needs');
        }

        progress.step(2, 'Validating schemas');
        progress.step(3, isDryRun ? 'Previewing changes' : 'Applying fixes');

        const result = await runUpgrade({
          dryRun: isDryRun,
          includeGlobal,
          autoMigrate,
        });

        progress.step(4, 'Verifying results');

        cliOutput({
          upToDate: result.upToDate,
          dryRun: result.dryRun,
          actions: result.actions,
          applied: result.applied,
          errors: result.errors.length > 0 ? result.errors : undefined,
          storageMigration: result.storageMigration,
        }, { command: 'upgrade' });

        if (!result.success) {
          progress.error('Upgrade failed with errors');
          process.exit(1);
        }
        
        progress.complete(isDryRun ? 'Preview complete' : 'Upgrade complete');
      } catch (err) {
        if (err instanceof CleoError) {
          progress.error(err.message);
          console.error(formatError(err));
          process.exit(err.code);
        }
        progress.error('Unexpected error during upgrade');
        throw err;
      }
    });
}
