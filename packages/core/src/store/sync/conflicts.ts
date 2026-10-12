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
import type { TableScope } from '@cleocode/contracts';
import {
  type LedgerOp,
  LedgerTxn,
  type LedgerValue,
  type LedgerWireValue,
} from '@cleocode/contracts/ledger';
import { type CaptureTableDef, captureTableDef, enc } from './capture.js';
import type { InboxKey } from './inbox.js';
import type { MergeConflict } from './merge/types.js';
import { hasTable } from './schema.js';
import { canonicalJson, decodeEnc, type WireValue } from './sealer-values.js';

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
  /**
   * This store's pre-merge values of the conflicting, non-secret columns
   * (references as uids), or null when unknown (T13624).
   */
  readonly local: Readonly<Record<string, LedgerWireValue>> | null;
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
  local_json?: string | null;
};

/**
 * Record the conflicts of one op.
 *
 * @param db - The store, inside the apply frame's transaction.
 * @param site - The inbox transaction and op index.
 * @param conflicts - What the merge decided.
 * @param origin - The op's origin replica.
 * @param nowIso - The time.
 * @param local - This store's pre-merge non-secret values of the row, kept for
 *   each conflict's columns (T13624); omitted when unknown.
 */
export function recordConflicts(
  db: DatabaseSync,
  site: ConflictSite,
  conflicts: readonly MergeConflict[],
  origin: string,
  nowIso: string,
  local?: Readonly<Record<string, LedgerWireValue>> | null,
): void {
  if (conflicts.length === 0) return;
  const ins = db.prepare(
    `INSERT INTO _sync_conflict (stream, seq, txn_idx, op_idx, kind, tbl, uid, columns_json,
       rule, resolution, op_hlc, local_hlc, origin, created_at, local_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of conflicts) {
    const kept = local
      ? Object.fromEntries(c.columns.filter((col) => col in local).map((col) => [col, local[col]]))
      : null;
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
      kept && Object.keys(kept).length > 0 ? canonicalJson(kept) : null,
    );
  }
}

/**
 * Record a conflict of one op unless that op already has one of its kind.
 * For a transaction re-planned on every apply call while it stays pending
 * (a held uid collision, T13394), so the hold is listed once, not per pass.
 *
 * @param db - The store, inside the apply frame's transaction.
 * @param site - The inbox transaction and op index.
 * @param conflict - The conflict.
 * @param origin - The op's origin replica.
 * @param nowIso - The time.
 * @returns Whether it was recorded now.
 */
export function recordConflictOnce(
  db: DatabaseSync,
  site: ConflictSite,
  conflict: MergeConflict,
  origin: string,
  nowIso: string,
): boolean {
  const seen = db
    .prepare(
      `SELECT 1 FROM _sync_conflict
        WHERE stream = ? AND seq = ? AND txn_idx = ? AND op_idx = ? AND kind = ?`,
    )
    .get(site.stream, site.seq, site.txnIdx, site.opIdx, conflict.kind);
  if (seen) return false;
  recordConflicts(db, site, [conflict], origin, nowIso);
  return true;
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
    local: r.local_json ? (JSON.parse(r.local_json) as Record<string, LedgerWireValue>) : null,
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
 * Mark the held-collision conflicts of one inbox transaction resolved, once
 * it has gone through (T13397): the uid collision settled by the loser's
 * re-key, or the local key freed. Other conflicts stay open.
 *
 * @param db - The store, inside the apply frame's transaction.
 * @param key - The inbox transaction.
 * @param nowIso - The time.
 * @returns How many were resolved.
 */
export function resolveHeldConflicts(db: DatabaseSync, key: InboxKey, nowIso: string): number {
  const r = db
    .prepare(
      `UPDATE _sync_conflict SET resolved_at = ?
        WHERE stream = ? AND seq = ? AND txn_idx = ? AND resolution = 'op-held'
          AND kind IN ('uid-collision', 'key-collision') AND resolved_at IS NULL`,
    )
    .run(nowIso, key.stream, key.seq, key.txnIdx);
  return Number(r.changes);
}

/**
 * How many conflicts the store holds, or one stream of it.
 *
 * @param db - The store.
 * @param stream - Only this stream's conflicts, when given.
 * @returns Open (unresolved) and total counts.
 */
export function conflictCounts(db: DatabaseSync, stream?: string): { open: number; total: number } {
  const sql =
    'SELECT count(*) AS total, coalesce(sum(resolved_at IS NULL), 0) AS open FROM _sync_conflict';
  const row = (
    stream === undefined ? db.prepare(sql).get() : db.prepare(`${sql} WHERE stream = ?`).get(stream)
  ) as { total: number; open: number };
  return { open: Number(row.open), total: Number(row.total) };
}

/** One conflicting column, both sides (T12997). */
export interface ConflictFieldValues {
  readonly column: string;
  /**
   * The incoming op's value (a reference as the target's local key when this
   * store has it); null when the op did not set it or is no longer in the inbox.
   */
  readonly theirs: LedgerValue | null;
  /** This store's current value; null when the row is gone. */
  readonly mine: WireValue | null;
  /** A secret column: neither value is shown. */
  readonly withheld: boolean;
}

/** What a conflict is about, for `cleo cloud conflicts` (T12997). */
export interface ConflictDetail {
  /** The row's human id (a task id, a doc slug …) from its declared key, or null. */
  readonly humanId: string | null;
  /** The Nexus device that wrote the op; null once its inbox row is pruned. */
  readonly deviceId: string | null;
  /** Whether the incoming op is still in the inbox (applied rows are pruned after a checkpoint). */
  readonly opKnown: boolean;
  readonly fields: readonly ConflictFieldValues[];
}

const qi = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** The op a conflict was recorded for, its split parts joined, or undefined. */
function incomingOp(
  db: DatabaseSync,
  c: ConflictRecord,
  row: { replica_id: string; txn_json: string },
): LedgerOp | undefined {
  const parse = (text: string): LedgerTxn | undefined => {
    try {
      const ok = LedgerTxn.safeParse(JSON.parse(text));
      return ok.success ? ok.data : undefined;
    } catch {
      return undefined;
    }
  };
  const head = parse(row.txn_json);
  if (!head) return undefined;
  let ops = head.ops;
  if (head.part) {
    const parts = (
      db
        .prepare(
          `SELECT txn_json FROM _sync_inbox WHERE stream = ? AND replica_id = ?
             AND json_valid(txn_json) AND json_extract(txn_json, '$.txn') = ?`,
        )
        .all(c.stream, row.replica_id, head.txn) as Array<{ txn_json: string }>
    )
      .map((r) => parse(r.txn_json))
      .filter((t): t is LedgerTxn => t !== undefined)
      .sort((a, b) => (a.part?.[0] ?? 0) - (b.part?.[0] ?? 0));
    ops = parts.flatMap((t) => t.ops);
  }
  const at = ops[c.opIdx];
  if (at && at.t === c.table && at.u === c.uid) return at;
  return ops.findLast((o) => o.t === c.table && o.u === c.uid);
}

/**
 * The op a conflict was recorded for (its split parts joined) and the Nexus
 * device that wrote it, from the inbox; both absent once the inbox row is
 * pruned after a checkpoint.
 *
 * @param db - The store.
 * @param c - The conflict.
 * @returns The op and the device id.
 */
export function conflictIncomingOp(
  db: DatabaseSync,
  c: ConflictRecord,
): { op: LedgerOp | undefined; deviceId: string | null } {
  const inbox = hasTable(db, '_sync_inbox')
    ? (db
        .prepare(
          'SELECT replica_id, device_id, txn_json FROM _sync_inbox WHERE stream = ? AND seq = ? AND txn_idx = ?',
        )
        .get(c.stream, c.seq, c.txnIdx) as
        | { replica_id: string; device_id: string; txn_json: string }
        | undefined)
    : undefined;
  return {
    op: inbox ? incomingOp(db, c, inbox) : undefined,
    deviceId: inbox?.device_id ?? null,
  };
}

/** The row's current values by uid, as wire values, or undefined when it is gone. */
function currentRow(
  db: DatabaseSync,
  def: CaptureTableDef,
  uid: string,
): Map<string, WireValue> | undefined {
  const cols = [...new Set([...def.key, ...def.columns])];
  const r = db
    .prepare(
      `SELECT ${cols.map((col, i) => `${enc(qi(col))} AS c${i}`).join(', ')} FROM main.${qi(def.table)} WHERE uid = ?`,
    )
    .get(uid) as Record<string, string> | undefined;
  return r ? new Map(cols.map((col, i) => [col, decodeEnc(String(r[`c${i}`]))])) : undefined;
}

/** A reference's uid as the target row's local key, when this store holds it. */
function localKeyOf(
  db: DatabaseSync,
  ref: { table: string; key: string },
  uid: LedgerWireValue,
): LedgerWireValue;
function localKeyOf(
  db: DatabaseSync,
  ref: { table: string; key: string },
  uid: LedgerValue,
): LedgerValue;
function localKeyOf(
  db: DatabaseSync,
  ref: { table: string; key: string },
  uid: LedgerValue,
): LedgerValue {
  if (typeof uid !== 'string' || !hasTable(db, ref.table)) return uid;
  const r = db
    .prepare(`SELECT ${enc(qi(ref.key))} AS k FROM main.${qi(ref.table)} WHERE uid = ?`)
    .get(uid) as { k: string } | undefined;
  return r ? decodeEnc(r.k) : uid;
}

const show = (v: LedgerValue | undefined): string | null =>
  v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);

/**
 * Describe one recorded conflict: the row's human id, the device that wrote
 * the incoming op, and each conflicting column's incoming and current
 * values (secret columns withheld). Read-only.
 *
 * @param db - The store.
 * @param scope - The store's scope.
 * @param c - The conflict.
 * @returns The detail.
 */
export function conflictDetail(
  db: DatabaseSync,
  scope: TableScope,
  c: ConflictRecord,
): ConflictDetail {
  const { op, deviceId } = conflictIncomingOp(db, c);
  const def = captureTableDef(db, scope, c.table);
  const row = def ? currentRow(db, def, c.uid) : undefined;
  const keyParts = (def?.key ?? []).map((k) => show(row?.get(k) ?? op?.k?.[k] ?? op?.a?.[k]));
  const humanId =
    keyParts.length > 0 && keyParts.every((p) => p !== null) ? keyParts.join('/') : null;
  const fields = c.columns.map((column): ConflictFieldValues => {
    if (def?.secret.has(column)) return { column, theirs: null, mine: null, withheld: true };
    const raw = op?.a?.[column] ?? op?.k?.[column] ?? null;
    const ref = def?.refs.get(column);
    // Mine is what this store held before the merge (T13624), else its current value.
    const kept = c.local?.[column];
    return {
      column,
      theirs: raw !== null && ref ? localKeyOf(db, ref, raw) : raw,
      mine:
        kept === undefined
          ? (row?.get(column) ?? null)
          : kept !== null && ref
            ? localKeyOf(db, ref, kept)
            : kept,
      withheld: false,
    };
  });
  return { humanId, deviceId, opKnown: op !== undefined, fields };
}
