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
import type { DatabaseSync } from 'node:sqlite';
import type { DualScope } from '../dual-scope-db.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import {
  clearExodusAborts,
  type ExodusAbortDetail,
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
  const { orderTablesForCopy } = await import('./table-order.js');
  const { buildRuntimeTargetResolver } = await import('./runtime-targets.js');
  const resolveTarget = await buildRuntimeTargetResolver();
  const sources: string[] = [];
  const tables = new Set<string>();
  for (const source of buildExodusPlan(cwd).sources) {
    if (source.targetScope !== scope || !existsSync(source.path)) continue;
    if (!legacySourcesHoldRows([source])) continue;
    sources.push(source.name);
    const snap = openCleoDbSnapshot(source.path, { readOnly: true });
    try {
      for (const table of orderTablesForCopy(snap.db)) {
        const target = resolveTarget(source.name, table);
        if (target.kind === 'mapped') tables.add(target.targetName);
      }
    } finally {
      snap.close();
    }
  }
  return { sources, tables: [...tables].sort() };
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
 * `<code>: <message>` while the scope's anchor table is empty, and register the
 * guard. The code follows `guard.detail.kind`: `E_EXODUS_DEFERRED_WRITE_UNSAFE`
 * or `E_EXODUS_ABORT_WRITE_UNSAFE`.
 *
 * Each trigger fires only `WHEN NOT EXISTS (SELECT 1 FROM main.<anchor>)`: once
 * any connection (another process, the migration itself) fills the anchor, the
 * guard stops refusing on its own, so a long-lived process recovers without a
 * restart. Tables absent from the consolidated schema (another scope's) are
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
  if (previous !== undefined) dropGuardTriggers(nativeDb, previous);
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
  const guarded: string[] = [];
  for (const table of guard.tables) {
    if (!present.has(table)) continue;
    nativeDb.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS ${sqlIdent(guardTriggerName(table))} ` +
        `BEFORE INSERT ON main.${sqlIdent(table)} ` +
        `WHEN NOT EXISTS (SELECT 1 FROM main.${sqlIdent(guard.anchor)}) ` +
        `BEGIN SELECT RAISE(ABORT, ${raise}); END`,
    );
    guarded.push(table);
  }
  const registered: ExodusWriteGuard = { ...guard, tables: guarded };
  activeGuards.set(nativeDb, registered);
  return registered;
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
  return activeGuards.get(nativeDb);
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
  const guard = activeGuards.get(nativeDb);
  if (guard === undefined) return undefined;
  if (!nativeDb.isOpen) {
    activeGuards.delete(nativeDb);
    return undefined;
  }
  const populated =
    nativeDb.prepare(`SELECT 1 AS present FROM main.${sqlIdent(guard.anchor)} LIMIT 1`).get() !==
    undefined;
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
