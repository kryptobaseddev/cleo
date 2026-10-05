/**
 * Restore the live project `cleo.db` from a named snapshot or a backup id,
 * safely (T13240). The project store holds the tasks AND the brain tables
 * (`tasks.db` and `brain.db` are only labels on older backups), so this one
 * restore covers both.
 *
 * The order is what makes it safe:
 *
 * 1. Resolve the source: a snapshot file under this project's
 *    `.cleo/backups/` (another location only with `allowExternal`), or the
 *    store file of a backup id (`.cleo/backups/sqlite/<id>.meta.json`). A
 *    snapshot with a non-empty `-wal` beside it is refused: its newest
 *    commits are not in the file.
 * 2. Copy it to a private file next to the live store and verify the COPY
 *    (what is placed is exactly what was checked): a SQLite header,
 *    `PRAGMA integrity_check` = ok, and a project store's shape.
 * 3. Refuse while anything else uses the live store: this process's handles
 *    are closed first, then any live writer lease of another process, or any
 *    other connection holding the file open, refuses (re-checked under the
 *    first-open lock that a store's first open also takes).
 * 4. Under that lock, keep the replaced store: copy it (with its `-wal`),
 *    fold the WAL into the copy, and list it as a `pre-restore-*` backup, so
 *    `--id` undoes the restore.
 * 5. Remove the live `-wal`/`-shm`/`-journal` (they belong to the replaced
 *    file), rename the verified copy over `cleo.db`, and check the result.
 *
 * Residual: a process that opens the store between the check under the lock
 * and the rename (milliseconds; a first open waits on the same lock).
 *
 * @task T13240
 * @module store/restore-store
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  StoreRestoreKept,
  StoreRestoreResult,
  StoreRestoreSource,
  StoreRestoreVerification,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { formatBackupTimestamp } from './backup-sidecar.js';
import { resolveDualScopeDbPath } from './dual-scope-db.js';
import { withLock } from './lock.js';
import { openCleoDbSnapshot } from './open-cleo-db.js';
import { writeRestoreMarker } from './restore-marker.js';
import { assertRestoreTargetConfirmed } from './worktree-isolation-guard.js';
import { foreignWriterLeases, storeOpenElsewhere } from './writer-lease.js';

/** Options of {@link restoreStoreSnapshot}. Exactly one of `snapshot` and `backupId`. */
export interface StoreRestoreOptions {
  /** The project whose `.cleo/cleo.db` is restored (project scope). */
  readonly projectRoot: string;
  /**
   * `project` (default): the project's `.cleo/cleo.db` (tasks and brain).
   * `global`: `<CLEO_HOME>/cleo.db`, the global store (global brain, nexus,
   * agent registry), with its backups under `<CLEO_HOME>/backups/` (T13245).
   */
  readonly scope?: 'project' | 'global';
  /** A snapshot file (a `VACUUM INTO` copy, e.g. `cleo-identity-refill-*.db` or `tasks-*.db`). */
  readonly snapshot?: string;
  /** A backup id from `cleo backup list`. */
  readonly backupId?: string;
  /** Verify and report, write nothing. */
  readonly dryRun?: boolean;
  /** Accept a snapshot outside this project's `.cleo/backups/` (another store's file). */
  readonly allowExternal?: boolean;
  /** From a git worktree: allow overwriting the owning project's live store. */
  readonly confirmOwnerStore?: boolean;
  /** The invocation directory (the worktree guard; core never falls back to `process.cwd()`). */
  readonly cwd: string;
  /**
   * When the live store cannot even be read (a damaged file), whether another
   * process uses it cannot be checked: proceed only with this, the operator's
   * statement that every cleo process is stopped (`--force`). It never
   * overrides a live writer that WAS detected.
   */
  readonly assumeStoppedIfUnverifiable?: boolean;
  /** Clock (tests). */
  readonly now?: Date;
  /**
   * Called inside the swap window, after the live sidecars are removed and
   * before the rename, with the marker held (tests: a racing open).
   *
   * @internal
   */
  readonly beforeSwap?: () => void;
}

/** A project store's file sidecars, in the order SQLite reads them. */
const SIDECARS = ['-wal', '-shm', '-journal'] as const;

