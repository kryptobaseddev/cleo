/**
 * Structural safety for capture (journal spec §2.3a rules 1, 3, 5 and 7; H4
 * T12754, B T12775, NEW-8 T12786, N3 T12759).
 *
 * - {@link withSyncTriggersSuspended}: the rule-1 bracket. The capture
 *   triggers are dropped, `fn` runs its DDL or data rewrite, and the triggers
 *   are regenerated for the new schema, all in ONE transaction the bracket
 *   opens and commits itself. A second connection's write waits on the
 *   bracket's write lock and is captured by the reinstalled triggers. A body
 *   that rebuilds tables declares them, and the bracket applies rule 2 (A,
 *   T12774): foreign keys off before BEGIN, a foreign_key_check that refuses
 *   only new violations before COMMIT, and the FK mode restored after.
 * - {@link touchSet}: the tables a rewrite can change, generated rather than
 *   hand-written: the written tables, their FK-action children (CASCADE,
 *   SET NULL, SET DEFAULT on delete; CASCADE on update), and every table a
 *   trigger on any of those writes, to a fixed point.
 * - {@link markSuspect} / {@link withSuspectAccounting}: a rewriter whose
 *   writes are not captured (triggers dropped, a lineage carry-forward, an
 *   import) marks every sync-set table of its touch set `suspect:<table>` in
 *   `_sync_meta`; the sealer runs the repair diff over them before sealing
 *   anything else (§4.4, S3). Only when the store has the sync schema.
 *
 * @task T12754
 * @module store/sync/structural
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import {
  ForeignKeysNotRestoredError,
  foreignKeyScope,
  foreignKeyViolations,
  newViolations,
} from '../migration-runner.js';
import { isSqliteBusy } from '../with-retry.js';
import { dropCaptureTriggers, installCaptureTriggers, syncSetTables } from './capture.js';
import { readSyncFlags } from './flags.js';
import { hasTable } from './schema.js';
import { triggerWriteTargets } from './trigger-classes.js';

/** A bracket whose `fn` committed or rolled back the bracket's transaction. */
export class BracketTransactionError extends Error {
  readonly code = 'E_SYNC_BRACKET_TXN';

  constructor(message: string) {
    super(message);
    this.name = 'BracketTransactionError';
  }
}

/** A bracketed rebuild that would leave foreign-key violations it did not find. */
export class BracketForeignKeyError extends Error {
  readonly code = 'E_SYNC_BRACKET_FK_VIOLATION';

  constructor(readonly violations: readonly string[]) {
    super(
      `A bracketed rebuild would leave ${violations.length} new foreign-key violation(s); ` +
        `rolled back. First: ${violations.slice(0, 3).join('; ')}`,
    );
    this.name = 'BracketForeignKeyError';
  }
}

/** Options of {@link withSyncTriggersSuspended}. */
export interface SyncSuspensionOptions {
  /**
   * The tables `fn` rebuilds (create a copy, copy the rows, DROP the original,
   * RENAME the copy), named as they are after the rebuild. Inside a
   * transaction `PRAGMA foreign_keys` is a no-op, so without this a rebuild's
   * DROP would cascade-delete child rows, uncaptured (§2.3a rule 2, A T12774).
   * When non-empty, the bracket turns foreign keys off BEFORE its BEGIN,
   * snapshots the violations of these tables and their FK children, refuses
   * only violations the snapshot did not hold, and restores the FK mode after.
   */
  readonly rebuilds?: readonly string[];
}

const MAX_BUSY_RETRIES = 5;

