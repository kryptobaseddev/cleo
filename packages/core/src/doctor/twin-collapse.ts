/**
 * `cleo doctor twin-collapse`: report and retry the T12535 twin collapses.
 *
 * A twin collapse runs inside the tasks and brain domain binds (see
 * `store/twin-collapse.ts`). When it cannot finish (no space for its snapshot,
 * an unusable `.cleo/backups/sqlite`, a merge error) the store turns
 * read-only for users: reads are served from the merged TEMP shadows, and every
 * mutating command is refused with `E_TWIN_COLLAPSE_FAILED`. This module is how
 * the user gets out:
 *
 * - {@link inspectProjectTwinCollapse} reads the store read-only, WITHOUT
 *   binding a domain: each pair's state, conflicts,
 *   the recorded failure, and a preflight of the snapshot a pending collapse
 *   needs (backup directory usable, space needed vs free).
 * - {@link retryTwinCollapse} runs the collapse once on the chokepoint handle,
 *   again without binding, and returns the receipts or the same
 *   `E_TWIN_COLLAPSE_FAILED`.
 * - {@link twinCollapseDoctorCheck} is the `twin_collapse` row of the default
 *   `cleo doctor` report.
 *
 * ## Restore path
 *
 * A collapse never writes the bare tables, and a failed one changes nothing.
 * The initial collapse's snapshot is a full `VACUUM INTO` copy of `cleo.db`
 * from just before the merge, listed by `cleo backup list` as a `migration`
 * backup (`.cleo/backups/sqlite/cleo.db.<backupId>`). To return to it: stop
 * every CLEO process for the project, move `.cleo/cleo.db`, `.cleo/cleo.db-wal`
 * and `.cleo/cleo.db-shm` aside, and copy the snapshot to `.cleo/cleo.db`. The
 * next open re-runs the initial collapse.
 *
 * @module
 * @task T12535
 */

import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { readMarkerSnapshots } from '../store/backup-sidecar.js';
import {
  getDualScopeNativeDb,
  openDualScopeDb,
  resolveDualScopeDbPath,
} from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import { planMigrationSnapshot } from '../store/pre-repair-snapshot.js';
import {
  applyTwinCollapseRecovery,
  collapseTwinTables,
  E_TWIN_COLLAPSE_RECOVER,
  E_TWIN_COLLAPSE_RELEASE,
  inspectTwinCollapse,
  missingSnapshot,
  pinRecoverySnapshot,
  planSnapshotRelease,
  planTwinCollapseRecovery,
  releaseRefused,
  releaseTwinCollapseSnapshot,
  rollbackTwinCollapseRecovery,
  type TwinCollapseReceipt,
  type TwinCollapseRecoveryPlan,
  type TwinCollapseRecoveryReceipt,
  type TwinCollapseRecoveryRollback,
  type TwinCollapseSnapshotRelease,
  type TwinCollapseSnapshotReleasePlan,
  type TwinCollapseStatus,
  unpinnedSnapshot,
} from '../store/twin-collapse.js';
import {
  assertOwnerStoreRewriteConfirmed,
  type OwnerStoreRewriteOptions,
} from '../store/worktree-isolation-guard.js';

/** Preflight of the snapshot a pending initial collapse needs. */
export interface TwinCollapsePreflight {
  /** `.cleo/backups/sqlite/`. */
  readonly backupDir: string;
  /** Why the directory cannot be used, or `null` when it can. */
  readonly backupDirProblem: string | null;
  /** Bytes the snapshot needs (store live pages plus headroom). */
  readonly requiredBytes: number;
  /** Bytes free on that filesystem, or `null` when unknown. */
  readonly availableBytes: number | null;
  /** Whether a snapshot written now would pass the space check and have a directory. */
  readonly ok: boolean;
}

