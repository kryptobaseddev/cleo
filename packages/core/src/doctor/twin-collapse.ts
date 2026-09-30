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

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
  inspectTwinCollapse,
  missingSnapshot,
  pinRecoverySnapshot,
  planTwinCollapseRecovery,
  rollbackTwinCollapseRecovery,
  type TwinCollapseReceipt,
  type TwinCollapseRecoveryPlan,
  type TwinCollapseRecoveryReceipt,
  type TwinCollapseRecoveryRollback,
  type TwinCollapseSnapshotRepoint,
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
  /** Markers re-pointed at a moved store's snapshot (T12788), or `null`/absent. */
  readonly repointed?: TwinCollapseSnapshotRepoint | null;
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

/** Audit log of markers re-pointed at a moved store's snapshot (T12788). */
export const TWIN_COLLAPSE_REPOINT_AUDIT_FILE = 'twin-collapse-repoint.jsonl';

/** The SQLite file header every snapshot starts with. */
const SQLITE_HEADER = 'SQLite format 3\u0000';

/** Whether `path` is a migration backup that starts with the SQLite header. */
function looksLikeStoreSnapshot(path: string): boolean {
  if (!/\.migration-/.test(basename(path))) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return (
      readSync(fd, header, 0, header.length, 0) === header.length &&
      header.toString('latin1') === SQLITE_HEADER
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The snapshot file to read for a marker path. The recovery reads it and
 * `--pin-snapshot` writes a sidecar next to it, so it must be this store's own
 * backup (T12772): a path in `<db dir>/backups/sqlite/` is used as is; a path
 * elsewhere (the store moved: `/mnt` → `/home`, Linux → Mac) resolves to
 * `<db dir>/backups/sqlite/<basename>` when that file is a migration backup
 * starting with the SQLite header (T12788). Anything else is refused.
 *
 * @returns The file to use, and the marker path it replaces (`null` when the same).
 */
function resolveStoreSnapshot(
  snapshot: string,
  dbPath: string,
  code: string = E_TWIN_COLLAPSE_RECOVER,
): { readonly path: string; readonly movedFrom: string | null } {
  const expected = join(dirname(dbPath), 'backups', 'sqlite');
  if (realDir(dirname(snapshot)) === realDir(expected)) return { path: snapshot, movedFrom: null };
  const local = join(expected, basename(snapshot));
  if (existsSync(local) && looksLikeStoreSnapshot(local))
    return { path: local, movedFrom: snapshot };
  throw new CleoError(
    ExitCode.VALIDATION_ERROR,
    `${code}: the marker names ${snapshot}, outside this store's backup directory ${expected}` +
      (existsSync(local)
        ? `, and ${local} is not a migration snapshot`
        : `, and ${local} does not exist`) +
      '; refusing to read or pin it, nothing was changed',
    {
      fix: `Copy that snapshot into ${expected} (same file name) and re-run; the markers are re-pointed at it.`,
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
  const { path } = resolveStoreSnapshot(probe.snapshot, dbPath);
  if (!existsSync(path)) throw missingSnapshot(path);
  const snap = openCleoDbSnapshot(path, { readOnly: true, applyPragmas: false });
  try {
    return fn(planTwinCollapseRecovery(live, snap.db, { snapshotPath: path }));
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
 * plan, and an apply refuses it unless `pinSnapshot` pins it first. A moved
 * store's snapshot is found by file name in its own backup directory; an
 * apply re-points the markers and appends a row to
 * `.cleo/audit/twin-collapse-repoint.jsonl` (T12788). No network.
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
  const auditFile = join(dirname(dbPath), 'audit', TWIN_COLLAPSE_REPOINT_AUDIT_FILE);
  return withRecoverySnapshot(live, dbPath, (preview) => ({
    dbPath,
    dryRun,
    ...applyTwinCollapseRecovery(live, preview, (repoint) => {
      mkdirSync(dirname(auditFile), { recursive: true });
      appendFileSync(
        auditFile,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          operation: 'doctor twin-collapse --recover',
          from: repoint.from,
          to: repoint.to,
          markers: repoint.markers,
          cwd: resolve(options.cwd),
          pid: process.pid,
        })}\n`,
      );
    }),
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
