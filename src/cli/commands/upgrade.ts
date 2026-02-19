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
 * @epic T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { runUpgrade } from '../../core/upgrade.js';

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Unified project maintenance (storage migration, schema repair, structural fixes)')
    .option('--status', 'Show what needs updating without making changes')
    .option('--dry-run', 'Preview changes without applying')
    .option('--include-global', 'Also check global ~/.cleo data')
    .option('--no-auto-migrate', 'Skip automatic JSON→SQLite migration')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const isDryRun = !!opts['dryRun'] || !!opts['status'];
        const includeGlobal = !!opts['includeGlobal'];
        const autoMigrate = opts['autoMigrate'] !== false;

        const result = await runUpgrade({
          dryRun: isDryRun,
          includeGlobal,
          autoMigrate,
        });

        console.log(formatSuccess({
          upToDate: result.upToDate,
          dryRun: result.dryRun,
          actions: result.actions,
          applied: result.applied,
          errors: result.errors.length > 0 ? result.errors : undefined,
          storageMigration: result.storageMigration,
        }));

        if (result.applied > 0) {
          process.exit(2); // exit 2 = changes applied (per bash convention)
        }

        if (!result.success) {
          process.exit(1);
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