/** Report of `cleo doctor twin-collapse`. */
export interface TwinCollapseReport {
  /** The project store. */
  readonly dbPath: string;
  /** Whether the store file exists. */
  readonly storeExists: boolean;
  /** One entry per bare/twin pair. */
  readonly pairs: readonly TwinCollapseStatus[];
  /** Snapshot preflight, when a pending collapse needs a snapshot. */
  readonly preflight: TwinCollapsePreflight | null;
  /** The command that re-runs the collapse. */
  readonly retryCommand: 'cleo doctor twin-collapse --retry';
}

/** Why `backupDir` (or a parent) cannot hold a snapshot, or `null`. */
function backupDirProblem(backupDir: string): string | null {
  let p = backupDir;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  try {
    if (!statSync(p).isDirectory()) return `${p} exists and is not a directory`;
  } catch (error) {
    return `${p} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/**
 * Report every twin collapse's state, read-only, without binding a domain.
 *
 * @param projectRoot - Project directory.
 * @returns The report.
 * @task T12535
 */
export function inspectProjectTwinCollapse(projectRoot: string): TwinCollapseReport {
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  const base = { dbPath, retryCommand: 'cleo doctor twin-collapse --retry' } as const;
  if (!existsSync(dbPath)) return { ...base, storeExists: false, pairs: [], preflight: null };
  const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
  try {
    const pairs = inspectTwinCollapse(snap.db);
    const needsSnapshot = pairs.some(
      (p) => (p.state === 'pending' || p.state === 'failed') && p.wouldChangeTwin,
    );
    let preflight: TwinCollapsePreflight | null = null;
    if (needsSnapshot) {
      const plan = planMigrationSnapshot(snap.db, dbPath);
      const problem = backupDirProblem(plan.backupDir);
      preflight = {
        backupDir: plan.backupDir,
        backupDirProblem: problem,
        requiredBytes: plan.requiredBytes,
        availableBytes: plan.availableBytes,
        ok:
          problem === null &&
          (plan.availableBytes === null || plan.availableBytes >= plan.requiredBytes),
      };
    }
    return { ...base, storeExists: true, pairs, preflight };
  } finally {
    snap.close();
  }
}

/**
 * Run the twin collapses once on the chokepoint handle, without binding a
 * domain.
 *
 * @param projectRoot - Project directory.
 * @returns One receipt per pair.
 * @throws {CleoError} `E_TWIN_COLLAPSE_FAILED` when it fails again.
 * @task T12535
 */
export async function retryTwinCollapse(
  projectRoot: string,
  options: OwnerStoreRewriteOptions,
): Promise<TwinCollapseReceipt[]> {
  assertOwnerStoreRewriteConfirmed(
    'doctor twin-collapse --retry',
    resolveDualScopeDbPath('project', projectRoot),
    options,
  );
  const handle = await openDualScopeDb('project', projectRoot);
  return collapseTwinTables(getDualScopeNativeDb(handle), handle.dbPath);
}

/** Result of {@link recoverTwinCollapse}. */
export interface TwinCollapseRecoveryResult {
  /** The project store. */
  readonly dbPath: string;
  /** `true`: only planned, nothing written. */
  readonly dryRun: boolean;
  /** What the snapshot holds that the live store lacks (for an apply: what was applied). */
  readonly plan: TwinCollapseRecoveryPlan;
  /** The receipt of this apply, or `null` (dry run, or nothing to recover). */
  readonly receipt: TwinCollapseRecoveryReceipt | null;
}

/** Options of {@link recoverTwinCollapse} and {@link rollbackTwinCollapse}. */
export interface TwinCollapseRecoveryOptions extends OwnerStoreRewriteOptions {
  /** Plan only; the live store is opened read-only. */
  readonly dryRun?: boolean;
  /** Pin an unpinned snapshot (its sidecar only) before applying; without it the apply refuses. */
  readonly pinSnapshot?: boolean;
}

/** A path with symlinks resolved as far as it exists (macOS `/var` is `/private/var`). */
function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Refuse a snapshot a marker records outside this store's own
 * `.cleo/backups/sqlite/` (T12772): the recovery reads it and `--pin-snapshot`
 * writes a sidecar next to it, so it must be this store's backup.
 */
function assertStoreSnapshot(
  snapshot: string,
  dbPath: string,
  code: string = E_TWIN_COLLAPSE_RECOVER,
): void {
  const expected = join(dirname(dbPath), 'backups', 'sqlite');
  if (realDir(dirname(snapshot)) === realDir(expected)) return;
  throw new CleoError(
    ExitCode.VALIDATION_ERROR,
    `${code}: the marker names ${snapshot}, outside this store's backup directory ${expected}; refusing to read or pin it, nothing was changed`,
    {
      fix: `Copy that snapshot into ${expected} and point the marker at it, or run the recovery from the project that owns it.`,
      details: { field: 'snapshot', expected, actual: snapshot },
    },
  );
}

