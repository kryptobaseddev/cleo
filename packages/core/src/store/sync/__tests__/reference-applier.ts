/**
 * The reference applier for Gate B replay (journal spec §4.5, S3 exit; T12987).
 *
 * Applies sealed ops (`_sync_op` bodies) to a scratch copy of the store, in
 * `local_seq` order, so the copy can be fingerprinted against the source.
 * It is deliberately small: one replica's own stream replayed onto an earlier
 * copy of itself, so there is no conflict resolution, no field HLC and no
 * apply intent (that is T12344's engine). What it must get right is the wire
 * shape: references travel as uids and are translated back to local keys,
 * a natural row is found by its key when its uid column is still NULL, a K
 * moves the uid, and a stored ref's local source column (`ac_id` for
 * `ac_uid`) is derived again. Every trigger is suspended while it applies
 * (`cleo_trigger_suspend` scope `all`), as an apply frame does.
 *
 * Test-only: it writes raw SQL to a scratch copy and never to a live store.
 *
 * @task T12987
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { BIRTH_FP_COLUMN, rowIdentitySpec, UID_COLUMN } from '../../row-identity-registry.js';
import { type CaptureTableDef, captureTableDef } from '../capture.js';
import type { SealedOp, WireValue } from '../sealer.js';

/** What one replay applied. */
export interface ReplayReport {
  readonly ops: number;
  /** U, D or K ops whose row was not found. */
  readonly missingRows: number;
  /** Reference uids with no row in the copy (written as NULL). */
  readonly unresolvedRefs: number;
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

type IncValue = { readonly $inc: number };

function isInc(v: WireValue | IncValue): v is IncValue {
  return v !== null && typeof v === 'object' && '$inc' in v;
}

/** A wire value as SQLite stores it. */
function sqlValue(v: WireValue): SQLInputValue {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if ('$i' in v) return BigInt(v.$i);
  if ('$r' in v) return Number(v.$r);
  return Buffer.from(v.$b, 'base64');
}

/** The sealed ops of `db`, in seal order, optionally after a local_seq. */
export function sealedOps(db: DatabaseSync, afterLocalSeq = 0): SealedOp[] {
  return (
    db
      .prepare(
        `SELECT o.body FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn
         WHERE t.local_seq > ? ORDER BY t.local_seq, o.idx`,
      )
      .all(afterLocalSeq) as Array<{ body: string }>
  ).map((r) => JSON.parse(r.body) as SealedOp);
}

/** The highest sealed local_seq of `db` (0 when none). */
export function lastLocalSeq(db: DatabaseSync): number {
  return (
    db.prepare('SELECT coalesce(max(local_seq), 0) AS n FROM _sync_txn').get() as { n: number }
  ).n;
}

class Applier {
  private readonly defs = new Map<string, CaptureTableDef>();
  missingRows = 0;
  unresolvedRefs = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly scope: TableScope,
  ) {}

  def(table: string): CaptureTableDef {
    let d = this.defs.get(table);
    if (!d) {
      const found = captureTableDef(this.db, this.scope, table);
      if (!found) throw new Error(`replay: ${table} is not in the sync set of the copy`);
      d = found;
      this.defs.set(table, d);
    }
    return d;
  }

  /** The local key of `table`'s row with `uid`, or null. */
  localKey(table: string, keyColumn: string, uid: string): SQLInputValue {
    const row = this.db
      .prepare(`SELECT ${q(keyColumn)} AS k FROM ${q(table)} WHERE ${q(UID_COLUMN)} = ?`)
      .get(uid) as { k: SQLInputValue } | undefined;
    if (row === undefined) {
      this.unresolvedRefs += 1;
      return null;
    }
    return row.k;
  }

  /** One column's local value: a reference uid becomes the referenced local key. */
  local(def: CaptureTableDef, col: string, v: WireValue): SQLInputValue {
    const ref = def.refs.get(col);
    if (ref && typeof v === 'string') return this.localKey(ref.table, ref.key, v);
    return sqlValue(v);
  }

  /** The local source columns of stored ref uids (`ac_id` from `ac_uid`). */
  derived(table: string, a: Record<string, WireValue | IncValue>): Record<string, SQLInputValue> {
    const out: Record<string, SQLInputValue> = {};
    for (const r of rowIdentitySpec(this.scope, table)?.storedRefUids ?? []) {
      if (r.source !== undefined || !(r.column in a)) continue;
      const uid = a[r.column];
      const key = rowIdentitySpec(this.scope, r.table)?.key[0] ?? 'id';
      out[r.from] = typeof uid === 'string' ? this.localKey(r.table, key, uid) : null;
    }
    return out;
  }

