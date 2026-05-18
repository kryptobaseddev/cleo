/**
 * CLI `cleo upgrade` command — unified PROJECT maintenance.
 *
 * Not to be confused with:
 *   - `cleo update <taskId>` (see update.ts) — edit a task's fields
 *   - `cleo self-update` (see self-update.ts) — upgrade the CLI binary via npm
 *
 * This command repairs the CURRENT project's `.cleo/` state in place.
 * It does NOT fetch a new CLI version — only `cleo self-update` does that.
 *
 * Delegates to core upgrade logic. Handles:
 *   - Storage migration (JSON -> SQLite, automatic)
 *   - Schema version upgrades
 *   - Structural repairs (checksums, missing fields)
 *   - Global `{cleoHome}` data checks (via --include-global)
 *   - Deep diagnostics via --diagnose
 *
 * Subcommands:
 *   - `cleo upgrade workflows` (T9536) — re-render the four shipped
 *     `release-*.yml` workflow templates and report drift against the
 *     project's `.github/workflows/` directory. Supports `--dry-run`,
 *     `--check` (exit-code contract), and `--force` (overwrite drift).
 *
 * Global output flags (--json, --human, --quiet) are declared in args so
 * citty parses them directly. This replaces the Commander.js optsWithGlobals()
 * pattern that is unavailable in native citty commands.
 *
 * @task T4699
 * @task T5243
 * @task T131
 * @task T9536 — `workflows` subcommand
 * @epic T4454
 */

import { resolve } from 'node:path';
import { CleoError, diagnoseUpgrade, runUpgrade, upgradeWorkflows } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { createUpgradeProgress } from '../progress.js';
import { cliError, cliOutput } from '../renderers/index.js';
import { getWorkflowTemplatesDir } from './init.js';

/**
 * `cleo upgrade workflows` — Phase 4 / 4 of T9497.
 *
 * Re-renders the four shipped `*.yml.tmpl` workflow templates against
 * the project's current `.cleo/release-config.json` + ADR-061 tool
 * state, compares against the on-disk `.github/workflows/release-*.yml`
 * files, and reports per-template drift.
 *
 * Flags:
 *   - `--dry-run`  Print the per-template diff/status without writing.
 *   - `--check`    Exit 0 if every file is current (`unchanged` or
 *                  `override-kept`); exit 1 if ANY drift is detected.
 *                  Implies `--dry-run` semantics for the on-disk state.
 *   - `--force`    Overwrite drifted files with the rendered output.
 *                  Files with a key in `.workflow-overrides.yml` are
 *                  STILL preserved (operator-declared customization).
 *                  Audit row lands in `.cleo/audit/upgrade-workflows.jsonl`.
 *
 * Exit codes:
 *   - 0   every outcome was `unchanged` / `override-kept` / `updated` /
 *         `dry-run` (i.e. no actionable drift remains).
 *   - 1   at least one outcome reports `drift-detected` or `missing`
 *         and `--force` was NOT supplied.
 *
 * @task T9536
 */
const workflowsSubcommand = defineCommand({
  meta: {
    name: 'workflows',
    description: 'Re-render the four release-pipeline workflow templates and report drift (T9536).',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Print the per-template diff without writing.',
      default: false,
    },
    check: {
      type: 'boolean',
      description: 'Exit 1 if drift is detected. Implies --dry-run for write semantics.',
      default: false,
    },
    force: {
      type: 'boolean',
      description: 'Overwrite drifted files (excluding `.workflow-overrides.yml` keys).',
      default: false,
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    try {
      const dryRun = args['dry-run'] === true || args.check === true;
      const force = args.force === true && !dryRun;

      const result = await upgradeWorkflows({
        projectRoot: resolve(process.cwd()),
        templatesDir: getWorkflowTemplatesDir(),
        dryRun,
        force,
      });

      cliOutput(
        {
          outcomes: result.outcomes.map((o) => ({
            template: o.template,
            targetPath: o.targetPath,
            status: o.status,
            overrideDeclared: o.overrideDeclared,
          })),
          resolvedTools: result.resolvedTools,
          hasDrift: result.hasDrift,
          ...(dryRun
            ? {
                rendered: result.outcomes.map((o) => ({
                  template: o.template,
                  rendered: o.rendered,
                })),
              }
            : {}),
        },
        { command: 'upgrade', operation: 'upgrade.workflows' },
      );

      // --check contract: exit 1 when drift remains.
      if (args.check === true && result.hasDrift) {
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(err.message, err.code, { name: 'CleoError', fix: err.fix });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/**
 * Upgrade command — unified project maintenance (storage migration, schema repair, structural fixes).
 */
export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description:
      'Unified project maintenance (storage migration, schema repair, structural fixes, doc refresh)',
  },
  subCommands: {
    workflows: workflowsSubcommand,
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
  async run({ args, cmd, rawArgs }) {
    // Citty subcommand routing: if the first positional argument matches a
    // declared subcommand (e.g. `workflows`), let citty dispatch to the
    // subcommand handler instead of running the legacy maintenance flow.
    const firstPositional = rawArgs?.find((a: string) => !a.startsWith('-'));
    if (firstPositional && cmd.subCommands && firstPositional in cmd.subCommands) return;

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
        cliError(
          err.message,
          err.code,
          { name: 'CleoError', fix: err.fix },
          { operation: 'upgrade' },
        );
        process.exit(err.code);
      }
      progress.error('Unexpected error during upgrade');
      throw err;
    }
  },
});
