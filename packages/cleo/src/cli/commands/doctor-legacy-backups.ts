/**
 * `cleo doctor legacy-backups` — enumerate legacy DB backup artefacts.
 *
 * Walks every search root returned by
 * `legacyBackupSearchRoots(projectRoot, cleoHome)` and reports each
 * `*-pre-cleo.db.bak`, `brain.db.PRE-DUP-FIX-*`, `*.pre-untrack-*`,
 * `*.db.malformed`, and `.cleo/backups/sqlite/` rotation-overflow file.
 *
 * Each entry carries an origin hint + retention recommendation per the
 * 30-day soft / 90-day hard retention windows documented in ADR-013
 * §9. `--prune` removes every `delete`-recommended file; ALWAYS defaults
 * to dry-run.
 *
 * @task T10309
 * @epic T10282
 * @saga T10281
 * @see ADR-013 §9 — Legacy backup retention policy
 */

import type { LegacyBackupScanResult } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import { pruneLegacyBackups, scanLegacyBackups } from '@cleocode/core/doctor/legacy-backups.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Parse a positive integer flag, falling back to a default on
 * undefined / NaN / negative values.
 *
 * @param raw - Raw flag value as received from citty.
 * @param fallback - Default to return when parsing fails.
 * @returns A positive integer.
 */
function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * `cleo doctor legacy-backups` subcommand.
 *
 * Read-only by default. With `--prune`, removes every artefact whose
 * `recommendation === 'delete'`; `--prune` defaults to dry-run unless
 * the operator explicitly passes `--no-dry-run`.
 *
 * Exits non-zero (`process.exitCode = 1`) when prune-mode encountered
 * any per-file removal error.
 *
 * @task T10309
 */
export const doctorLegacyBackupsCommand = defineCommand({
  meta: {
    name: 'legacy-backups',
    description:
      'Enumerate legacy *-pre-cleo.db.bak / brain.db.PRE-DUP-FIX-* / pre-untrack / rotation-overflow ' +
      'artefacts and report origin + retention recommendation. Use --prune to delete ' +
      "'delete'-recommended files (always dry-run unless --no-dry-run is passed).",
  },
  args: {
    prune: {
      type: 'boolean',
      description:
        "Remove every artefact whose recommendation is 'delete'. " +
        'Defaults to --dry-run; pass --no-dry-run to physically remove.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Combine with --prune to preview deletions without touching the filesystem.',
      default: true,
    },
    'soft-retention-days': {
      type: 'string',
      description: 'Days under which artefacts are always kept (default 30).',
    },
    'hard-retention-days': {
      type: 'string',
      description: 'Days over which artefacts are eligible for prune (default 90).',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const softRetentionDays = parsePositiveInt(args['soft-retention-days'], 30);
    const hardRetentionDays = parsePositiveInt(args['hard-retention-days'], 90);
    const projectRoot = getProjectRoot();

    let result: LegacyBackupScanResult;
    if (args.prune === true) {
      // citty parses `--dry-run` / `--no-dry-run` as a boolean with
      // `default: true`. The operator must explicitly pass
      // `--no-dry-run` to actually delete.
      const dryRun = args['dry-run'] !== false;
      result = pruneLegacyBackups(projectRoot, {
        softRetentionDays,
        hardRetentionDays,
        dryRun,
      });
    } else {
      result = scanLegacyBackups(projectRoot, {
        softRetentionDays,
        hardRetentionDays,
      });
    }

    cliOutput(result, {
      command: 'doctor',
      operation: 'doctor.legacy-backups.run',
    });

    if (result.errors.length > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