/** Open the live store's snapshot read-only around `fn`; `null` when none is recorded. */
function withRecoverySnapshot<T>(
  live: DatabaseSync,
  dbPath: string,
  fn: (plan: TwinCollapseRecoveryPlan) => T,
): T {
  const probe = planTwinCollapseRecovery(live, null);
  if (probe.snapshot === null) return fn(probe); // never collapsed: nothing to recover
  assertStoreSnapshot(probe.snapshot, dbPath);
  if (!existsSync(probe.snapshot)) throw missingSnapshot(probe.snapshot);
  const snap = openCleoDbSnapshot(probe.snapshot, { readOnly: true, applyPragmas: false });
  try {
    return fn(planTwinCollapseRecovery(live, snap.db));
  } finally {
    snap.close();
  }
}

/**
 * Recover the twin values a 2026.9.21 collapse dropped or replaced (T12727):
 * `cleo doctor twin-collapse --recover [--dry-run]`.
 *
 * Reads the pre-collapse snapshot recorded in the `schema_meta` marker
 * READ-ONLY (it is never modified) and restores every dropped or replaced twin
 * value into `twin_collapse_archive:*`, merging the `focus_state` session
 * notes into the live value once (see `planTwinCollapseRecovery`). A dry run
 * opens the live store read-only and writes nothing. An apply re-plans under
 * the write lock, writes in one transaction and records a receipt that
 * `--rollback` undoes; a second apply finds nothing to do. A store never
 * collapsed has nothing to recover. An unpinned snapshot is reported by the
 * plan, and an apply refuses it unless `pinSnapshot` pins it first. No network.
 *
 * @param projectRoot - Project directory.
 * @param options - `cwd` the command runs from (a worktree needs
 *   `confirmOwnerStore` to write the owner's store), `dryRun`.
 * @returns The plan and, for an apply, the receipt.
 * @throws {CleoError} `E_TWIN_COLLAPSE_RECOVER` when the recorded snapshot is
 *   missing, and the owner-store guard's errors; nothing is written.
 * @task T12727
 */
export async function recoverTwinCollapse(
  projectRoot: string,
  options: TwinCollapseRecoveryOptions,
): Promise<TwinCollapseRecoveryResult> {
  const dryRun = options.dryRun === true;
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  if (!existsSync(dbPath)) throw new Error(`no project store at ${dbPath}`);
  if (dryRun) {
    const live = openCleoDbSnapshot(dbPath, { readOnly: true });
    try {
      return withRecoverySnapshot(live.db, dbPath, (plan) => ({
        dbPath,
        dryRun,
        plan,
        receipt: null,
      }));
    } finally {
      live.close();
    }
  }
  assertOwnerStoreRewriteConfirmed('doctor twin-collapse --recover', dbPath, options);
  // Checked before the store opens (a collapse run during the open may pin
  // it), and only when there is something to recover (T12772).
  const ro = openCleoDbSnapshot(dbPath, { readOnly: true });
  let probe: TwinCollapseRecoveryPlan;
  try {
    probe = withRecoverySnapshot(ro.db, dbPath, (plan) => plan);
  } finally {
    ro.close();
  }
  if (
    probe.snapshot !== null &&
    probe.changes &&
    !probe.snapshotPinned &&
    !(options.pinSnapshot === true && pinRecoverySnapshot(probe.snapshot))
  )
    throw unpinnedSnapshot(probe.snapshot);
  const handle = await openDualScopeDb('project', projectRoot);
  const live = getDualScopeNativeDb(handle);
  return withRecoverySnapshot(live, dbPath, (preview) => ({
    dbPath,
    dryRun,
    ...applyTwinCollapseRecovery(live, preview),
  }));
}

