/**
 * `cleo doctor repair` orchestrator — detect malformed CLEO databases and
 * restore each from its freshest validated snapshot (T11829 · DHQ-060).
 *
 * ## Why this exists
 *
 * The corruption-resilience pipeline ALREADY existed before T11829:
 *
 *  - {@link recoverMalformedDb} (quarantine → snapshot-restore → `quick_check`),
 *  - `autoRecoverFromBackup` (catches `"database disk image is malformed"` at
 *    open and restores the freshest VACUUM snapshot), and
 *  - the operator verb `cleo backup recover <role>` ({@link runBackupRecover}).
 *
 * The ONLY gap vs the DHQ-060 ask was a discoverable `cleo doctor` entry point
 * that DETECTS corruption across the fleet and repairs only what is broken. This
 * module is that orchestrator — it adds NO new recovery logic. It probes each
 * role's live DB with `PRAGMA quick_check` (the same probe the pipeline runs on
 * snapshot candidates, via {@link probeSnapshot}) and delegates every actual
 * repair to {@link runBackupRecover} → {@link recoverMalformedDb}.
 *
 * ## WAL-specific corruption is covered
 *
 * A torn WAL frame surfaces as `"database disk image is malformed"` and makes
 * `PRAGMA quick_check` return a non-`ok` result — so {@link probeSnapshot}
 * detects it. The quarantine step ({@link quarantineCorruptDb}) already moves the
 * `-wal`/`-shm` sidecars alongside the main file, so the WAL case is fully
 * handled by the existing pipeline; this orchestrator does not need to special-case it.
 *
 * @module
 * @task T11829 (DHQ-060 — `cleo doctor repair` entry point over the recovery pipeline)
 * @epic T11833
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @see packages/core/src/store/recover-malformed-db.ts — the recovery pipeline
 * @see packages/core/src/store/backup-recover.ts — `cleo backup recover <role>` wrapper
 */

import { existsSync } from 'node:fs';
import { DB_INVENTORY, type DbRole, type DoctorRepairResult } from '@cleocode/contracts';
import { BackupRecoverError, runBackupRecover } from './backup-recover.js';
import { probeSnapshot, type RecoveryLogger, resolveRoleDbPath } from './recover-malformed-db.js';

/**
 * Options accepted by {@link repairMalformedDbs}.
 *
 * @task T11829
 * @public
 */
export interface RepairMalformedDbsOptions {
  /** Absolute path to the project root (resolves `<projectRoot>` inventory tokens). */
  projectRoot: string;
  /**
   * Roles to inspect. When omitted, EVERY role in {@link DB_INVENTORY} whose live
   * file exists is probed. An explicit single-role list (from `--role`) is probed
   * even when absent (so the operator gets a clear "not present" report).
   */
  roles?: DbRole[];
  /**
   * When `true`, detect + plan only — corruption is reported with
   * `action: 'would-repair'` but NO quarantine/restore is performed.
   *
   * @default false
   */
  dryRun?: boolean;
  /** Pino-shaped logger for recovery announcements. */
  logger: RecoveryLogger;
}

/**
 * Probe a single role's live DB and, when malformed, repair it from snapshot.
 *
 * Pure delegation: detection via {@link probeSnapshot} (`PRAGMA quick_check`),
 * repair via {@link runBackupRecover}. Never throws — a recovery failure is
 * captured in the returned record's `action: 'failed'`.
 *
 * @internal
 */
