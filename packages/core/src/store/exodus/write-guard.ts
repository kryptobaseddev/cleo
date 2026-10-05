/**
 * Write guard for a store that still owes its legacy migration (T13158, T13167).
 *
 * Exodus-on-open migrates the legacy `tasks.db` / `brain.db` / `nexus.db` rows
 * into the consolidated `cleo.db`. When that migration is DEFERRED (the governor
 * could not admit it) or ABORTED (parity failure, assessment failure, plan
 * mismatch, a completion marker contradicted by legacy rows), the open still
 * returns a live handle on the EMPTY store so the command can run. A write
 * through it used to strand the legacy data for good: a row in the scope's
 * anchor table makes the store "populated", and on-open never migrates a
 * populated store. A row in any other table the migration fills can collide
 * with a legacy row's key, and the migration's copy keeps the new row.
 *
 * {@link installExodusWriteGuard} closes that window. Each consolidated table
 * the migration would fill gets a `TEMP` trigger that refuses INSERTs with
 * `E_EXODUS_DEFERRED_WRITE_UNSAFE` or `E_EXODUS_ABORT_WRITE_UNSAFE` and the
 * remedy, while the anchor table is empty. A temp trigger lives only on its
 * connection and is never persisted, so later opens and the migration's own
 * dedicated connections never see it. Reads, and writes to tables the migration
 * does not fill, are untouched. The guard is registered per connection, so the
 * typed write checks ({@link activeExodusWriteGuard}) and the handle's
 * `exodusAbort` marker ({@link peekExodusWriteGuard}) read the same state.
 *
 * @task T13158
 * @task T13167
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DualScope } from '../dual-scope-db.js';
import {
  clearExodusAborts,
  type ExodusAbortDetail,
  exodusRefusalMessage,
  getRecordedExodusAbort,
} from './abort-events.js';

/** Stable error code a write refusal carries while the migration is deferred. */
export const EXODUS_DEFERRED_WRITE_CODE = 'E_EXODUS_DEFERRED_WRITE_UNSAFE';

/** Stable error code a write refusal carries after the migration aborted. */
export const EXODUS_ABORT_WRITE_CODE = 'E_EXODUS_ABORT_WRITE_UNSAFE';

/** The legacy data a pending migration still owes this scope. */
export interface PendingExodusTargets {
  /** Legacy sources of the scope that hold copyable rows (`tasks`, `brain`, …). */
  readonly sources: readonly string[];
  /** Consolidated tables a migration of those sources fills. */
  readonly tables: readonly string[];
  /**
   * For each table, the sentinels of the sources that fill it: per source, the
   * first table in copy order that has legacy rows. Each source is copied in
   * ONE transaction, so its sentinel holding rows means that source's copy
   * committed (T13171).
   */
  readonly sentinels: Readonly<Record<string, readonly string[]>>;
}

/**
 * The legacy sources of `scope` that still hold copyable rows, and every
 * consolidated table a migration of them would fill.
 *
 * Reads the legacy files read-only. Called only on a deferred open of an empty
 * store whose legacy sources exist, never on a normal open.
 *
 * @param scope - The scope whose migration was deferred.
 * @param cwd - Working directory used to resolve the project root.
 * @returns The pending sources and target tables; both empty when the legacy
 *   files hold no copyable rows (nothing to protect).
 */
export async function pendingExodusTargets(
  scope: DualScope,
  cwd: string | undefined,
): Promise<PendingExodusTargets> {
  const { buildExodusPlan, legacySourcesHoldRows } = await import('./index.js');
  // Loaded here, not at module scope: open-cleo-db imports dual-scope-db,
  // which imports this module, and a static edge would close that cycle.
  const { openCleoDbSnapshot } = await import('../open-cleo-db.js');
  const { orderTablesForCopy } = await import('./table-order.js');
  const { buildRuntimeTargetResolver } = await import('./runtime-targets.js');
  const resolveTarget = await buildRuntimeTargetResolver();
  const sources: string[] = [];
  const tables = new Set<string>();
  const sentinels: Record<string, string[]> = {};
  for (const source of buildExodusPlan(cwd).sources) {
    if (source.targetScope !== scope || !existsSync(source.path)) continue;
    if (!legacySourcesHoldRows([source])) continue;
    sources.push(source.name);
    const snap = openCleoDbSnapshot(source.path, { readOnly: true });
    try {
      const filled: string[] = [];
      let sentinel: string | null = null;
      for (const table of orderTablesForCopy(snap.db)) {
        const target = resolveTarget(source.name, table);
        if (target.kind !== 'mapped') continue;
        tables.add(target.targetName);
        filled.push(target.targetName);
        if (sentinel === null && legacyTableHasRows(snap.db, table)) sentinel = target.targetName;
      }
      if (sentinel !== null) {
        for (const table of filled) {
          const list = sentinels[table] ?? [];
          if (!list.includes(sentinel)) list.push(sentinel);
          sentinels[table] = list;
        }
      }
    } finally {
      snap.close();
    }
  }
  return { sources, tables: [...tables].sort(), sentinels };
}

