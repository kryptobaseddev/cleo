/**
 * Structural safety for capture (journal spec §2.3a rules 1, 3, 5 and 7; H4
 * T12754, B T12775, NEW-8 T12786, N3 T12759).
 *
 * - {@link withSyncTriggersSuspended}: the rule-1 bracket. The capture
 *   triggers are dropped, `fn` runs its DDL or data rewrite, and the triggers
 *   are regenerated for the new schema, all in ONE transaction the bracket
 *   opens and commits itself. A second connection's write waits on the
 *   bracket's write lock and is captured by the reinstalled triggers.
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

const MAX_BUSY_RETRIES = 5;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

/**
 * Run `fn` with the capture triggers dropped, in one transaction this
 * bracket opens and commits (§2.3a rule 1). The triggers are reinstalled for
 * the schema `fn` leaves, before COMMIT. When capture is off, `fn` still runs
 * in the bracket's transaction and nothing is dropped.
 *
 * @throws {BracketTransactionError} When called inside a transaction, or when
 *   `fn` ends the bracket's transaction.
 */
export function withSyncTriggersSuspended<T>(db: DatabaseSync, scope: TableScope, fn: () => T): T {
  if (db.isTransaction) {
    // @sync-invariant none:local-only programming-error guard on the local suspension bracket
    throw new BracketTransactionError('withSyncTriggersSuspended must open the only transaction');
  }
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
      if (capture) dropCaptureTriggers(db);
      const out = fn();
      if (!db.isTransaction) {
        // @sync-invariant none:local-only programming-error guard on the local suspension bracket
        throw new BracketTransactionError('the bracket body ended its transaction');
      }
      if (capture) installCaptureTriggers(db, scope);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      if (db.isTransaction) {
        db.exec('ROLLBACK');
      } else if (capture) {
        // The body committed the drop: never leave the store without its
        // capture triggers. Reinstall them in a transaction of their own.
        db.exec('BEGIN IMMEDIATE');
        installCaptureTriggers(db, scope);
        db.exec('COMMIT');
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