function repairOneRole(
  role: DbRole,
  opts: RepairMalformedDbsOptions,
): DoctorRepairResult['roles'][number] {
  const dbPath = resolveRoleDbPath(role, { projectRoot: opts.projectRoot });
  const present = existsSync(dbPath);

  if (!present) {
    return {
      role,
      dbPath,
      present: false,
      healthy: true,
      action: 'skipped',
      restoredFrom: null,
      quarantinedTo: null,
      dataLossWindowHours: null,
      detail: 'live DB file not present on disk (nothing to repair)',
    };
  }

  // DETECT — the same `PRAGMA quick_check` the pipeline runs on snapshots. A
  // torn WAL frame ("database disk image is malformed") fails this probe.
  const probe = probeSnapshot(dbPath);
  if (probe.ok) {
    return {
      role,
      dbPath,
      present: true,
      healthy: true,
      action: 'skipped',
      restoredFrom: null,
      quarantinedTo: null,
      dataLossWindowHours: null,
      detail: 'PRAGMA quick_check passed — DB is healthy',
    };
  }

  // MALFORMED — plan or repair.
  if (opts.dryRun === true) {
    try {
      // Dry-run delegates to the SAME pipeline (no mutation) for an honest plan.
      const plan = runBackupRecover({
        role,
        projectRoot: opts.projectRoot,
        logger: opts.logger,
        dryRun: true,
      });
      return {
        role,
        dbPath,
        present: true,
        healthy: false,
        action: 'would-repair',
        restoredFrom: plan.restoredFrom || null,
        quarantinedTo: null,
        dataLossWindowHours: plan.dataLossWindowHours,
        detail: `malformed — would restore from ${plan.restoredFrom} (re-run without --dry-run to repair)`,
      };
    } catch (err) {
      return {
        role,
        dbPath,
        present: true,
        healthy: false,
        action: 'failed',
        restoredFrom: null,
        quarantinedTo: null,
        dataLossWindowHours: null,
        detail: `malformed but NO valid snapshot to restore from: ${
          err instanceof BackupRecoverError ? err.message : String(err)
        }`,
      };
    }
  }

  // EXECUTE — quarantine + restore + verify via the existing pipeline.
  try {
    const result = runBackupRecover({
      role,
      projectRoot: opts.projectRoot,
      logger: opts.logger,
      dryRun: false,
    });
    return {
      role,
      dbPath,
      present: true,
      healthy: false,
      action: 'repaired',
      restoredFrom: result.restoredFrom || null,
      quarantinedTo: result.quarantinedTo || null,
      dataLossWindowHours: result.dataLossWindowHours,
      detail: `repaired — restored from ${result.restoredFrom}; corrupt DB quarantined at ${result.quarantinedTo}`,
    };
  } catch (err) {
    return {
      role,
      dbPath,
      present: true,
      healthy: false,
      action: 'failed',
      restoredFrom: null,
      quarantinedTo: null,
      dataLossWindowHours: null,
      detail: `malformed — recovery FAILED: ${
        err instanceof BackupRecoverError ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Detect and repair malformed CLEO databases across the fleet (T11829 · DHQ-060).
 *
 * For each requested role (or every present role in {@link DB_INVENTORY} when none
 * are specified) this probes the live DB with `PRAGMA quick_check` and, when
 * corruption is found, restores the freshest validated snapshot via the existing
 * {@link runBackupRecover} pipeline. No new recovery logic is introduced — this is
 * the discoverable `cleo doctor repair` entry point requested by DHQ-060.
 *
 * @param opts - Repair inputs (project root, optional role filter, dry-run, logger).
 * @returns A {@link DoctorRepairResult} aggregate with per-role outcomes.
 *
 * @example
 * ```ts
 * const report = repairMalformedDbs({ projectRoot: '/repo', logger });
 * if (report.failedCount > 0) process.exitCode = 1;
 * ```
 *
 * @task T11829
 * @epic T11833
 * @saga T11242
 * @public
 */
export function repairMalformedDbs(opts: RepairMalformedDbsOptions): DoctorRepairResult {
  const explicit = opts.roles !== undefined && opts.roles.length > 0;
  const candidateRoles: DbRole[] = explicit
    ? (opts.roles as DbRole[])
    : DB_INVENTORY.map((e) => e.role).filter((role) =>
        existsSync(resolveRoleDbPath(role, { projectRoot: opts.projectRoot })),
      );

  const roles = candidateRoles.map((role) => repairOneRole(role, opts));

  return {
    dryRun: opts.dryRun === true,
    roles,
    malformedCount: roles.filter((r) => !r.healthy).length,
    repairedCount: roles.filter((r) => r.action === 'repaired').length,
    failedCount: roles.filter((r) => r.action === 'failed').length,
  };
}
