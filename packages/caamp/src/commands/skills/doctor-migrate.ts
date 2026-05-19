/**
 * `skills migrate` subcommand — legacy XDG store → `~/.cleo/skills/` SSoT.
 *
 * @remarks
 * Implements the CLI surface for T9653. Wraps the pure helpers in
 * `../../core/skills/migration.ts` with LAFS envelope emission, format
 * resolution, and the `--dry-run` / `--rollback` flag set required by
 * acceptance criteria 3 + 4 of T9653.
 *
 * Registered as `caamp skills migrate` (also surfaced through `cleo skills
 * migrate` once the cleo dispatch wiring lands). We register a flat
 * subcommand rather than nesting under `doctor` so the file stays orthogonal
 * to T9652 (which is in flight against `doctor.ts`) — the task spec
 * explicitly authorises this fallback.
 *
 * @task T9653
 * @epic T9571
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §1
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { isHuman } from '../../core/logger.js';
import {
  defaultMigrationOptions,
  type MigrationOptions,
  type MigrationOutcome,
  planMigration,
  runMigration,
  runRollback,
} from '../../core/skills/migration.js';

/**
 * Options the migrate CLI accepts.
 *
 * @remarks
 * `dryRun` and `rollback` are mutually exclusive — selecting both surfaces a
 * `VALIDATION` error. `manifestNames` is a hidden test seam so unit tests
 * can drive the planner against a synthetic manifest.
 */
export interface MigrateCliOpts {
  dryRun?: boolean;
  rollback?: boolean;
  json?: boolean;
  human?: boolean;
  /** Hidden test seam — overrides the default options bag entirely. */
  __optionsOverride?: MigrationOptions;
  /** Hidden test seam — supplies the canonical manifest names. */
  __manifestNamesOverride?: string[];
}

/**
 * Build the migration options bag for a given invocation.
 *
 * @remarks
 * When `__optionsOverride` is set (tests) it wins outright. Otherwise we
 * compose the production defaults around the supplied manifest names.
 *
 * @param opts - Parsed CLI options (incl. hidden test seams).
 * @returns A fully-populated migration options bag.
 */
function buildOptions(opts: MigrateCliOpts): MigrationOptions {
  if (opts.__optionsOverride) return opts.__optionsOverride;
  const manifestNames = opts.__manifestNamesOverride ?? [];
  return defaultMigrationOptions(manifestNames);
}

/**
 * Render a successful migration outcome to a human-readable string.
 *
 * @remarks
 * The JSON path always wins by default; this helper is only invoked when the
 * resolved format is `'human'`. Keeps colour use minimal so the output is
 * grep-able from shell scripts.
 *
 * @param outcome - The outcome returned by the migration helper.
 * @returns Multi-line string ready for `console.log`.
 */
function renderHuman(outcome: MigrationOutcome): string {
  const lines: string[] = [];
  lines.push(pc.bold(`\nskills ${outcome.action}`));
  lines.push(pc.dim(`  legacy:    ${outcome.legacyRoot}`));
  lines.push(pc.dim(`  canonical: ${outcome.canonicalRoot}`));
  if (outcome.backupPath) {
    lines.push(pc.dim(`  backup:    ${outcome.backupPath}`));
  }
  lines.push(pc.dim(`  duration:  ${outcome.durationMs}ms`));
  if (outcome.migrated.length > 0) {
    lines.push(pc.green(`\nMigrated (${outcome.migrated.length}):`));
    for (const m of outcome.migrated) {
      lines.push(`  + ${pc.bold(m.name)} ${pc.dim(`[${m.sourceType}]`)}`);
    }
  }
  if (outcome.skipped.length > 0) {
    lines.push(pc.yellow(`\nSkipped (${outcome.skipped.length}):`));
    for (const s of outcome.skipped) {
      lines.push(`  ! ${pc.bold(s.name)} ${pc.dim(`(${s.reason})`)}`);
    }
  }
  if (outcome.action === 'no-op') {
    lines.push(pc.dim('\nLegacy store is already migrated (sentinel present).'));
  }
  if (outcome.action === 'dry-run') {
    lines.push(pc.dim('\n(dry run — no filesystem changes were made)'));
  }
  return lines.join('\n');
}

/**
 * Register the `skills migrate` subcommand on a Commander parent.
 *
 * @remarks
 * Wires up the `--dry-run` / `--rollback` / `--json` / `--human` flags and
 * dispatches into the pure migration helpers. Emits a LAFS envelope on
 * stdout for the JSON path and a coloured summary for the human path.
 *
 * @param parent - The `skills` Commander instance to attach to.
 *
 * @example
 * ```bash
 * # Preview without writing
 * caamp skills migrate --dry-run
 *
 * # Perform the migration (default action)
 * caamp skills migrate
 *
 * # Roll back to the most recent backup
 * caamp skills migrate --rollback
 * ```
 *
 * @public
 */
export function registerSkillsDoctorMigrate(parent: Command): void {
  parent
    .command('migrate')
    .description('Migrate legacy skills (~/.local/share/agents/skills) into ~/.cleo/skills')
    .option('--dry-run', 'Preview the plan without writing anything', false)
    .option('--rollback', 'Restore from the most recent backup tarball', false)
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(async (opts: MigrateCliOpts) => {
      const operation = 'skills.migrate';
      const mvi: import('../../core/lafs.js').MVILevel = 'standard';

      let format: 'json' | 'human';
      try {
        format = resolveFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: (opts.human ?? false) || isHuman(),
          projectDefault: 'json',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(
          operation,
          mvi,
          ErrorCodes.FORMAT_CONFLICT,
          message,
          ErrorCategories.VALIDATION,
        );
        process.exit(1);
      }

      if (opts.dryRun && opts.rollback) {
        const message = 'Cannot combine --dry-run with --rollback';
        if (format === 'json') {
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.INVALID_INPUT,
            message,
            ErrorCategories.VALIDATION,
          );
        } else {
          console.error(pc.red(message));
        }
        process.exit(1);
      }

      const options = buildOptions(opts);

      try {
        let outcome: MigrationOutcome;
        if (opts.rollback) {
          outcome = await runRollback(options);
        } else if (opts.dryRun) {
          outcome = planMigration(options);
        } else {
          outcome = await runMigration(options);
        }

        if (format === 'json') {
          outputSuccess(operation, mvi, outcome);
        } else {
          console.log(renderHuman(outcome));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (format === 'json') {
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.INTERNAL_ERROR,
            message,
            ErrorCategories.MIGRATION,
            { legacyRoot: options.legacyRoot, canonicalRoot: options.canonicalRoot },
          );
        } else {
          console.error(pc.red(`migration failed: ${message}`));
        }
        process.exit(1);
      }
    });
}
