/**
 * The conflict log (T12344; journal spec §3.2 "conflict records").
 *
 * Every conflict an apply decides — a typed rule refusing or overriding a
 * write, an edit of a deleted row, a delete over newer edits, a concurrent
 * divergent edit of one field — is a row of `_sync_conflict`, written in the
 * apply's own transaction. Nothing is silently dropped: `cleo cloud
 * conflicts` lists the open ones, and a resolution (an ordinary write in a
 * `write` frame) marks them resolved.
 *
 * @module store/sync/conflicts
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import type { InboxKey } from './inbox.js';
import type { MergeConflict } from './merge/types.js';

/** Where a conflict arose: the inbox transaction and the op in it. */
export interface ConflictSite extends InboxKey {
  /** Index of the op in the (joined) transaction. */
  readonly opIdx: number;
}

/** One stored conflict. */
export interface ConflictRecord extends ConflictSite {
  readonly id: number;
  /** A {@link MergeConflict} kind, or a later kind (`dangling-ref`, `guard` …). */
  readonly kind: string;
  readonly table: string;
  readonly uid: string;
  readonly columns: readonly string[];
  readonly rule: string | null;
  readonly resolution: string;
  readonly opHlc: string;
  readonly localHlc: string | null;
  /** The replica that wrote the op. */
  readonly origin: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

type ConflictRow = {
  id: number;
  stream: string;
  seq: number;
  txn_idx: number;
  op_idx: number;
  kind: string;
  tbl: string;
  uid: string;
  columns_json: string;
  rule: string | null;
  resolution: string;
  op_hlc: string;
  local_hlc: string | null;
  origin: string;
  created_at: string;
  resolved_at: string | null;
};

/**
 * Record the conflicts of one op.
 *
 * @param db - The store, inside the apply frame's transaction.
 * @param site - The inbox transaction and op index.
 * @param conflicts - What the merge decided.
 * @param origin - The op's origin replica.
 * @param nowIso - The time.
 */
export function recordConflicts(
  db: DatabaseSync,
  site: ConflictSite,
  conflicts: readonly MergeConflict[],
  origin: string,
  nowIso: string,
): void {
  if (conflicts.length === 0) return;
  const ins = db.prepare(
    `INSERT INTO _sync_conflict (stream, seq, txn_idx, op_idx, kind, tbl, uid, columns_json,
       rule, resolution, op_hlc, local_hlc, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of conflicts) {
    ins.run(
      site.stream,
      site.seq,
      site.txnIdx,
      site.opIdx,
      c.kind,
      c.table,
      c.uid,
      JSON.stringify(c.columns),
      c.rule ?? null,
      c.resolution,
      c.opHlc,
      c.localHlc ?? null,
      origin,
      nowIso,
    );
  }
}

/**
 * The recorded conflicts, oldest first.
 *
 * @param db - The store.
 * @param opts - `open` lists only unresolved ones; `stream` narrows to one stream.
 * @returns The conflicts.
 */
export function listConflicts(
  db: DatabaseSync,
  opts: { readonly open?: boolean; readonly stream?: string } = {},
): ConflictRecord[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.open) where.push('resolved_at IS NULL');
  if (opts.stream !== undefined) {
    where.push('stream = ?');
    args.push(opts.stream);
  }
  const rows = db
    .prepare(
      `SELECT * FROM _sync_conflict ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`,
    )
    .all(...args) as ConflictRow[];
  return rows.map((r) => ({
    id: r.id,
    stream: r.stream,
    seq: r.seq,
    txnIdx: r.txn_idx,
    opIdx: r.op_idx,
    kind: r.kind,
    table: r.tbl,
    uid: r.uid,
    columns: JSON.parse(r.columns_json) as string[],
    rule: r.rule,
    resolution: r.resolution,
    opHlc: r.op_hlc,
    localHlc: r.local_hlc,
    origin: r.origin,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
}

/**
 * Mark an open conflict resolved (its resolution, an ordinary write, has been
 * made or the conflict was reviewed and accepted).
 *
 * @param db - The store.
 * @param id - The conflict id.
 * @param nowIso - The time.
 * @returns Whether an open conflict had that id.
 */
export function resolveConflict(db: DatabaseSync, id: number, nowIso: string): boolean {
  const r = db
    .prepare('UPDATE _sync_conflict SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
    .run(nowIso, id);
  return Number(r.changes) > 0;
}

/**
 * How many conflicts the store holds.
 *
 * @param db - The store.
 * @returns Open (unresolved) and total counts.
 */
export function conflictCounts(db: DatabaseSync): { open: number; total: number } {
  const row = db
    .prepare(
      'SELECT count(*) AS total, coalesce(sum(resolved_at IS NULL), 0) AS open FROM _sync_conflict',
    )
    .get() as { total: number; open: number };
  return { open: Number(row.open), total: Number(row.total) };
}