/** Backup ids are plain names: no separators, no traversal. */
const BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Store-file labels a backup may carry, newest name first; all hold the same file. */
const STORE_LABELS = ['cleo.db', 'tasks.db', 'brain.db'] as const;

const SQLITE_HEADER = 'SQLite format 3\u0000';

function restoreError(code: ExitCode, id: string, message: string, fix?: string): CleoError {
  // @sync-invariant none:local-only a refused restore of the whole local store file; no synced row is written
  return new CleoError(code, `${id}: ${message}`, fix ? { fix } : undefined);
}

/** Whether `child` is `parent` or inside it (both resolved). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolve the source file: a named snapshot, or the store file of a backup id. */
function resolveSource(opts: StoreRestoreOptions, cleoDir: string): StoreRestoreSource {
  const backups = join(cleoDir, 'backups');
  if ((opts.snapshot === undefined) === (opts.backupId === undefined)) {
    // @sync-invariant none:input-shape exactly one restore source must be named
    throw restoreError(
      ExitCode.INVALID_INPUT,
      'E_RESTORE_SOURCE',
      'name exactly one source: --snapshot <file> or --id <backupId>',
    );
  }
  if (opts.backupId !== undefined) {
    const id = opts.backupId;
    if (!BACKUP_ID.test(id)) {
      // @sync-invariant none:input-shape a backup id is a plain name
      throw restoreError(ExitCode.INVALID_INPUT, 'E_RESTORE_SOURCE', `invalid backup id: ${id}`);
    }
    const dir = join(backups, 'sqlite');
    if (!existsSync(join(dir, `${id}.meta.json`))) {
      // @sync-invariant none:input-shape no such backup
      throw restoreError(
        ExitCode.NOT_FOUND,
        'E_RESTORE_SOURCE',
        `backup not found: ${id}`,
        'list them with `cleo backup list`',
      );
    }
    const file = STORE_LABELS.map((label) => join(dir, `${label}.${id}`)).find((p) =>
      existsSync(p),
    );
    if (!file) {
      // @sync-invariant none:input-shape the backup holds no store file
      throw restoreError(
        ExitCode.NOT_FOUND,
        'E_RESTORE_SOURCE',
        `backup ${id} holds no store file (${STORE_LABELS.map((l) => `${l}.${id}`).join(', ')})`,
      );
    }
    return { kind: 'backup', path: file, backupId: id };
  }
  const named = resolve(opts.cwd, String(opts.snapshot));
  if (!existsSync(named) || !statSync(named).isFile()) {
    // @sync-invariant none:input-shape the named snapshot does not exist
    throw restoreError(ExitCode.NOT_FOUND, 'E_RESTORE_SOURCE', `no snapshot file at ${named}`);
  }
  const real = realpathSync(named);
  const inBackups = existsSync(backups) && isInside(realpathSync(backups), real);
  if (!inBackups && opts.allowExternal !== true) {
    // @sync-invariant none:input-shape a file outside this project's backups may be another store
    throw restoreError(
      ExitCode.INVALID_INPUT,
      'E_RESTORE_EXTERNAL',
      `${real} is not under ${backups}; it may be another project's store`,
      'pass --allow-external if this file really is a snapshot of this project',
    );
  }
  return { kind: 'snapshot', path: real, backupId: null };
}