/**
 * Undo one recovery apply: `cleo doctor twin-collapse --rollback <receiptId>`
 * (see `rollbackTwinCollapseRecovery`). The snapshot is not needed.
 *
 * @param projectRoot - Project directory.
 * @param id - The receipt key (`twin_collapse_recovery:<recoveredAt>`).
 * @param options - `cwd` and `confirmOwnerStore`, as for {@link recoverTwinCollapse}.
 * @returns What was undone.
 * @task T12727
 */
export async function rollbackTwinCollapse(
  projectRoot: string,
  id: string,
  options: OwnerStoreRewriteOptions,
): Promise<TwinCollapseRecoveryRollback> {
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  if (!existsSync(dbPath)) throw new Error(`no project store at ${dbPath}`);
  assertOwnerStoreRewriteConfirmed('doctor twin-collapse --rollback', dbPath, options);
  const handle = await openDualScopeDb('project', projectRoot);
  return rollbackTwinCollapseRecovery(getDualScopeNativeDb(handle), id);
}

/** Audit log of snapshot releases, under the project's `.cleo/audit/`. */
export const TWIN_COLLAPSE_RELEASE_AUDIT_FILE = 'twin-collapse-release.jsonl';

/** Result of {@link releaseProjectTwinCollapseSnapshot}. */
export interface TwinCollapseSnapshotReleaseResult {
  /** The project store. */
  readonly dbPath: string;
  /** `true`: only planned, nothing written. */
  readonly dryRun: boolean;
  /** What a release would do, and why it may or may not. */
  readonly plan: TwinCollapseSnapshotReleasePlan;
  /** The release, or `null` on a dry run. */
  readonly release: TwinCollapseSnapshotRelease | null;
  /** The audit log the release was recorded in, or `null` on a dry run. */
  readonly auditFile: string | null;
}

/** Options of {@link releaseProjectTwinCollapseSnapshot}. */
export interface TwinCollapseSnapshotReleaseOptions extends OwnerStoreRewriteOptions {
  /** Plan only; the live store is opened read-only. */
  readonly dryRun?: boolean;
  /**
   * The owner's decision to release, which the calling agent obtained through
   * its ask tool. The CLI never prompts; without it nothing is written.
   */
  readonly confirm?: boolean;
}

/**
 * Release a pre-collapse snapshot (T12767):
 * `cleo doctor twin-collapse --release-snapshot <id> [--dry-run] --confirm`.
 *
 * Allowed only after a verified recovery or a no-recovery-needed check (see
 * `planSnapshotRelease`): the recovery plan against the snapshot must find
 * nothing left to recover. A release clears the markers' reference to the
 * snapshot and its sidecar pin, and appends a row to
 * `.cleo/audit/twin-collapse-release.jsonl`. The snapshot file is never
 * touched; it rotates normally afterwards. A dry run reports the bytes
 * reclaimed once it rotates and writes nothing.
 *
 * @param projectRoot - Project directory.
 * @param id - The snapshot: backup id (`migration-<timestamp>`), file name or path.
 * @param options - `cwd`, `confirmOwnerStore`, `dryRun`, `confirm`.
 * @returns The plan and, for a release, what was released.
 * @throws {CleoError} `E_TWIN_COLLAPSE_RELEASE` (not confirmed, or not
 *   releasable) and the owner-store guard's errors; nothing is written.
 * @task T12767
 */