  /** WHERE clause and params locating op's row: by uid, else by natural key. */
  locate(def: CaptureTableDef, op: SealedOp): { where: string; params: SQLInputValue[] } | null {
    const byUid = this.db
      .prepare(`SELECT 1 FROM ${q(def.table)} WHERE ${q(UID_COLUMN)} = ?`)
      .get(op.u);
    if (byUid) return { where: `${q(UID_COLUMN)} = ?`, params: [op.u] };
    if (!op.k) return null;
    const params = def.key.map((c) => this.local(def, c, op.k?.[c] ?? null));
    const where = def.key.map((c) => `${q(c)} IS ?`).join(' AND ');
    const found = this.db.prepare(`SELECT 1 FROM ${q(def.table)} WHERE ${where}`).get(...params);
    return found ? { where, params } : null;
  }

  apply(op: SealedOp): void {
    const def = this.def(op.t);
    const minted = rowIdentitySpec(this.scope, op.t)?.kind === 'minted';
    const a = (op.a ?? {}) as Record<string, WireValue | IncValue>;
    switch (op.o) {
      case 'I': {
        const cols: Record<string, SQLInputValue> = {};
        for (const [c, v] of Object.entries(a)) cols[c] = isInc(v) ? v.$inc : this.local(def, c, v);
        for (const [c, v] of Object.entries(op.k ?? {})) cols[c] = this.local(def, c, v);
        Object.assign(cols, this.derived(op.t, a));
        cols[UID_COLUMN] = op.u;
        if (minted && op.bfp !== undefined) cols[BIRTH_FP_COLUMN] = op.bfp;
        const found = this.locate(def, op);
        if (found) {
          this.update(def, cols, found);
          return;
        }
        const names = Object.keys(cols);
        this.db
          .prepare(
            `INSERT INTO ${q(op.t)} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
          )
          .run(...names.map((c) => cols[c] ?? null));
        return;
      }
      case 'U': {
        const found = this.locate(def, op);
        if (!found) {
          this.missingRows += 1;
          return;
        }
        const cols: Record<string, SQLInputValue> = {};
        const incs: Record<string, number> = {};
        for (const [c, v] of Object.entries(a)) {
          if (isInc(v)) incs[c] = v.$inc;
          else cols[c] = this.local(def, c, v);
        }
        Object.assign(cols, this.derived(op.t, a));
        this.update(def, cols, found, incs);
        return;
      }
      case 'D': {
        const found = this.locate(def, op);
        if (!found) {
          this.missingRows += 1;
          return;
        }
        this.db.prepare(`DELETE FROM ${q(op.t)} WHERE ${found.where}`).run(...found.params);
        return;
      }
      case 'K': {
        const found = this.locate(def, op);
        if (!found) {
          this.missingRows += 1;
          return;
        }
        const cols: Record<string, SQLInputValue> = { [UID_COLUMN]: op.nu ?? op.u };
        if (minted && op.bfp !== undefined) cols[BIRTH_FP_COLUMN] = op.bfp;
        this.update(def, cols, found);
        return;
      }
    }
  }

  private update(
    def: CaptureTableDef,
    cols: Record<string, SQLInputValue>,
    at: { where: string; params: SQLInputValue[] },
    incs: Record<string, number> = {},
  ): void {
    const sets = [
      ...Object.keys(cols).map((c) => `${q(c)} = ?`),
      ...Object.keys(incs).map((c) => `${q(c)} = coalesce(${q(c)}, 0) + ?`),
    ];
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE ${q(def.table)} SET ${sets.join(', ')} WHERE ${at.where}`)
      .run(...Object.values(cols), ...Object.values(incs), ...at.params);
  }
}

/**
 * Replay `ops` onto `db` (a scratch copy), in one transaction with every
 * trigger suspended and foreign keys deferred.
 *
 * @param db - A raw handle on a scratch copy; never a live store.
 * @param scope - The copy's scope.
 * @param ops - Sealed ops in seal order ({@link sealedOps}).
 */
export function replaySealedOps(
  db: DatabaseSync,
  scope: TableScope,
  ops: readonly SealedOp[],
): ReplayReport {
  const applier = new Applier(db, scope);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.exec("INSERT INTO cleo_trigger_suspend (scope) VALUES ('all')");
    for (const op of ops) applier.apply(op);
    db.exec("DELETE FROM cleo_trigger_suspend WHERE scope = 'all'");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    ops: ops.length,
    missingRows: applier.missingRows,
    unresolvedRefs: applier.unresolvedRefs,
  };
}