/** Whether a legacy table holds a row (an unreadable table counts as empty). */
function legacyTableHasRows(db: DatabaseSync, table: string): boolean {
  try {
    return db.prepare(`SELECT 1 AS present FROM ${sqlIdent(table)} LIMIT 1`).get() !== undefined;
  } catch {
    return false;
  }
}

/** A SQL string literal (single quotes doubled). */
function sqlString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** A SQL identifier (double quotes doubled). */
function sqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** An active guard on one connection. */
export interface ExodusWriteGuard {
  /** The scope's anchor table: its first row means the migration has run. */
  readonly anchor: string;
  /** Tables carrying a guard trigger. */
  readonly tables: readonly string[];
  /**
   * Per table, the sentinel tables whose rows mean every source filling it
   * has committed its copy ({@link PendingExodusTargets.sentinels}). A table
   * stays guarded until all of them hold rows, so no table accepts writes while
   * its own copy is pending (T13171). A table without sentinels waits on the
   * anchor. Fails closed: if a source's sentinel table is skipped or only
   * partly copied while its other tables commit, that source's tables stay
   * guarded on this connection until the process restarts (a later open
   * assesses afresh).
   */
  readonly sentinels?: Readonly<Record<string, readonly string[]>>;
  /** Legacy sources still holding the rows the migration owes. */
  readonly sources: readonly string[];
  /**
   * The scope's exodus completion marker. Its appearance means the cutover
   * sealed (in any process), even when the legacy held no rows for the anchor
   * table, so the guard lifts.
   */
  readonly markerPath: string | null;
  /**
   * The refusal detail the typed write checks raise and the handle reports as
   * `exodusAbort`. Its `kind` says whether the migration is deferred or aborted.
   */
  detail: ExodusAbortDetail;
}

/** Active guards, by connection: a guard lives exactly as long as its connection. */
const activeGuards = new WeakMap<DatabaseSync, ExodusWriteGuard>();

/** Name of the guard trigger on `table`. */
function guardTriggerName(table: string): string {
  return `cleo_exodus_guard_${table}`;
}

/**
 * Refuse INSERTs into `guard.tables` on this connection with
 * `<code>: <message>` while that table's own copy is pending (any of its
 * sentinels, else the scope's anchor, is empty), and register the guard. The code follows `guard.detail.kind`: `E_EXODUS_DEFERRED_WRITE_UNSAFE`
 * or `E_EXODUS_ABORT_WRITE_UNSAFE`.
 *
 * Each trigger fires only while one of its table's sentinels (or the anchor)
 * is empty: once the copy that fills the table commits (in another process, or
 * the migration itself), the trigger stops refusing on its own, so a
 * long-lived process recovers without a restart, and a table whose copy has
 * not committed yet keeps refusing even after the anchor has rows (T13171). Tables absent from the consolidated schema (another scope's) are
 * skipped. A guard already on the connection is replaced (a deferred migration
 * that then aborts changes kind and message).
 *
 * @param nativeDb - The handle's native connection.
 * @param guard - Anchor, candidate tables, sources, completion marker, detail.
 * @param message - Why the write is refused and how to fix it.
 * @returns The registered guard (its `tables` are the ones now guarded).
 */
