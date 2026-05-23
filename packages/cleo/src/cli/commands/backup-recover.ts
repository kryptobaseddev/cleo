/**
 * `cleo backup recover brain` — operator-facing brain.db recovery verb.
 *
 * Wraps {@link runBackupRecoverBrain} from `@cleocode/core/store/backup-recover-brain.js`
 * (T10304 internal helper that itself delegates to {@link recoverMalformedBrainDb}
 * from T10303) and exposes the recovery pipeline as a discoverable CLI surface.
 *
 * The chokepoint helper auto-recovers on the next `getBrainDb()` open, so this
 * verb exists for two scenarios the chokepoint does NOT cover:
 *
 *  1. **Pre-emptive recovery** — operator sees `ERR_SQLITE_ERROR errcode=11` in
 *     logs and wants to recover *before* the next session-start so the next
 *     agent doesn't lose its memory writes.
 *  2. **Pinned restore** — auto-recovery picked the freshest snapshot but the
 *     operator knows that one is poisoned too; `--from-snapshot <iso>` lets
 *     them pin an older one.
 *
 * @task T10304
 * @epic T10286
 * @saga T10281
 */

import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { getCleoDirAbsolute, getLogger, getProjectRoot } from '@cleocode/core';
import {
  BackupRecoverBrainError,
  runBackupRecoverBrain,
} from '@cleocode/core/store/backup-recover-brain.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// `cleo backup recover brain` — terminal subcommand
// ---------------------------------------------------------------------------

/**
 * Args accepted by `cleo backup recover brain`. Citty's parsed-args object
 * is a `Record<string, unknown>` at the type level — these narrowing helpers
 * extract each flag with the correct primitive shape.
 */
function readBoolFlag(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function readStringFlag(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/**
 * `cleo backup recover brain` — recover a malformed brain.db from snapshot.
 *
 * Internal export (not `*Command` suffix) — registered as a leaf subcommand
 * inside {@link backupRecoverSubCommand}'s `subCommands`. The
 * `*SubCommand` suffix would be picked up by the command-manifest generator,
 * which would then flag a collision against the top-level `brainCommand`
 * (`cleo brain ...`). Keeping the export name out of the `*Command` /
 * `*SubCommand` pattern avoids the false-positive.
 *
 * @task T10304
 * @epic T10286
 */
export const backupRecoverBrainLeaf = defineCommand({
  meta: {
    name: 'brain',
    description:
      'Recover a malformed brain.db from the freshest validated snapshot (Saga T10281 SG-BRAIN-DB-RESILIENCE)',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be done without quarantining or copying any files',
      default: false,
    },
    'from-snapshot': {
      type: 'string',
      description:
        'Pin recovery to a specific snapshot — absolute path or ISO timestamp prefix (e.g. 2026-05-23)',
      default: '',
    },
    'no-delta': {
      type: 'boolean',
      description:
        'Skip the sqlite3 .recover delta-merge step (reserved — current pipeline does not delta-merge; flag plumbed for forward-compat)',
      default: false,
    },
    force: {
      type: 'boolean',
      description: 'Bypass any safety prompts (currently a no-op; reserved)',
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const projectRoot = getProjectRoot();
    const cleoDir = getCleoDirAbsolute();

    const corruptPath = join(cleoDir, 'brain.db');
    const snapshotDir = join(cleoDir, 'backups', 'snapshot');
    const vacuumSnapshotDir = join(cleoDir, 'backups', 'sqlite');
    const quarantineRoot = join(cleoDir, 'quarantine');

    const argsBag: Record<string, unknown> = args;
    const dryRun = readBoolFlag(argsBag, 'dry-run');
    const fromSnapshot = readStringFlag(argsBag, 'from-snapshot');
    const noDelta = readBoolFlag(argsBag, 'no-delta');

    try {
      const result = runBackupRecoverBrain({
        corruptPath,
        snapshotDir,
        vacuumSnapshotDir,
        legacyArtifactDir: cleoDir,
        quarantineRoot,
        logger: getLogger('backup-recover-brain'),
        dryRun,
        fromSnapshot: fromSnapshot.length > 0 ? fromSnapshot : undefined,
        noDelta,
      });

      cliOutput(result, {
        command: 'backup',
        operation: 'backup.recover.brain',
      });

      if (result.dryRun) {
        humanInfo(
          `[dry-run] Would restore from ${result.restoredFrom} (${
            result.dataLossWindowHours !== null
              ? `~${result.dataLossWindowHours}h data-loss window`
              : 'data-loss window unknown'
          }). Re-run without --dry-run to execute (project root: ${projectRoot}).`,
        );
      } else {
        humanInfo(
          `Recovered brain.db from ${result.restoredFrom}. Corrupt DB quarantined at ${result.quarantinedTo}.`,
        );
      }
    } catch (err) {
      if (err instanceof BackupRecoverBrainError) {
        cliError(
          err.message,
          err.code,
          {
            name: err.codeName,
            ...(err.fix ? { fix: err.fix } : {}),
          },
          { operation: 'backup.recover.brain' },
        );
        process.exitCode = err.code;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        message,
        ExitCode.GENERAL_ERROR,
        { name: 'E_RECOVERY_FAILED' },
        { operation: 'backup.recover.brain' },
      );
      process.exitCode = ExitCode.GENERAL_ERROR;
    }
  },
});

// ---------------------------------------------------------------------------
// `cleo backup recover` — group command (currently only `brain`)
// ---------------------------------------------------------------------------

/**
 * `cleo backup recover` — recovery verb group.
 *
 * Currently hosts only `cleo backup recover brain` (T10304). Reserved for
 * future per-DB recovery verbs (`tasks`, `nexus`, `signaldock`).
 *
 * @task T10304
 * @epic T10286
 */
export const backupRecoverSubCommand = defineCommand({
  meta: {
    name: 'recover',
    description: 'Recover a malformed CLEO database from snapshot',
  },
  subCommands: {
    brain: backupRecoverBrainLeaf,
  },
  async run({ args }): Promise<void> {
    // When invoked with no subcommand, surface the usage. citty fires the
    // parent `run` AFTER the subcommand resolves, so this branch only
    // triggers when the operator typed `cleo backup recover` with no leaf.
    const argsBag: Record<string, unknown> = args;
    const positional = argsBag['_'];
    if (Array.isArray(positional) && positional.length > 0) return;
    cliError(
      'Missing subcommand. Try `cleo backup recover brain` (currently the only available recovery verb).',
      ExitCode.VALIDATION_ERROR,
      {
        name: 'E_VALIDATION',
        fix: 'Run `cleo backup recover brain --help` to see available flags.',
      },
      { operation: 'backup.recover' },
    );
    process.exitCode = ExitCode.VALIDATION_ERROR;
  },
});