/** Refuse a snapshot whose own WAL holds commits the file lacks. */
function assertSelfContained(source: string): void {
  const wal = `${source}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    // @sync-invariant none:input-shape a snapshot with a live WAL is incomplete
    throw restoreError(
      ExitCode.VALIDATION_ERROR,
      'E_RESTORE_SNAPSHOT_INCOMPLETE',
      `${source} has a non-empty ${basename(wal)}: its newest commits are not in the file`,
      'restore from a VACUUM INTO snapshot (cleo backup add), or checkpoint the copy first',
    );
  }
}

/** Whether `file` starts with the SQLite header. */
function hasSqliteHeader(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf.toString('latin1') === SQLITE_HEADER;
  } finally {
    closeSync(fd);
  }
}

/**
 * Verify a snapshot file read-only: the header, `PRAGMA integrity_check`, and
 * a project store's shape (`tasks_tasks`). Throws on any failure.
 */
function verifySnapshot(
  file: string,
  scope: 'project' | 'global' = 'project',
): StoreRestoreVerification {
  const sizeBytes = statSync(file).size;
  if (sizeBytes === 0 || !hasSqliteHeader(file)) {
    // @sync-invariant none:input-shape not a SQLite database
    throw restoreError(
      ExitCode.VALIDATION_ERROR,
      'E_RESTORE_SNAPSHOT_CORRUPT',
      `${file} is not a SQLite database (${sizeBytes} bytes, no header)`,
    );
  }
  let snap: ReturnType<typeof openCleoDbSnapshot> | undefined;
  try {
    snap = openCleoDbSnapshot(file, { readOnly: true, applyPragmas: false });
    const rows = snap.db.prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check: string;
    }>;
    const integrity = rows.map((r) => r.integrity_check).join('; ');
    if (integrity !== 'ok') {
      // @sync-invariant none:input-shape the snapshot fails its integrity check
      throw restoreError(
        ExitCode.VALIDATION_ERROR,
        'E_RESTORE_SNAPSHOT_CORRUPT',
        `${file} fails integrity_check: ${integrity.slice(0, 500)}`,
      );
    }
    const db = snap.db;
    const has = (table: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
      undefined;
    // A project store holds the task tables; the global store holds the
    // nexus registry and no task tables. Neither is ever placed as the other.
    const shaped =
      scope === 'project'
        ? has('tasks_tasks')
        : has('nexus_project_registry') && !has('tasks_tasks');
    if (!shaped) {
      // @sync-invariant none:input-shape not a store of this scope
      throw restoreError(
        ExitCode.VALIDATION_ERROR,
        'E_RESTORE_SNAPSHOT_SHAPE',
        scope === 'project'
          ? `${file} is not a project cleo.db (no tasks_tasks table)`
          : `${file} is not the global cleo.db (no nexus_project_registry table, or it holds task tables)`,
      );
    }
    const tasks = has('tasks_tasks')
      ? (db.prepare('SELECT count(*) AS n FROM tasks_tasks').get() as { n: number }).n
      : 0;
    return { integrity, tasks, sizeBytes };
  } catch (err) {
    if (err instanceof CleoError) throw err;
    // @sync-invariant none:input-shape the snapshot cannot be read as a database
    throw restoreError(
      ExitCode.VALIDATION_ERROR,
      'E_RESTORE_SNAPSHOT_CORRUPT',
      `${file} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    snap?.close();
  }
}

/**
 * Refuse while another process uses the live store. This process's own
 * handles are closed first.
 */
async function assertQuiescent(target: string, assumeStoppedIfUnverifiable = false): Promise<void> {
  const { closeAllDatabases } = await import('./sqlite.js');
  await closeAllDatabases();
  const { _resetDualScopeDbCache } = await import('./dual-scope-db.js');
  _resetDualScopeDbCache();
  if (!existsSync(target)) return;
  let held: ReturnType<typeof foreignWriterLeases>;
  let open: boolean;
  try {
    held = foreignWriterLeases(target);
    open = storeOpenElsewhere(target);
  } catch (err) {
    // A damaged live store cannot be probed; the operator vouched that
    // every cleo process is stopped.
    if (assumeStoppedIfUnverifiable) return;
    // @sync-invariant none:local-only the liveness of the store cannot be checked; nothing is written
    throw restoreError(
      ExitCode.LOCK_TIMEOUT,
      'E_RESTORE_STORE_BUSY',
      `cannot check whether another process uses ${target}: ${err instanceof Error ? err.message : String(err)}`,
      'stop every cleo process (sessions, daemons, agents), then run it again with --force',
    );
  }
  if (held.length > 0) {
    // @sync-invariant none:local-only another process holds a writer lease; nothing is written
    throw restoreError(
      ExitCode.LOCK_TIMEOUT,
      'E_RESTORE_STORE_BUSY',
      `another cleo process is writing to ${target} (${held.map((h) => `${h.lane} lane, pid ${h.holderPid}`).join('; ')}); restoring now would lose its writes`,
      'wait for it to finish (or stop it), then run it again',
    );
  }
  if (open) {
    // @sync-invariant none:local-only another connection holds the store open; nothing is written
    throw restoreError(
      ExitCode.LOCK_TIMEOUT,
      'E_RESTORE_STORE_BUSY',
      `another process has ${target} open (a cleo session, daemon or tool); it would keep writing to the replaced store`,
      'close it (end the session, `cleo daemon stop`), then run it again',
    );
  }
}

