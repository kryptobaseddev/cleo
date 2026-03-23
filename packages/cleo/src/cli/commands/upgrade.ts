/**
 * CLI upgrade command - unified project maintenance.
 *
 * Delegates to core upgrade logic. Handles:
 *   - Storage migration (JSON -> SQLite, automatic)
 *   - Schema version upgrades
 *   - Structural repairs (checksums, missing fields)
 *   - Global ~/.cleo data checks
 *   - Deep diagnostics via --diagnose
 *
 * @task T4699
 * @task T5243
 * @task T131
 * @epic T4454
 */

import { CleoError, diagnoseUpgrade, formatError, runUpgrade } from '@cleocode/core/internal';
import type { ShimCommand as Command } from '../commander-shim.js';
import { createUpgradeProgress } from '../progress.js';
import { cliOutput } from '../renderers/index.js';

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description(
      'Unified project maintenance (storage migration, schema repair, structural fixes, doc refresh)',
    )
    .option('--status', 'Show what needs updating without making changes')
    .option('--dry-run', 'Preview changes without applying')
    .option('--diagnose', 'Deep inspection of schema, columns, and migration journals')
    .option('--include-global', 'Also check global ~/.cleo data')
    .option('--no-auto-migrate', 'Skip automatic JSON->SQLite migration')
    .option('--detect', 'Force re-detection of project type (ignores staleness)')
    .option('--map-codebase', 'Run full codebase analysis and store findings to brain.db')
    .option('--name <name>', 'Update project name in project-info and nexus registry')
    .action(async (opts: Record<string, unknown>, command: Command) => {
      // Merge citty-parsed opts with global flags (--json, --human, etc.)
      const globalOpts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
      const mergedOpts = { ...globalOpts, ...opts };
      const isHuman =
        mergedOpts['human'] === true || (!!process.stdout.isTTY && mergedOpts['json'] !== true);
      const progress = createUpgradeProgress(isHuman);

      try {
        // --diagnose: deep read-only inspection
        if (mergedOpts['diagnose']) {
          progress.start();
          progress.step(0, 'Running deep schema/migration diagnostics');

          const result = await diagnoseUpgrade();

          progress.step(4, 'Diagnostics complete');

          cliOutput(result, { command: 'upgrade', operation: 'upgrade.diagnose' });

          if (!result.success) {
            progress.error(`${result.summary.errors} error(s) found`);
            process.exit(1);
          }

          progress.complete(
            `Diagnostics complete: ${result.summary.ok} ok, ${result.summary.warnings} warning(s), ${result.summary.errors} error(s)`,
          );
          return;
        }

        const isDryRun = !!mergedOpts['dryRun'] || !!mergedOpts['status'];
        const includeGlobal = !!mergedOpts['includeGlobal'];
        const autoMigrate = mergedOpts['autoMigrate'] !== false;
        const forceDetect = !!mergedOpts['detect'];
        const mapCodebase = !!mergedOpts['mapCodebase'];
        const projectName = mergedOpts['name'] as string | undefined;

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
          forceDetect,
          mapCodebase,
          projectName,
        });

        progress.step(4, 'Verifying results');

        cliOutput(
          {
            upToDate: result.upToDate,
            dryRun: result.dryRun,
            actions: result.actions,
            applied: result.applied,
            errors: result.errors.length > 0 ? result.errors : undefined,
            summary: result.summary,
            storageMigration: result.storageMigration,
          },
          { command: 'upgrade' },
        );

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
