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

/**
 * Refuse INSERTs into `tables` on this connection with
 * `E_EXODUS_DEFERRED_WRITE_UNSAFE: <message>`.
 *
 * Tables absent from the consolidated schema (another scope's) are skipped.
 * Idempotent: an existing guard trigger is kept.
 *
 * @param nativeDb - The deferred handle's native connection.
 * @param tables - Consolidated tables the pending migration fills.
 * @param message - Why the write is refused and how to fix it.
 * @returns The tables now guarded.
 */
export function installExodusDeferredGuard(
  nativeDb: DatabaseSync,
  tables: readonly string[],
  message: string,
): string[] {
  const present = new Set(
    nativeDb
      .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const raise = sqlString(`${EXODUS_DEFERRED_WRITE_CODE}: ${message}`);
  const guarded: string[] = [];
  for (const table of tables) {
    if (!present.has(table)) continue;
    nativeDb.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS ${sqlIdent(`cleo_exodus_deferred_${table}`)} ` +
        `BEFORE INSERT ON main.${sqlIdent(table)} BEGIN SELECT RAISE(ABORT, ${raise}); END`,
    );
    guarded.push(table);
  }
  return guarded;
}