export async function releaseProjectTwinCollapseSnapshot(
  projectRoot: string,
  id: string,
  options: TwinCollapseSnapshotReleaseOptions,
): Promise<TwinCollapseSnapshotReleaseResult> {
  const dryRun = options.dryRun === true;
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  if (!existsSync(dbPath)) throw new Error(`no project store at ${dbPath}`);
  const withSnapshot = <T>(live: DatabaseSync, fn: (snap: DatabaseSync | null) => T): T => {
    const path = planSnapshotRelease(live, id, null).snapshot;
    if (path !== null) assertStoreSnapshot(path, dbPath, E_TWIN_COLLAPSE_RELEASE); // T12772
    if (path === null || !existsSync(path)) return fn(null);
    const snap = openCleoDbSnapshot(path, { readOnly: true, applyPragmas: false });
    try {
      return fn(snap.db);
    } finally {
      snap.close();
    }
  };
  if (dryRun) {
    const live = openCleoDbSnapshot(dbPath, { readOnly: true });
    try {
      const plan = withSnapshot(live.db, (snap) => planSnapshotRelease(live.db, id, snap));
      return { dbPath, dryRun, plan, release: null, auditFile: null };
    } finally {
      live.close();
    }
  }
  if (options.confirm !== true)
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${E_TWIN_COLLAPSE_RELEASE}: releasing ${id} needs the owner's decision (--confirm); nothing was changed`,
      {
        fix: `cleo doctor twin-collapse --release-snapshot ${id} --dry-run  # show the plan, ask the owner, then add --confirm`,
        details: { field: 'confirm', expected: true, actual: false },
      },
    );
  assertOwnerStoreRewriteConfirmed('doctor twin-collapse --release-snapshot', dbPath, options);
  const handle = await openDualScopeDb('project', projectRoot);
  const live = getDualScopeNativeDb(handle);
  const auditFile = join(dirname(dbPath), 'audit', TWIN_COLLAPSE_RELEASE_AUDIT_FILE);
  return withSnapshot(live, (snap) => {
    let plan = planSnapshotRelease(live, id, snap);
    if (plan.basis === null) throw releaseRefused(id, plan);
    const release = releaseTwinCollapseSnapshot(live, id, snap, (row) => {
      mkdirSync(dirname(auditFile), { recursive: true });
      appendFileSync(
        auditFile,
        `${JSON.stringify({
          timestamp: row.releasedAt,
          operation: 'doctor twin-collapse --release-snapshot',
          snapshot: row.snapshot,
          basis: row.basis,
          bytes: row.bytes,
          markers: row.markers,
          receipts: row.receipts,
          confirmedBy: 'owner (--confirm)',
          cwd: resolve(options.cwd),
          pid: process.pid,
        })}\n`,
      );
    });
    plan = { ...plan, basis: release.basis };
    return { dbPath, dryRun, plan, release, auditFile };
  });
}

/** One row of the default `cleo doctor` report (the `DoctorCheck` shape). */
export interface TwinCollapseDoctorCheck {
  readonly check: 'twin_collapse';
  readonly status: 'ok' | 'warning' | 'error';
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly fix?: string;
}

/**
 * The `twin_collapse` check of the default `cleo doctor` report: `error` for a
 * failed collapse or one whose snapshot cannot be written, `warning` for a
 * pending one or bare rows an older build changed since the last merge.
 *
 * @param projectRoot - Project directory.
 * @returns The check row.
 * @task T12535
 */