export function installExodusWriteGuard(
  nativeDb: DatabaseSync,
  guard: ExodusWriteGuard,
  message: string,
): ExodusWriteGuard {
  const previous = activeGuards.get(nativeDb);
  const present = new Set(
    nativeDb
      .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const code =
    guard.detail.kind === 'deferred' ? EXODUS_DEFERRED_WRITE_CODE : EXODUS_ABORT_WRITE_CODE;
  const raise = sqlString(`${code}: ${message}`);
  // Replace atomically (#1839 review LOW): a failure part-way must leave the
  // previous guard's triggers in place, matching the registry.
  nativeDb.exec('SAVEPOINT cleo_exodus_guard');
  let guarded: string[];
  try {
    if (previous !== undefined) dropGuardTriggers(nativeDb, previous);
    guarded = createGuardTriggers(nativeDb, guard, present, raise);
    nativeDb.exec('RELEASE cleo_exodus_guard');
  } catch (error) {
    nativeDb.exec('ROLLBACK TO cleo_exodus_guard');
    nativeDb.exec('RELEASE cleo_exodus_guard');
    throw error;
  }
  const registered: ExodusWriteGuard = { ...guard, tables: guarded };
  activeGuards.set(nativeDb, registered);
  return registered;
}

/** Create the guard's triggers on every present table; returns the tables guarded. */
function createGuardTriggers(
  nativeDb: DatabaseSync,
  guard: ExodusWriteGuard,
  present: ReadonlySet<string>,
  raise: string,
): string[] {
  const guarded: string[] = [];
  for (const table of guard.tables) {
    if (!present.has(table)) continue;
    const pending = waitTables(guard, table, present)
      .map((t) => `NOT EXISTS (SELECT 1 FROM main.${sqlIdent(t)})`)
      .join(' OR ');
    nativeDb.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS ${sqlIdent(guardTriggerName(table))} ` +
        `BEFORE INSERT ON main.${sqlIdent(table)} ` +
        `WHEN ${pending} ` +
        `BEGIN SELECT RAISE(ABORT, ${raise}); END`,
    );
    guarded.push(table);
  }
  return guarded;
}

/**
 * The tables whose rows `table`'s guard waits for: its sentinels present in the
 * schema, else the anchor.
 */
function waitTables(
  guard: Pick<ExodusWriteGuard, 'anchor' | 'sentinels'>,
  table: string,
  present: ReadonlySet<string>,
): string[] {
  const own = (guard.sentinels?.[table] ?? []).filter((t) => present.has(t));
  return own.length > 0 ? own : [guard.anchor];
}

/** Every table some guarded table waits for (the guard is active while one is empty). */
function allWaitTables(nativeDb: DatabaseSync, guard: ExodusWriteGuard): string[] {
  const present = new Set(
    nativeDb
      .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const all = new Set<string>([guard.anchor]);
  for (const table of guard.tables) for (const t of waitTables(guard, table, present)) all.add(t);
  return [...all];
}

/** Drop a guard's triggers from `nativeDb` (when it is still open). */
function dropGuardTriggers(nativeDb: DatabaseSync, guard: ExodusWriteGuard): void {
  if (!nativeDb.isOpen) return;
  for (const table of guard.tables) {
    nativeDb.exec(`DROP TRIGGER IF EXISTS temp.${sqlIdent(guardTriggerName(table))}`);
  }
}

/**
 * The guard registered on `nativeDb`, without checking whether it should lift.
 * Backs the handle's `exodusAbort` marker, read on every access.
 *
 * @param nativeDb - A store connection.
 * @returns The registered guard, if any.
 */
export function peekExodusWriteGuard(nativeDb: DatabaseSync): ExodusWriteGuard | undefined {
  const guard = activeGuards.get(nativeDb);
  if (guard === undefined) return undefined;
  const newer = supersedingAbort(guard);
  return newer === undefined ? guard : { ...guard, detail: newer };
}

/**
 * A later ABORT recorded for the guard's scope, when the guard still says
 * `deferred` (T13171): a connection guarded while its migration waited for
 * admission (a handle published to concurrent opens) must report the abort
 * once that migration ran and aborted, not a deferral that is over.
 */
function supersedingAbort(guard: ExodusWriteGuard): ExodusAbortDetail | undefined {
  if (guard.detail.kind !== 'deferred') return undefined;
  const recorded = getRecordedExodusAbort(guard.detail.scope);
  // The same STORE, not just the same scope: a long-lived host (Studio, the
  // daemon) holds stores of several projects (#1880 review).
  return recorded !== undefined &&
    recorded.kind === 'aborted' &&
    recorded.at >= guard.detail.at &&
    resolve(recorded.dbPath) === resolve(guard.detail.dbPath)
    ? recorded
    : undefined;
}

/**
 * The guard active on `nativeDb`, or `undefined`. A guard whose anchor table
 * has rows (the migration ran, here or in another process), or a deferral whose
 * scope's completion marker exists, is lifted here and reported as absent.
 *
 * @param nativeDb - A store connection.
 * @returns The active guard, if the store is still waiting for its migration.
 */
export function activeExodusWriteGuard(nativeDb: DatabaseSync): ExodusWriteGuard | undefined {
  let guard = activeGuards.get(nativeDb);
  if (guard === undefined) return undefined;
  if (!nativeDb.isOpen) {
    activeGuards.delete(nativeDb);
    return undefined;
  }
  const newer = supersedingAbort(guard);
  if (newer !== undefined) {
    // The deferral ended in an abort (T13171): re-arm the triggers so their
    // refusal names the abort too.
    guard = installExodusWriteGuard(
      nativeDb,
      { ...guard, detail: newer },
      exodusRefusalMessage(newer.scope, newer.reason, 'aborted'),
    );
  }
  // Lifted only once every copy has committed: each guarded table's sentinels
  // (and the anchor) hold rows (T13171).
  const populated = allWaitTables(nativeDb, guard).every(
    (t) =>
      nativeDb.prepare(`SELECT 1 AS present FROM main.${sqlIdent(t)} LIMIT 1`).get() !== undefined,
  );
  // A completion marker ends a DEFERRAL (the cutover sealed elsewhere). An abort
  // can itself be a marker contradicted by legacy rows, so only rows end it.
  const sealed =
    guard.detail.kind === 'deferred' && guard.markerPath !== null && existsSync(guard.markerPath);
  if (!populated && !sealed) return guard;
  liftExodusWriteGuard(nativeDb);
  return undefined;
}

/**
 * Remove the guard from `nativeDb`: drop its triggers, forget it, and clear the
 * process record it set. Safe when no guard is active.
 *
 * @param nativeDb - A store connection.
 */
export function liftExodusWriteGuard(nativeDb: DatabaseSync): void {
  const guard = activeGuards.get(nativeDb);
  if (guard === undefined) return;
  activeGuards.delete(nativeDb);
  dropGuardTriggers(nativeDb, guard);
  if (getRecordedExodusAbort(guard.detail.scope) === guard.detail) {
    clearExodusAborts(guard.detail.scope);
  }
}
