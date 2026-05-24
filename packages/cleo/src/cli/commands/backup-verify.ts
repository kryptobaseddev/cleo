/**
 * `cleo backup verify` — per-DB freshness + integrity walker.
 *
 * Walks every entry in `DB_INVENTORY` and reports, for each role, the
 * freshest snapshot in BOTH the canonical backup directory
 * (`.cleo/backups/sqlite/` per T10315) and the legacy backup directory
 * (`.cleo/backups/snapshot/`, kept read-only for one deprecation window).
 * Each freshest snapshot is opened via the canonical chokepoint and
 * verified with `PRAGMA integrity_check`.
 *
 * Read-only — performs zero writes. Exits non-zero (`process.exitCode = 1`)
 * when ANY DB is more than 24h since its last snapshot OR fails the
 * integrity check, so CI gates can wire the command into a green/red signal.
 *
 * The CLI surface delegates ALL business logic to {@link runBackupVerify}
 * in `@cleocode/core/store/backup-verify.js`, keeping this file purely a
 * citty shell that wires args + renderer + exit code.
 *
 * @task T10319
 * @epic T10284
 * @saga T10281
 */

import { type BackupVerifyResult, ExitCode } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import { runBackupVerify } from '@cleocode/core/store/backup-verify.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo backup verify` subcommand definition for citty.
 *
 * Imported by `backup.ts` and mounted under `subCommands.verify`. Returns
 * a structured envelope keyed by canonical role name; downstream consumers
 * read `data.summary` to drive green/red signals.
 *
 * @task T10319
 */
export const backupVerifySubCommand = defineCommand({
  meta: {
    name: 'verify',
    description:
      'Walk DB_INVENTORY and report per-DB freshness + integrity for each snapshot in BOTH .cleo/backups/sqlite/ (canonical) and .cleo/backups/snapshot/ (legacy). Exits non-zero on any stale/corrupt finding.',
  },
  args: {
    'per-db-timeout-ms': {
      type: 'string',
      description: 'Per-DB integrity-check timeout in milliseconds (default: 30000).',
      default: '30000',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }): Promise<void> {
    // Parse per-db-timeout-ms (citty surfaces the value as a string when the
    // flag has a string default). We accept a finite positive integer and
    // surface validation failures as a structured cliError envelope.
    const argsBag: Record<string, unknown> = args;
    const rawTimeout = argsBag['per-db-timeout-ms'];
    let perDbTimeoutMs = 30_000;
    if (typeof rawTimeout === 'string' && rawTimeout.length > 0) {
      const parsed = Number.parseInt(rawTimeout, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        cliError(
          `Invalid --per-db-timeout-ms value: ${rawTimeout}`,
          ExitCode.VALIDATION_ERROR,
          {
            name: 'E_VALIDATION',
            fix: 'Provide a positive integer number of milliseconds (e.g. --per-db-timeout-ms 30000).',
          },
          { operation: 'backup.verify' },
        );
        process.exitCode = ExitCode.VALIDATION_ERROR;
        return;
      }
      perDbTimeoutMs = parsed;
    }

    let result: BackupVerifyResult;
    try {
      result = runBackupVerify({
        projectRoot: getProjectRoot(),
        perDbTimeoutMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        message,
        ExitCode.GENERAL_ERROR,
        { name: 'E_BACKUP_VERIFY_FAILED' },
        { operation: 'backup.verify' },
      );
      process.exitCode = ExitCode.GENERAL_ERROR;
      return;
    }

    cliOutput(result, {
      command: 'backup',
      operation: 'backup.verify',
    });

    // Non-zero exit when ANY DB is stale or corrupt — missing is reported
    // but does NOT alone trip the exit (a fresh project legitimately has
    // never run `cleo backup add`; we still want the envelope to surface).
    if (
      (result.summary.corrupt > 0 || result.summary.stale > 0) &&
      (process.exitCode === undefined || process.exitCode === 0)
    ) {
      process.exitCode = ExitCode.GENERAL_ERROR;
    }
  },
});
