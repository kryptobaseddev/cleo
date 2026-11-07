/**
 * Full-store snapshots taken before an in-place repair or migration of the
 * project `cleo.db`.
 *
 * The repairs that run while a domain binds (the T12346 legacy-lineage
 * rebuild, the T12535 twin collapses) are synchronous and run before any
 * caller sees the handle, so they cannot use the async, debounced snapshot
 * gate (`snapshot-gate.ts`): a `routine` request inside the debounce window
 * would be skipped, and a skipped snapshot is exactly the case a repair must
 * never proceed under. They take one unconditional `VACUUM INTO` instead,
 * the same primitive the gate's snapshots use.
 *
 * {@link writeMigrationSnapshot} additionally registers the snapshot as a
 * `migration` system backup (`.cleo/backups/sqlite/cleo.db.<backupId>` plus a
 * `<backupId>.meta.json` sidecar), so `cleo backup list` shows it and the
 * per-type rotation applies, and checks the free space BEFORE writing: the
 * snapshot costs the whole store.
 *
 * @module
 * @task T12346
 * @task T12535
 * @task T14268
 */

import { existsSync, mkdirSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { getLogger } from '../logger.js';
import {
  applyBackupByteCap,
  formatBackupTimestamp,
  rotateBackupDir,
  writeBackupSidecar,
} from './backup-sidecar.js';
import {
  MIGRATIONS_TABLE,
  MigrationSnapshotRequiredError,
  pendingHasDataDml,
} from './migration-runner.js';

/**
 * Write a `VACUUM INTO` snapshot of the whole database next to it, under
 * `<dir of dbPath>/backups/cleo-pre-<label>-<timestamp>.db`.
 *
 * Throws when the snapshot cannot be written, so the caller never repairs
 * without it. Must run outside a transaction (`VACUUM INTO` requires it).
 *
 * @param nativeDb - Connection on the database to snapshot.
 * @param dbPath - Path of that database file (locates the backup directory).
 * @param label - Short kebab-case tag naming the repair.
 * @returns The snapshot's absolute path.
 * @task T12346
 */
export function writePreRepairSnapshot(
  nativeDb: DatabaseSync,
  dbPath: string,
  label: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(dirname(dbPath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const snapshotPath = join(backupDir, `cleo-pre-${label}-${stamp}.db`);
  nativeDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  return snapshotPath;
}

/** Headroom kept free beyond the snapshot itself (SQLite temp files, WAL growth). */
const SNAPSHOT_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Where a migration snapshot goes and what it costs. */
export interface MigrationSnapshotPlan {
  /** `.cleo/backups/sqlite/` of the store. */
  readonly backupDir: string;
  /** System-backup id (`migration-YYYYMMDD-HHmmss[-n]`). */
  readonly backupId: string;
  /** Absolute path the snapshot file will have. */
  readonly snapshotPath: string;
  /** Bytes the snapshot needs, plus headroom. */
  readonly requiredBytes: number;
  /** Bytes free on the backup filesystem, or `null` when it cannot be measured. */
  readonly availableBytes: number | null;
}

/** Nearest existing ancestor of a path (`statfs` needs an existing path). */
function existingAncestor(path: string): string {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

/**
 * Plan a migration snapshot without writing anything: its path and id, the
 * space it needs (live pages × page size, plus headroom) and the space free.
 *
 * @param nativeDb - Connection on the store.
 * @param dbPath - Path of the store file.
 * @returns The plan.
 * @task T12535
 */
export function planMigrationSnapshot(
  nativeDb: DatabaseSync,
  dbPath: string,
): MigrationSnapshotPlan {
  const backupDir = join(dirname(dbPath), 'backups', 'sqlite');
  const pragma = (name: string): number =>
    Number((nativeDb.prepare(`PRAGMA main.${name}`).get() as Record<string, number>)[name] ?? 0);
  const liveBytes = (pragma('page_count') - pragma('freelist_count')) * pragma('page_size');
  let availableBytes: number | null = null;
  try {
    const fs = statfsSync(existingAncestor(backupDir));
    availableBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    availableBytes = null;
  }
  const base = `migration-${formatBackupTimestamp(new Date())}`;
  let backupId = base;
  for (let n = 2; existsSync(join(backupDir, `${backupId}.meta.json`)); n++) {
    backupId = `${base}-${n}`;
  }
  return {
    backupDir,
    backupId,
    snapshotPath: join(backupDir, `cleo.db.${backupId}`),
    requiredBytes: liveBytes + SNAPSHOT_HEADROOM_BYTES,
    availableBytes,
  };
}

/**
 * Take a planned migration snapshot: check the space, create the backup
 * directory, `VACUUM INTO` the snapshot, write its sidecar, rotate the
 * `migration` type.
 *
 * Throws, before writing anything, when the free space is below
 * {@link MigrationSnapshotPlan.requiredBytes} or the backup directory cannot
 * be created. Must run outside a transaction.
 *
 * @param nativeDb - Connection on the store.
 * @param plan - From {@link planMigrationSnapshot}.
 * @param note - Shown by `cleo backup list`.
 * @param options - `pinnedReason`: pin the snapshot (never rotated) and say why.
 * @returns The snapshot's absolute path.
 * @task T12535
 */
export function writeMigrationSnapshot(
  nativeDb: DatabaseSync,
  plan: MigrationSnapshotPlan,
  note: string,
  options: { readonly pinnedReason?: string } = {},
): string {
  if (plan.availableBytes !== null && plan.availableBytes < plan.requiredBytes) {
    throw new Error(
      `not enough free space for the snapshot: ${plan.requiredBytes} bytes needed, ` +
        `${plan.availableBytes} free under ${plan.backupDir}`,
    );
  }
  mkdirSync(plan.backupDir, { recursive: true });
  nativeDb.exec(`VACUUM INTO '${plan.snapshotPath.replace(/'/g, "''")}'`);
  writeBackupSidecar(plan.backupDir, {
    backupId: plan.backupId,
    type: 'migration',
    timestamp: new Date().toISOString(),
    note,
    files: ['cleo.db'],
    ...(options.pinnedReason !== undefined
      ? { pinned: true, pinnedReason: options.pinnedReason }
      : {}),
  });
  rotateBackupDir(plan.backupDir, 10, 'migration');
  // T14278: the directory-wide byte cap; this snapshot is the newest and stays.
  applyBackupByteCap(plan.backupDir);
  return plan.snapshotPath;
}

/** What {@link snapshotBeforePendingMigrations} did. */
export type PreMigrationSnapshotOutcome =
  | { readonly kind: 'snapshot'; readonly path: string }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * The pre-migration snapshot of a project `cleo.db` (T14268): one `migration`
 * system backup (`cleo.db.migration-<stamp>` plus its sidecar) before the
 * first pending migration runs. It runs from the runner's
 * `beforePendingMigrations` hook, inside the cold-open lease, so concurrent
 * opens of a store mid-upgrade take one snapshot: the second process finds
 * the lineage at head and runs no hook.
 *
 * When the snapshot cannot be written, a pending set with data DML
 * ({@link pendingHasDataDml}) is refused with
 * {@link MigrationSnapshotRequiredError}; a schema-only set proceeds with a
 * warning. An in-memory store, and a new store no migration has run on
 * yet, hold nothing to keep and are skipped.
 *
 * @param nativeDb - Connection on the store, outside any transaction.
 * @param dbPath - Path of the store file.
 * @param pending - The pending migration files.
 * @returns What was done.
 * @task T14268
 */
export function snapshotBeforePendingMigrations(
  nativeDb: DatabaseSync,
  dbPath: string,
  pending: readonly MigrationMeta[],
): PreMigrationSnapshotOutcome {
  if (dbPath === '' || dbPath === ':memory:' || !isAbsolute(dbPath)) {
    return { kind: 'skipped', reason: 'in-memory store' };
  }
  const journaled = nativeDb
    .prepare("SELECT 1 AS found FROM main.sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE)
    ? nativeDb.prepare(`SELECT count(*) AS n FROM main."${MIGRATIONS_TABLE}"`).get()
    : undefined;
  if (Number((journaled as { n?: number } | undefined)?.n ?? 0) === 0) {
    return { kind: 'skipped', reason: 'new store: no migration has run, so no data to keep' };
  }
  const names = pending.map((m) => m.name ?? m.hash);
  try {
    const plan = planMigrationSnapshot(nativeDb, dbPath);
    const path = writeMigrationSnapshot(nativeDb, plan, `before migrations: ${names.join(', ')}`);
    return { kind: 'snapshot', path };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // @sync-invariant none:local-only a schema upgrade with data DML is refused locally without its snapshot; nothing is written
    if (pendingHasDataDml(pending)) throw new MigrationSnapshotRequiredError(names, reason);
    getLogger('migration-snapshot').warn(
      { dbPath, migrations: names, reason },
      'pre-migration snapshot failed; schema-only migrations proceed without it (T14268)',
    );
    return { kind: 'skipped', reason };
  }
}
