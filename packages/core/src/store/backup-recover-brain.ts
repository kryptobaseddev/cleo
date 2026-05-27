/**
 * Brain-specific CLI wrapper around the generic recovery pipeline
 * ({@link runBackupRecover}, T10318).
 *
 * @remarks
 * Pre-T10318 this module owned the entire brain.db recovery wrapper. T10318
 * generalised the pipeline to every role in `DB_INVENTORY` and moved the
 * implementation to {@link ../store/backup-recover.ts}. This module now
 * exists purely as a backward-compatibility shim:
 *
 * - The exported type aliases and {@link runBackupRecoverBrain} entry point
 *   keep importers compiling without source changes.
 * - The envelope shape (`BackupRecoverBrainResult` with the brain-specific
 *   three-table row count) is preserved by projecting the generic
 *   `BackupRecoverResult.rowsRecovered` map into the legacy
 *   `{ observations, decisions, learnings }` shape.
 *
 * Existing brain-only call sites SHOULD migrate to {@link runBackupRecover}
 * with `role: 'brain'`. Net-new code MUST NOT import from this module.
 *
 * @task T10304
 * @epic T10286
 * @saga T10281
 * @deprecated since T10318 — call `runBackupRecover({ role: 'brain', ... })` directly.
 */

import type { BackupRecoverBrainResult, BrainRecoveredRowCounts } from '@cleocode/contracts';
import {
  BackupRecoverError as GenericBackupRecoverError,
  runBackupRecover,
} from './backup-recover.js';
import type { RecoveryLogger } from './recover-malformed-db.js';

// ---------------------------------------------------------------------------
// Backward-compat type re-exports
// ---------------------------------------------------------------------------

/**
 * Pre-T10318 alias for the now-canonical {@link BackupRecoverError}.
 *
 * @deprecated since T10318 — import {@link BackupRecoverError} from
 * `@cleocode/core/store/backup-recover.js` directly.
 */
export { GenericBackupRecoverError as BackupRecoverBrainError };

/**
 * Options accepted by {@link runBackupRecoverBrain}.
 *
 * @deprecated since T10318 — use {@link BackupRecoverOptions} from
 * `@cleocode/core/store/backup-recover.js`.
 */
export interface BackupRecoverBrainOptions {
  /**
   * Absolute path to the corrupt `brain.db`. Required even in `dryRun`
   * mode so the planner can compute the canonical quarantine target.
   */
  corruptPath: string;
  /** Absolute path to `.cleo/backups/snapshot/`. */
  snapshotDir: string;
  /** Absolute path to `.cleo/backups/sqlite/` (VACUUM INTO snapshots). */
  vacuumSnapshotDir?: string;
  /** Absolute path to `.cleo/` for legacy `brain.db.PRE-DUP-FIX-*` fallback. */
  legacyArtifactDir?: string;
  /**
   * Absolute path to the quarantine root. Defaults to
   * `<dirname(corruptPath)>/quarantine` to match the chokepoint helper.
   */
  quarantineRoot?: string;
  /** Pino-shaped logger for the recovery announcement. */
  logger: RecoveryLogger;
  /**
   * When `true`, enumerate candidates + validate the freshest one and
   * return the planned envelope WITHOUT quarantining or copying.
   */
  dryRun?: boolean;
  /**
   * Optional snapshot pin — either an absolute path to a specific
   * snapshot file OR an ISO timestamp prefix.
   */
  fromSnapshot?: string;
  /**
   * When `true`, skip the future `sqlite3 .recover` delta-merge step.
   */
  noDelta?: boolean;
}

// ---------------------------------------------------------------------------
// Brain → generic envelope projection
// ---------------------------------------------------------------------------

/**
 * Project the generic per-table `rowsRecovered` map into the brain-specific
 * `{ observations, decisions, learnings }` shape that callers pre-T10318
 * relied on.
 *
 * @internal
 */
function projectBrainRowCounts(
  rowsRecovered: Readonly<Record<string, number | null>>,
): BrainRecoveredRowCounts {
  return {
    observations:
      typeof rowsRecovered.brain_observations === 'number'
        ? rowsRecovered.brain_observations
        : null,
    decisions:
      typeof rowsRecovered.brain_decisions === 'number' ? rowsRecovered.brain_decisions : null,
    learnings:
      typeof rowsRecovered.brain_learnings === 'number' ? rowsRecovered.brain_learnings : null,
  };
}

/**
 * Run the brain.db recovery pipeline as an operator-facing one-shot.
 *
 * @remarks
 * Thin shim over {@link runBackupRecover} with `role='brain'`. Returns the
 * brain-shaped {@link BackupRecoverBrainResult} envelope by projecting the
 * generic per-table row map into the legacy three-table shape.
 *
 * @deprecated since T10318 — call
 * `runBackupRecover({ role: 'brain', ... })` directly and consume the
 * generic envelope.
 *
 * @param opts - Recovery inputs (corrupt path, snapshot dirs, mode flags).
 * @returns The brain-shaped recovery envelope.
 *
 * @task T10304
 * @epic T10286
 * @saga T10281
 */
export function runBackupRecoverBrain(opts: BackupRecoverBrainOptions): BackupRecoverBrainResult {
  const generic = runBackupRecover({
    role: 'brain',
    corruptPath: opts.corruptPath,
    snapshotDir: opts.snapshotDir,
    vacuumSnapshotDir: opts.vacuumSnapshotDir,
    legacyArtifactDir: opts.legacyArtifactDir,
    quarantineRoot: opts.quarantineRoot,
    logger: opts.logger,
    dryRun: opts.dryRun,
    fromSnapshot: opts.fromSnapshot,
    noDelta: opts.noDelta,
  });

  return {
    restoredFrom: generic.restoredFrom,
    rowsRecovered: projectBrainRowCounts(generic.rowsRecovered),
    dataLossWindowHours: generic.dataLossWindowHours,
    integrityOK: generic.integrityOK,
    quarantinedTo: generic.quarantinedTo,
    dryRun: generic.dryRun,
  };
}
