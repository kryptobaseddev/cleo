/**
 * Write guard for a deferred exodus-on-open (T13158).
 *
 * When the governor cannot admit an exodus-on-open migration (memory pressure,
 * or `db-heavy`'s single machine-wide slot held by another heavy op), the open
 * still returns a live handle on the EMPTY consolidated `cleo.db`, so the
 * command can run. A write through that handle used to strand the legacy data
 * for good: a row in the scope's anchor table makes the store "populated", and
 * on-open never migrates a populated store. A row in any other table the
 * migration fills can collide with a legacy row's key, and the migration's
 * copy keeps the new row, not the legacy one.
 *
 * {@link installExodusDeferredGuard} closes that window. Each consolidated table
 * the pending migration would fill gets a `TEMP` trigger that refuses INSERTs
 * with `E_EXODUS_DEFERRED_WRITE_UNSAFE` and the remedy. A temp trigger lives
 * only on this connection and is never persisted, so the next open (or the
 * migration's own dedicated connections) never see it. Reads, and writes to
 * tables the migration does not fill, are untouched.
 *
 * @task T13158
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

/** Stable error code a deferred-exodus write refusal carries. */
export const EXODUS_DEFERRED_WRITE_CODE = 'E_EXODUS_DEFERRED_WRITE_UNSAFE';

/** The legacy data a deferred migration still owes this scope. */
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
export interface ExodusDeferredGuard {
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
  /** The refusal detail typed write guards raise (updated with the final reason). */
  detail: ExodusAbortDetail;
  /** Sets (or, on lift, clears) the opening handle's `exodusAbort` marker. */
  readonly setMarker: (detail: ExodusAbortDetail | undefined) => void;
}

/** Active guards, by connection: a guard lives exactly as long as its connection. */
const activeGuards = new WeakMap<DatabaseSync, ExodusDeferredGuard>();

/** Name of the guard trigger on `table`. */
function guardTriggerName(table: string): string {
  return `cleo_exodus_deferred_${table}`;
}

/**
 * Refuse INSERTs into `tables` on this connection with
 * `E_EXODUS_DEFERRED_WRITE_UNSAFE: <message>` while the scope's anchor table is
 * empty, and register the guard for {@link activeExodusDeferredGuard}.
 *
 * Each trigger fires only `WHEN NOT EXISTS (SELECT 1 FROM main.<anchor>)`: once
 * any connection (another process, the migration itself) fills the anchor, the
 * guard stops refusing on its own, so a long-lived process recovers without a
 * restart. Tables absent from the consolidated schema (another scope's) are
 * skipped. Idempotent per table.
 *
 * @param nativeDb - The published handle's native connection.
 * @param guard - Anchor, candidate tables, sources, refusal detail, marker setter.
 * @param message - Why the write is refused and how to fix it.
 * @returns The registered guard (its `tables` are the ones now guarded).
 */
export function installExodusDeferredGuard(
  nativeDb: DatabaseSync,
  guard: ExodusDeferredGuard,
  message: string,
): ExodusDeferredGuard {
  const present = new Set(
    nativeDb
      .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const raise = sqlString(`${EXODUS_DEFERRED_WRITE_CODE}: ${message}`);
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
  const registered: ExodusDeferredGuard = { ...guard, tables: guarded };
  activeGuards.set(nativeDb, registered);
  return registered;
}

/**
 * The guard active on `nativeDb`, or `undefined`. A guard whose anchor table
 * has rows, or whose scope's completion marker exists (the migration ran, here
 * or in another process), is lifted here and reported as absent.
 *
 * @param nativeDb - A store connection.
 * @returns The active guard, if the store is still waiting for its migration.
 */
export function activeExodusDeferredGuard(nativeDb: DatabaseSync): ExodusDeferredGuard | undefined {
  const guard = activeGuards.get(nativeDb);
  if (guard === undefined) return undefined;
  if (!nativeDb.isOpen) {
    activeGuards.delete(nativeDb);
    return undefined;
  }
  const populated =
    nativeDb.prepare(`SELECT 1 AS present FROM main.${sqlIdent(guard.anchor)} LIMIT 1`).get() !==
    undefined;
  const sealed = guard.markerPath !== null && existsSync(guard.markerPath);
  if (!populated && !sealed) return guard;
  liftExodusDeferredGuard(nativeDb);
  return undefined;
}

/**
 * Remove the guard from `nativeDb`: drop its triggers, forget it, and run its
 * clear the handle's marker and the process record it set. Safe when no guard
 * is active.
 *
 * @param nativeDb - A store connection.
 */
export function liftExodusDeferredGuard(nativeDb: DatabaseSync): void {
  const guard = activeGuards.get(nativeDb);
  if (guard === undefined) return;
  activeGuards.delete(nativeDb);
  if (nativeDb.isOpen) {
    for (const table of guard.tables) {
      nativeDb.exec(`DROP TRIGGER IF EXISTS temp.${sqlIdent(guardTriggerName(table))}`);
    }
  }
  guard.setMarker(undefined);
  if (getRecordedExodusAbort(guard.detail.scope) === guard.detail) {
    clearExodusAborts(guard.detail.scope);
  }
}