function readForeignKeys(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

/**
 * Run `fn` with the capture triggers dropped, in one transaction this
 * bracket opens and commits (§2.3a rule 1). The triggers are reinstalled for
 * the schema `fn` leaves, before COMMIT. When capture is off, `fn` still runs
 * in the bracket's transaction and nothing is dropped.
 *
 * @param db - The store handle; must not be inside a transaction.
 * @param scope - The store's scope (selects the capture triggers to reinstall).
 * @param fn - The DDL or data rewrite. Must not end the transaction.
 * @param options - {@link SyncSuspensionOptions}: declare rebuilt tables.
 * @throws {BracketTransactionError} When called inside a transaction, or when
 *   `fn` ends the bracket's transaction.
 * @throws {BracketForeignKeyError} When a declared rebuild leaves new FK violations.
 * @throws {ForeignKeysNotRestoredError} When the FK mode could not be restored.
 */
export function withSyncTriggersSuspended<T>(
  db: DatabaseSync,
  scope: TableScope,
  fn: () => T,
  options: SyncSuspensionOptions = {},
): T {
  if (db.isTransaction) {
    // @sync-invariant none:local-only programming-error guard on the local suspension bracket
    throw new BracketTransactionError('withSyncTriggersSuspended must open the only transaction');
  }
  const rebuilds = options.rebuilds ?? [];
  if (rebuilds.length === 0) return bracket(db, scope, fn, []);
  // Rule 2: FK off BEFORE BEGIN (a no-op inside one), restored after, always.
  const prev = readForeignKeys(db);
  db.exec('PRAGMA foreign_keys = OFF');
  let out: T | undefined;
  let failure: unknown;
  let ok = false;
  try {
    out = bracket(db, scope, fn, rebuilds);
    ok = true;
  } catch (err) {
    failure = err;
  }
  if (db.isTransaction) db.exec('ROLLBACK');
  db.exec(`PRAGMA foreign_keys = ${prev}`);
  const now = readForeignKeys(db);
  if (now !== prev) {
    // @sync-invariant none:local-only the suspension bracket restores this handle's FK mode; local only
    throw Object.assign(new ForeignKeysNotRestoredError(prev, now), { cause: failure });
  }
  if (!ok) throw failure;
  return out as T;
}

/** The rule-1 bracket itself; `rebuilds` non-empty means FK is already off. */
function bracket<T>(
  db: DatabaseSync,
  scope: TableScope,
  fn: () => T,
  rebuilds: readonly string[],
): T {
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      // The bracket owns BUSY: retry the whole bracket, never mid-bracket.
      if (!isSqliteBusy(err) || attempt >= MAX_BUSY_RETRIES) throw err;
      sleepMs(100 * 2 ** (attempt - 1));
      continue;
    }
    let capture = false;
    try {
      capture = readSyncFlags(db)['sync.capture'] && hasTable(db, '_sync_capture');
      const before =
        rebuilds.length > 0 ? foreignKeyViolations(db, foreignKeyScope(db, rebuilds)) : null;
      if (capture) dropCaptureTriggers(db);
      const out = fn();
      if (!db.isTransaction) {
        // @sync-invariant none:local-only programming-error guard on the local suspension bracket
        throw new BracketTransactionError('the bracket body ended its transaction');
      }
      if (before !== null) {
        // Pre-existing orphans never block; only violations the rebuild made do (NEW-1).
        const added = newViolations(
          before,
          foreignKeyViolations(db, foreignKeyScope(db, rebuilds)),
        );
        // @sync-invariant none:local-only a rebuild that adds FK violations is refused locally before commit
        if (added.length > 0) throw new BracketForeignKeyError(added);
      }
      if (capture) installCaptureTriggers(db, scope);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      if (db.isTransaction) {
        db.exec('ROLLBACK');
      } else if (capture) {
        // The body committed the drop: never leave the store without its
        // capture triggers. The install is its own atomic unit (atomicDdl).
        installCaptureTriggers(db, scope);
      }
      throw err;
    }
  }
}

interface FkRow {
  table: string;
  on_update: string;
  on_delete: string;
}

/**
 * The touch set of a rewrite of `tables` (NEW-8): the tables themselves, their
 * FK-action children, and every table a trigger on any member writes,
 * repeated to a fixed point. Only existing tables are returned.
 */
export function touchSet(db: DatabaseSync, tables: readonly string[]): string[] {
  const all = (
    db
      .prepare(
        "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const existing = new Set(all);
  const children = new Map<string, Set<string>>();
  for (const child of all) {
    const fks = db.prepare(`PRAGMA main.foreign_key_list("${child}")`).all() as unknown as FkRow[];
    for (const fk of fks) {
      const acts =
        /CASCADE|SET NULL|SET DEFAULT/i.test(fk.on_delete) || /CASCADE/i.test(fk.on_update);
      if (!acts) continue;
      if (!children.has(fk.table)) children.set(fk.table, new Set());
      children.get(fk.table)?.add(child);
    }
  }
  const triggers = db
    .prepare("SELECT tbl_name AS t, sql FROM main.sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ t: string; sql: string }>;
  const out = new Set(tables.filter((t) => existing.has(t)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of [...out]) {
      for (const c of children.get(t) ?? []) {
        if (!out.has(c)) {
          out.add(c);
          grew = true;
        }
      }
      for (const trig of triggers) {
        if (trig.t !== t || !trig.sql) continue;
        for (const w of triggerWriteTargets(trig.sql)) {
          if (existing.has(w) && !out.has(w)) {
            out.add(w);
            grew = true;
          }
        }
      }
    }
  }
  return [...out].sort();
}

/**
 * Mark every sync-set table among `tables` `suspect:` in `_sync_meta`. A no-op
 * on a store without the sync schema.
 *
 * @returns The tables marked.
 */
export function markSuspect(
  db: DatabaseSync,
  scope: TableScope,
  tables: readonly string[],
): string[] {
  if (!hasTable(db, '_sync_meta')) return [];
  const sync = new Set(syncSetTables(scope));
  const marked = tables.filter((t) => sync.has(t));
  const stamp = new Date().toISOString();
  const up = db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  for (const t of marked) up.run(`suspect:${t}`, stamp, stamp);
  return marked;
}

/** The tables currently marked suspect. Read-only. */
export function suspectTables(db: DatabaseSync): string[] {
  if (!hasTable(db, '_sync_meta')) return [];
  return (
    db
      .prepare("SELECT substr(key, 9) AS t FROM _sync_meta WHERE key LIKE 'suspect:%' ORDER BY key")
      .all() as Array<{ t: string }>
  ).map((r) => r.t);
}

/**
 * Run a rewriter whose writes may be uncaptured, and mark its generated touch
 * set suspect when `total_changes()` moved (rule 3).
 */
export function withSuspectAccounting<T>(
  db: DatabaseSync,
  scope: TableScope,
  tables: readonly string[],
  fn: () => T,
): { result: T; suspect: string[] } {
  const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = changes();
  const result = fn();
  const suspect = changes() === before ? [] : markSuspect(db, scope, touchSet(db, tables));
  return { result, suspect };
}