/** Copy `from` to `to` and flush it to disk. */
function copyDurable(from: string, to: string): void {
  copyFileSync(from, to);
  const fd = openSync(to, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Keep the live store before it is replaced: copy it with its sidecars, fold
 * the WAL into the copy (a writable private copy, so the live file is never
 * opened), and list it as a backup so `--id` restores it.
 */
function keepLiveStore(target: string, sqliteDir: string, now: Date): StoreRestoreKept {
  mkdirSync(sqliteDir, { recursive: true });
  let backupId = `pre-restore-${formatBackupTimestamp(now)}`;
  for (let n = 2; existsSync(join(sqliteDir, `${backupId}.meta.json`)); n++) {
    backupId = `pre-restore-${formatBackupTimestamp(now)}-${n}`;
  }
  const kept = join(sqliteDir, `cleo.db.${backupId}`);
  copyDurable(target, kept);
  for (const s of SIDECARS) {
    if (existsSync(target + s)) copyDurable(target + s, kept + s);
  }
  let checkpointed = false;
  let db: DatabaseSync | undefined;
  try {
    db = openCleoDbSnapshot(kept, { readOnly: false, applyPragmas: false }).db;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = undefined;
    checkpointed = true;
  } catch {
    // A damaged live store: its raw files are kept as they are.
  } finally {
    db?.close();
  }
  // After a clean checkpoint the copy is self-contained; its sidecars go.
  const sidecars: string[] = [];
  for (const s of SIDECARS) {
    const p = kept + s;
    if (!existsSync(p)) continue;
    if (checkpointed) rmSync(p, { force: true });
    else {
      // Named so the backup list treats them as part of this backup.
      const named = join(sqliteDir, `cleo.db${s}.${backupId}`);
      renameSync(p, named);
      sidecars.push(named);
    }
  }
  writeFileSync(
    join(sqliteDir, `${backupId}.meta.json`),
    `${JSON.stringify(
      {
        backupId,
        type: 'pre-restore',
        timestamp: now.toISOString(),
        note: `the live cleo.db replaced by a restore (T13240)${checkpointed ? '' : '; its WAL could not be folded in, raw sidecars kept'}`,
        files: ['cleo.db'],
        pinned: true,
        pinnedReason: 'undo of a store restore',
      },
      null,
      2,
    )}\n`,
  );
  return { backupId, path: kept, checkpointed, sidecars };
}

/**
 * Restore the live project `cleo.db` from a named snapshot or a backup id
 * (T13240). See the module comment for the order of the steps.
 *
 * @param opts - The source, the project and the guards.
 * @returns What was verified, kept and placed (or would be, on a dry run).
 * @throws {CleoError} `E_RESTORE_SOURCE`, `E_RESTORE_EXTERNAL`,
 *   `E_RESTORE_SNAPSHOT_INCOMPLETE`, `E_RESTORE_SNAPSHOT_CORRUPT`,
 *   `E_RESTORE_SNAPSHOT_SHAPE`, `E_RESTORE_STORE_BUSY`, or the worktree guard's refusal.
 * @task T13240
 */
export async function restoreStoreSnapshot(opts: StoreRestoreOptions): Promise<StoreRestoreResult> {
  const scope = opts.scope ?? 'project';
  const target =
    scope === 'project'
      ? resolveDualScopeDbPath('project', opts.projectRoot)
      : resolveDualScopeDbPath('global');
  const cleoDir = dirname(target);
  const source = resolveSource(opts, cleoDir);
  const live = existsSync(target) ? realpathSync(target) : target;
  if ([live, ...SIDECARS.map((x) => live + x)].includes(source.path)) {
    // @sync-invariant none:input-shape the live store cannot be its own snapshot
    throw restoreError(ExitCode.INVALID_INPUT, 'E_RESTORE_SOURCE', 'the source is the live store');
  }
  assertSelfContained(source.path);
  if (opts.dryRun === true) {
    return {
      dryRun: true,
      scope,
      restored: false,
      target,
      source,
      verification: verifySnapshot(source.path, scope),
      kept: null,
      removedSidecars: [],
      undo: null,
    };
  }
  // A worktree may hold its own project store, never its own global one.
  if (scope === 'project') {
    assertRestoreTargetConfirmed(opts.projectRoot, {
      cwd: opts.cwd,
      confirmOwnerStore: opts.confirmOwnerStore,
    });
  }
  // The private copy is what gets verified and placed.
  mkdirSync(cleoDir, { recursive: true });
  const staged = `${target}.restore-${process.pid}-${Date.now()}`;
  copyDurable(source.path, staged);
  try {
    const verification = verifySnapshot(staged, scope);
    await assertQuiescent(target, opts.assumeStoppedIfUnverifiable === true);
    const now = opts.now ?? new Date();
    const sqliteDir = join(cleoDir, 'backups', 'sqlite');
    const { FIRST_OPEN_LOCK_SUFFIX } = await import('./sqlite.js');
    const placed = await withLock(
      `${target}${FIRST_OPEN_LOCK_SUFFIX}`,
      async (): Promise<{ kept: StoreRestoreKept | null; removed: string[] }> => {
        // T13258: from here until the swap is done, every store open (they
        // never take this lock) waits on, then refuses, this marker.
        const release = writeRestoreMarker(target, 'restore');
        try {
          await assertQuiescent(target, opts.assumeStoppedIfUnverifiable === true);
          const kept = existsSync(target) ? keepLiveStore(target, sqliteDir, now) : null;
          const removed: string[] = [];
          for (const s of SIDECARS) {
            if (existsSync(target + s)) {
              unlinkSync(target + s);
              removed.push(target + s);
            }
          }
          opts.beforeSwap?.();
          renameSync(staged, target);
          assertNoStraySidecars(target, kept);
          return { kept, removed };
        } finally {
          release();
        }
      },
    );
    // The placed file is the verified copy; check it reads in place.
    const after = verifySnapshot(target, scope);
    getLogger('store-restore').warn(
      { target, source: source.path, kept: placed.kept?.path ?? null, tasks: after.tasks },
      `${scope} store restored from a snapshot (T13240)`,
    );
    return {
      dryRun: false,
      scope,
      restored: true,
      target,
      source,
      verification,
      kept: placed.kept,
      removedSidecars: placed.removed,
      undo: placed.kept
        ? `cleo restore backup${scope === 'global' ? ' --scope global' : ''} --id ${placed.kept.backupId}`
        : null,
    };
  } finally {
    // Verifying a WAL-mode copy can leave its own sidecars beside it.
    for (const p of [staged, ...SIDECARS.map((x) => staged + x)]) rmSync(p, { force: true });
  }
}

/**
 * After the swap, still under the marker: a `-wal`/`-shm`/`-journal` beside
 * the restored file was created by something that opened the OLD file inside
 * the window (the restore removed every sidecar before the rename). Its pages
 * belong to the replaced database, so it is removed before anything reads the
 * restored file, and the restore fails loudly (T13258).
 */
function assertNoStraySidecars(target: string, kept: StoreRestoreKept | null): void {
  const stray = SIDECARS.map((s) => target + s).filter((p) => existsSync(p));
  if (stray.length === 0) return;
  for (const p of stray) rmSync(p, { force: true });
  // @sync-invariant none:local-only a raced local store swap; the stray sidecars of the replaced file are removed, no synced row is written
  throw restoreError(
    ExitCode.CONCURRENT_MODIFICATION,
    'E_RESTORE_RACED',
    `another process opened ${target} during the swap and left ${stray.map((p) => basename(p)).join(', ')} (removed: they belong to the replaced store)`,
    `stop every cleo process, run \`PRAGMA integrity_check\` on the store (cleo doctor), and re-run the restore${kept ? `; the replaced store is kept as backup ${kept.backupId}` : ''}`,
  );
}