export function twinCollapseDoctorCheck(projectRoot: string): TwinCollapseDoctorCheck {
  let report: TwinCollapseReport;
  try {
    report = inspectProjectTwinCollapse(projectRoot);
  } catch (error) {
    return {
      check: 'twin_collapse',
      status: 'warning',
      message: `twin collapse state unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // T12770: rotation keeps every migration backup while a marker is unreadable.
  const unreadableMarkers = report.storeExists
    ? readMarkerSnapshots(join(dirname(report.dbPath), 'backups', 'sqlite')).unreadable
    : [];
  const details = {
    dbPath: report.dbPath,
    pairs: report.pairs,
    preflight: report.preflight,
    unreadableMarkers,
  };
  const failed = report.pairs.filter((p) => p.state === 'failed');
  if (failed.length > 0 || report.preflight?.ok === false) {
    const first = failed[0]?.failure;
    return {
      check: 'twin_collapse',
      status: 'error',
      message:
        failed.length > 0
          ? `twin collapse of ${failed.map((p) => p.table).join(', ')} failed (reads work, writes are refused): ${first?.cause ?? 'unknown cause'}` +
            (first?.snapshotPath ? ` (snapshot ${first.snapshotPath})` : '')
          : `pending twin collapse cannot write its snapshot: ${report.preflight?.backupDirProblem ?? `${report.preflight?.requiredBytes} bytes needed, ${report.preflight?.availableBytes} free`}`,
      details,
      fix: `Clear the cause, then run '${report.retryCommand}'`,
    };
  }
  const pending = report.pairs.filter((p) => p.state === 'pending' && p.wouldChangeTwin);
  const changed = report.pairs.filter((p) => p.state === 'bare-changed');
  const conflicted = report.pairs.filter((p) => p.conflicts.length > 0);
  const unguarded = report.pairs.filter((p) => p.guardsIntact === false);
  const unpinned = report.pairs.filter((p) => p.snapshotPinned === false);
  const missing = report.pairs.filter((p) => p.snapshotMissing);
  const archived = report.pairs.filter((p) => p.archived.length > 0);
  // Informational only (not a warning): archived twin values are kept, not lost.
  const info =
    archived.length > 0
      ? `the initial collapse archived the twin's own values of ${archived.map((p) => `${p.table}: ${p.archived.join(', ')}`).join('; ')} under twin_collapse_archive:<key> (the bare value won; nothing was lost)`
      : '';
  if (
    pending.length > 0 ||
    changed.length > 0 ||
    conflicted.length > 0 ||
    unguarded.length > 0 ||
    unpinned.length > 0 ||
    missing.length > 0 ||
    unreadableMarkers.length > 0
  ) {
    return {
      check: 'twin_collapse',
      status: 'warning',
      message: [
        pending.length > 0
          ? `twin collapse pending for ${pending.map((p) => p.table).join(', ')} (runs at the next open)`
          : '',
        changed.length > 0
          ? `an older CLEO build changed ${changed.map((p) => `${p.table} (${p.changedSinceMerge})`).join(', ')} since the last merge; the next open carries it`
          : '',
        conflicted.length > 0
          ? `both builds changed ${conflicted.map((p) => `${p.table}: ${p.conflicts.join(', ')}`).join('; ')} (last merge ${conflicted[0]?.conflictsAt}); the twin value was kept`
          : '',
        unguarded.length > 0
          ? `the triggers that freeze ${unguarded.map((p) => p.table).join(', ')} against older CLEO builds are missing (re-installed at the next open, or run 'cleo doctor twin-collapse --retry')`
          : '',
        unpinned.length > 0
          ? `the pre-collapse snapshot of ${unpinned.map((p) => `${p.table} (${p.snapshotPath})`).join(', ')} is not pinned yet; the next open pins it so rotation never deletes it`
          : '',
        unreadableMarkers.length > 0
          ? `the twin-collapse marker ${unreadableMarkers.join(', ')} cannot be read, so backup rotation keeps every migration backup in .cleo/backups/sqlite until it is repaired`
          : '',
        missing.length > 0
          ? `the pre-collapse snapshot of ${missing.map((p) => `${p.table} (${p.snapshotPath})`).join(', ')} is missing: the store before the collapse can no longer be recovered from it`
          : '',
        info,
      ]
        .filter(Boolean)
        .join('; '),
      details,
    };
  }
  return {
    check: 'twin_collapse',
    status: 'ok',
    message: report.storeExists
      ? ['twin tables collapsed and in step', info].filter(Boolean).join('; ')
      : 'no project store yet',
    details,
  };
}
