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
 * Global output flags (--json, --human, --quiet) are declared in args so
 * citty parses them directly. This replaces the Commander.js optsWithGlobals()
 * pattern that is unavailable in native citty commands.
 *
 * @task T4699
 * @task T5243
 * @task T131
 * @epic T4454
 */

import { CleoError, diagnoseUpgrade, formatError, runUpgrade } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { createUpgradeProgress } from '../progress.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Upgrade command — unified project maintenance (storage migration, schema repair, structural fixes).
 */
export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description:
      'Unified project maintenance (storage migration, schema repair, structural fixes, doc refresh)',
  },
  args: {
    status: {
      type: 'boolean',
      description: 'Show what needs updating without making changes',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview changes without applying',
    },
    diagnose: {
      type: 'boolean',
      description: 'Deep inspection of schema, columns, and migration journals',
    },
    'include-global': {
      type: 'boolean',
      description: 'Also check global ~/.cleo data',
    },
    'no-auto-migrate': {
      type: 'boolean',
      description: 'Skip automatic JSON->SQLite migration',
    },
    detect: {
      type: 'boolean',
      description: 'Force re-detection of project type (ignores staleness)',
    },
    'map-codebase': {
      type: 'boolean',
      description: 'Run full codebase analysis and store findings to brain.db',
    },
    name: {
      type: 'string',
      description: 'Update project name in project-info and nexus registry',
    },
    // Global output format flags — read directly from args (no optsWithGlobals in citty)
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
    human: {
      type: 'boolean',
      description: 'Force human-readable output',
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress non-essential output',
    },
  },
  async run({ args }) {
    const isHuman = args.human === true || (!!process.stdout.isTTY && args.json !== true);
    const progress = createUpgradeProgress(isHuman);

    try {
      if (args.diagnose) {
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

      const isDryRun = !!args['dry-run'] || !!args.status;
      const includeGlobal = !!args['include-global'];
      const autoMigrate = args['no-auto-migrate'] !== true;
      const forceDetect = !!args.detect;
      const mapCodebase = !!args['map-codebase'];
      const projectName = args.name as string | undefined;

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
  },
});
