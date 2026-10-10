/**
 * Own-echo sequencing and the foreign-touch index (T13193; journal spec §3.5
 * Rules 2-3, R7-6).
 *
 * A sealed local transaction stays **unsequenced** until its own echo comes
 * back through the stream. Until then it keeps its undo (`_sync_undo`, the
 * values) and its row undo (`_sync_row_undo`, the merge state: row meta,
 * leaves, frontiers), so a scoped rebase can rewind it.
 *
 * When the echo applies, the **fast path** decides whether a rebase is needed:
 * if no foreign transaction applied after this transaction's commit touched
 * its rows, the stream order and the local order agree, so the echo is simply
 * sequenced and its undo dropped. The order is exact, with no clock: a local
 * transaction's position is its first capture's seq, and a foreign touch
 * records the capture sequence (`sqlite_sequence` of `_sync_capture`) when its
 * transaction applied. Both come from the one AUTOINCREMENT counter.
 *
 * Unframed writers (foreign connections) seal as singleton transactions with
 * no frame and undo rows with no `txn_local`: they have no position here, are
 * sequenced on echo without a check, and keep their undo until R-2 keys it by
 * capture seq. A split part-set (`LedgerTxn.part`, not sealed today) would map
 * one frame to several transactions.
 *
 * The index holds only entries at or after the oldest unsequenced local
 * transaction and is bounded by {@link FOREIGN_TOUCH_MAX}; past the bound it
 * is marked incomplete and the fast path declines (falling back to the scoped
 * rebase) until the unsequenced backlog drains.
 *
 * @module store/sync/sequencing
 * @task T13193
 */

import type { DatabaseSync } from 'node:sqlite';
import { LedgerActor, LedgerOp, type LedgerWireValue } from '@cleocode/contracts/ledger';
import {
  actorOpOf,
  type FieldStateSnapshot,
  readFieldFrontiers,
  readFieldLeaves,
} from './field-leave.js';
import { type RowMetaFull, readRowMetaFull } from './row-meta.js';
import { hasTable } from './schema.js';
import { canonicalJson } from './sealer-values.js';

/** The foreign-touch index's bound (spec R7-6). */
export const FOREIGN_TOUCH_MAX = 200_000;

/** `_sync_meta` key set while the foreign-touch index overflowed its bound. */
export const FOREIGN_TOUCH_INCOMPLETE_KEY = 'sync.foreign_touch_incomplete';

/** One row a transaction touched. */
export interface TouchedRow {
  readonly table: string;
  readonly uid: string;
}

/** Whether undo is being written (§3.5 Rule 2: on exactly while push is on). */
export function undoEnabled(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM _sync_meta WHERE key = 'undo_enabled'").get() !== undefined;
}

/**
 * Snapshot a row's merge state before a local op moves it (the sealer calls
 * this per sealed op while undo is enabled): its row meta, leaves and
 * frontiers, so a rewind can restore them with the values.
 *
 * @param db - The store, inside the sealer's transaction.
 * @param txn - The sealed transaction id.
 * @param idx - The op's index in it.
 * @param tbl - The row's table.
 * @param uid - The row's uid before the op.
 */
export function snapshotRowUndo(
  db: DatabaseSync,
  txn: string,
  idx: number,
  tbl: string,
  uid: string,
): void {
  const meta = readRowMetaFull(db, tbl, uid);
  const leaves = readFieldLeaves(db, tbl, uid);
  const frontiers = readFieldFrontiers(db, tbl, uid);
  const state =
    Object.keys(leaves).length + Object.keys(frontiers).length > 0
      ? canonicalJson({ leaves, frontiers })
      : null;
  db.prepare(
    `INSERT INTO _sync_row_undo (txn, idx, tbl, uid, meta_json, leave_json) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (txn, idx) DO NOTHING`,
  ).run(txn, idx, tbl, uid, meta ? canonicalJson(meta) : null, state);
}

/**
 * The capture position now: the last seq `_sync_capture` handed out (0 when
 * none). A write made after this point has a larger seq.
 */
export function capturePosition(db: DatabaseSync): number {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_sync_capture'").get() as
    | { seq: number }
    | undefined;
  return Number(row?.seq ?? 0);
}

/**
 * The oldest unsequenced local transaction's position: its frame's first
 * undo seq. Joins through the `_sync_txn_frame` index (T13260), since it
 * runs on every echo and foreign apply under the write lock.
 */
export const OLDEST_UNSEQUENCED_SQL = `SELECT min(u.seq) AS p FROM _sync_undo u JOIN _sync_txn t ON t.frame = u.txn_local
  WHERE t.state IN ('sealed', 'segmented') AND NOT EXISTS (SELECT 1 FROM _sync_sequenced s WHERE s.txn = t.txn)`;

/**
 * Drop the undo of frames sealed into no transaction (netted away, or
 * inherited/folded) that hold no live capture. Probes `_sync_txn` through
 * the `_sync_txn_frame` index (T13260).
 */
export const DROP_NETTED_UNDO_SQL = `DELETE FROM _sync_undo WHERE txn_local IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM _sync_txn t WHERE t.frame = _sync_undo.txn_local)
  AND NOT EXISTS (SELECT 1 FROM _sync_capture c WHERE c.frame = _sync_undo.txn_local AND c.state = 'live')`;

/** The oldest unsequenced local transaction's position, or null when none has undo. */
function oldestUnsequencedPosition(db: DatabaseSync): number | null {
  const row = db.prepare(OLDEST_UNSEQUENCED_SQL).get() as { p: number | null };
  return row.p === null ? null : Number(row.p);
}

/**
 * Record the rows an applied foreign transaction touched, at `pos`. Nothing
 * is recorded while no local transaction is unsequenced (no echo will ask).
 *
 * @param db - The store, inside the apply frame.
 * @param rows - The rows the transaction wrote.
 * @param pos - {@link capturePosition} when the transaction began applying.
 */
export function recordForeignTouches(
  db: DatabaseSync,
  rows: readonly TouchedRow[],
  pos: number,
): void {
  if (rows.length === 0 || oldestUnsequencedPosition(db) === null) return;
  if (counterRestarted(db)) markIncomplete(db);
  const ins = db.prepare(
    'INSERT INTO _sync_foreign_touch (tbl, uid, pos) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  let added = 0;
  for (const r of rows) added += Number(ins.run(r.table, r.uid, pos).changes);
  // A running count, not a scan per transaction near the bound (#1912 LOW-2).
  if (added > 0 && adjustTouchCount(db, added) > FOREIGN_TOUCH_MAX) markIncomplete(db);
}

/** `_sync_meta` key holding the foreign-touch index's row count. */
export const FOREIGN_TOUCH_COUNT_KEY = 'sync.foreign_touch_count';

function adjustTouchCount(db: DatabaseSync, delta: number): number {
  const row = db
    .prepare(
      `INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value, updated_at = excluded.updated_at
       RETURNING CAST(value AS INTEGER) AS n`,
    )
    .get(FOREIGN_TOUCH_COUNT_KEY, delta) as { n: number };
  return Number(row.n);
}

function markIncomplete(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, '1', datetime('now'))
     ON CONFLICT (key) DO NOTHING`,
  ).run(FOREIGN_TOUCH_INCOMPLETE_KEY);
}

/**
 * Whether `_sync_capture`'s counter restarted under unsequenced undo (the
 * table was re-created, #1912 LOW-1): an undo seq above the counter's last
 * value means new positions would sort below old ones, so the fast path can
 * no longer order foreign touches against local commits.
 */
function counterRestarted(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT max(seq) AS m FROM _sync_undo').get() as { m: number | null };
  return row.m !== null && Number(row.m) > capturePosition(db);
}

/** A sealed local transaction as the fast path sees it. */
export interface LocalTxn {
  readonly txn: string;
  readonly frame: string | null;
  /** Its first capture's seq, or null when it kept no undo. */
  readonly position: number | null;
}

/**
 * The unsequenced sealed local transaction with this id, or null (not ours,
 * or already sequenced).
 *
 * @param db - The store.
 * @param txn - The transaction id the echo carries.
 * @returns The local transaction, or null.
 */
export function unsequencedLocalTxn(db: DatabaseSync, txn: string): LocalTxn | null {
  const t = db
    .prepare(
      `SELECT t.txn, t.frame FROM _sync_txn t WHERE t.txn = ?
         AND NOT EXISTS (SELECT 1 FROM _sync_sequenced s WHERE s.txn = t.txn)`,
    )
    .get(txn) as { txn: string; frame: string | null } | undefined;
  if (!t) return null;
  const p =
    t.frame === null
      ? undefined
      : (db.prepare('SELECT min(seq) AS p FROM _sync_undo WHERE txn_local = ?').get(t.frame) as {
          p: number | null;
        });
  return { txn: t.txn, frame: t.frame, position: p?.p == null ? null : Number(p.p) };
}

/**
 * The own-echo fast path (Rule 3): whether no foreign transaction applied at
 * or after `local`'s commit touched any of `rows`. False while the index is
 * incomplete.
 *
 * @param db - The store.
 * @param local - The echoed local transaction.
 * @param rows - The rows its ops wrote.
 * @returns True when the echo can be sequenced without a rebase.
 */
export function ownEchoFastPath(
  db: DatabaseSync,
  local: LocalTxn,
  rows: readonly TouchedRow[],
): boolean {
  if (local.position === null) return true; // nothing to rewind
  if (counterRestarted(db)) markIncomplete(db);
  if (
    db.prepare('SELECT 1 FROM _sync_meta WHERE key = ?').get(FOREIGN_TOUCH_INCOMPLETE_KEY) !==
    undefined
  ) {
    return false;
  }
  const hit = db.prepare(
    'SELECT 1 FROM _sync_foreign_touch WHERE tbl = ? AND uid = ? AND pos >= ? LIMIT 1',
  );
  return !rows.some((r) => hit.get(r.table, r.uid, local.position) !== undefined);
}

/**
 * Mark an own transaction sequenced by its echo: record it, drop its undo
 * and row undo (and the undo of frames that netted to no transaction), and
 * prune the foreign-touch index past the new oldest
 * unsequenced transaction (resetting it, and its incomplete mark, when none
 * is left).
 *
 * @param db - The store, inside the apply frame.
 * @param local - The echoed local transaction.
 * @param at - The echo's stream position and the time.
 */
export function markSequenced(
  db: DatabaseSync,
  local: LocalTxn,
  at: {
    readonly stream: string;
    readonly seq: number;
    readonly nowIso: string;
    /** `void` when the stream refused it: it stays rewound and keeps its undo (Rule 6). */
    readonly outcome?: 'applied' | 'void';
  },
): void {
  const outcome = at.outcome ?? 'applied';
  db.prepare(
    'INSERT INTO _sync_sequenced (txn, stream, seq, at, outcome) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  ).run(local.txn, at.stream, at.seq, at.nowIso, outcome);
  if (outcome === 'applied') {
    if (local.frame !== null) {
      db.prepare('DELETE FROM _sync_undo WHERE txn_local = ?').run(local.frame);
    }
    db.prepare('DELETE FROM _sync_row_undo WHERE txn = ?').run(local.txn);
  }
  // A frame whose ops all netted away was sealed into no transaction: its
  // undo can never be sequenced or rewound, so it goes too (its captures are
  // consumed; a frame still waiting to seal keeps live captures).
  db.prepare(DROP_NETTED_UNDO_SQL).run();
  const oldest = oldestUnsequencedPosition(db);
  if (oldest === null) {
    db.prepare('DELETE FROM _sync_foreign_touch').run();
    db.prepare('DELETE FROM _sync_meta WHERE key IN (?, ?)').run(
      FOREIGN_TOUCH_INCOMPLETE_KEY,
      FOREIGN_TOUCH_COUNT_KEY,
    );
  } else {
    const gone = Number(
      db.prepare('DELETE FROM _sync_foreign_touch WHERE pos < ?').run(oldest).changes,
    );
    if (gone > 0) adjustTouchCount(db, -gone);
  }
}

/** One sealed, unsequenced local transaction, with its ops (a rebase's unit). */
export interface UnsequencedTxn extends LocalTxn {
  /** The frame's actor (`LedgerActor`), when it was JSON. */
  readonly actor: LedgerActor | null;
  readonly actorOp: string | null;
  readonly ops: readonly LedgerOp[];
}

/**
 * Every sealed local transaction not yet sequenced, in local commit order.
 *
 * @param db - The store.
 * @returns The transactions with their sealed ops.
 */
export function unsequencedLocalTxns(db: DatabaseSync): UnsequencedTxn[] {
  const txns = db
    .prepare(
      `SELECT t.txn, t.frame, t.actor FROM _sync_txn t
        WHERE t.state IN ('sealed', 'segmented') AND NOT EXISTS (SELECT 1 FROM _sync_sequenced s WHERE s.txn = t.txn)
        ORDER BY t.local_seq`,
    )
    .all() as Array<{ txn: string; frame: string | null; actor: string | null }>;
  const ops = db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx');
  return txns.map((t) => {
    const local = unsequencedLocalTxn(db, t.txn) as LocalTxn;
    let actor: LedgerActor | null = null;
    if (t.actor?.startsWith('{')) {
      try {
        const parsed = LedgerActor.safeParse(JSON.parse(t.actor));
        if (parsed.success) actor = parsed.data;
      } catch {
        actor = null;
      }
    }
    return {
      ...local,
      actor,
      actorOp: actorOpOf(t.actor),
      ops: (ops.all(t.txn) as Array<{ body: string }>).map((o) =>
        LedgerOp.parse(JSON.parse(o.body)),
      ),
    };
  });
}

/** A local op's row undo: the merge state (and, once replayed, the values) before it. */
export interface RowUndo {
  readonly meta: RowMetaFull | null;
  readonly state: FieldStateSnapshot | null;
  /** Wire values before the op's last replay; null before its first. */
  readonly values: Readonly<Record<string, LedgerWireValue>> | null;
}

/**
 * The row undo of a sealed local op, or undefined when none was kept.
 *
 * @param db - The store.
 * @param txn - The local transaction.
 * @param idx - The op's index.
 * @returns The snapshot, or undefined.
 */
export function readRowUndo(db: DatabaseSync, txn: string, idx: number): RowUndo | undefined {
  const row = db
    .prepare(
      'SELECT meta_json, leave_json, values_json FROM _sync_row_undo WHERE txn = ? AND idx = ?',
    )
    .get(txn, idx) as
    | { meta_json: string | null; leave_json: string | null; values_json: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    meta: row.meta_json === null ? null : (JSON.parse(row.meta_json) as RowMetaFull),
    state: row.leave_json === null ? null : (JSON.parse(row.leave_json) as FieldStateSnapshot),
    values:
      row.values_json === null
        ? null
        : (JSON.parse(row.values_json) as Record<string, LedgerWireValue>),
  };
}

/**
 * Re-snapshot a local op's row undo right before a rebase replays it: the
 * merge state and the values it is about to write over, so the next rewind
 * restores exactly what this replay sat on (D2).
 *
 * @param db - The store, inside the rebase frame.
 * @param txn - The local transaction.
 * @param idx - The op's index.
 * @param tbl - The row's table.
 * @param uid - The row's uid.
 * @param values - The wire values the op is about to overwrite.
 */
export function resnapshotRowUndo(
  db: DatabaseSync,
  txn: string,
  idx: number,
  tbl: string,
  uid: string,
  values: Readonly<Record<string, LedgerWireValue>>,
): void {
  const meta = readRowMetaFull(db, tbl, uid);
  const leaves = readFieldLeaves(db, tbl, uid);
  const frontiers = readFieldFrontiers(db, tbl, uid);
  const state =
    Object.keys(leaves).length + Object.keys(frontiers).length > 0
      ? canonicalJson({ leaves, frontiers })
      : null;
  db.prepare(
    `INSERT INTO _sync_row_undo (txn, idx, tbl, uid, meta_json, leave_json, values_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (txn, idx) DO UPDATE SET meta_json = excluded.meta_json,
       leave_json = excluded.leave_json, values_json = excluded.values_json`,
  ).run(txn, idx, tbl, uid, meta ? canonicalJson(meta) : null, state, canonicalJson(values));
}

/** Undo a store may hold before it warns and schedules a rebind (§3.5 Rule 2, C1). */
export const UNDO_BUDGET_BYTES = 256 * 1024 * 1024;

/** The share of {@link UNDO_BUDGET_BYTES} at which `cleo doctor` and status warn. */
export const UNDO_BUDGET_WARN_RATIO = 0.8;

/**
 * `_sync_meta` key set (to when) the first time undo reached its budget: the
 * persistent `undo_budget_exceeded` warning, and the rebind it schedules for
 * the next pull to head (D5). Only that rebind clears it.
 */
export const UNDO_BUDGET_EXCEEDED_KEY = 'sync.undo_budget_exceeded';

/** How much undo a store holds against its budget (§3.5 Rule 2, D5). */
export interface UndoBudget {
  /**
   * Undo payload bytes (`_sync_undo` images plus `_sync_row_undo` snapshots),
   * by `octet_length()`: the stored size, read without decoding the text.
   */
  readonly bytes: number;
  readonly budget: number;
  /** `warn` from 80%; `exceeded` at 100% or once it has been (persistent). */
  readonly state: 'ok' | 'warn' | 'exceeded';
  /** When undo first reached the budget, or null. A rebind is scheduled from then. */
  readonly exceededAt: string | null;
}

/**
 * The store's undo against its budget. Read-only (a snapshot is fine).
 * Undo is never stopped: at 100% the replica keeps writing it, warns, and
 * rebinds at the next pull to head (D5).
 *
 * @param db - The store.
 * @param budget - The budget in bytes. @defaultValue UNDO_BUDGET_BYTES
 * @returns The bytes held, the budget and the warning state.
 */
export function undoBudget(db: DatabaseSync, budget: number = UNDO_BUDGET_BYTES): UndoBudget {
  const sum = (sql: string): number =>
    Number((db.prepare(sql).get() as { n: number | bigint | null }).n ?? 0);
  const bytes =
    (hasTable(db, '_sync_undo')
      ? sum(
          `SELECT sum(octet_length(tbl) + octet_length(rk) + coalesce(octet_length(uid), 0)
             + coalesce(octet_length(before_full), 0) + coalesce(octet_length(after_full), 0)) AS n FROM _sync_undo`,
        )
      : 0) +
    (hasTable(db, '_sync_row_undo')
      ? sum(
          `SELECT sum(octet_length(tbl) + octet_length(uid) + coalesce(octet_length(meta_json), 0)
             + coalesce(octet_length(leave_json), 0) + coalesce(octet_length(values_json), 0)
             + coalesce(octet_length(kept_json), 0)) AS n FROM _sync_row_undo`,
        )
      : 0);
  const flagged = hasTable(db, '_sync_meta')
    ? ((
        db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(UNDO_BUDGET_EXCEEDED_KEY) as
          | { value: string }
          | undefined
      )?.value ?? null)
    : null;
  const state =
    flagged !== null || bytes >= budget
      ? 'exceeded'
      : bytes >= budget * UNDO_BUDGET_WARN_RATIO
        ? 'warn'
        : 'ok';
  return { bytes, budget, state, exceededAt: flagged };
}

/**
 * {@link undoBudget}, persisting the `undo_budget_exceeded` warning the first
 * time undo reaches the budget (a pull's check; D5).
 *
 * @param db - The store, outside a transaction.
 * @param nowIso - Now (ISO-8601).
 * @param budget - The budget in bytes. @defaultValue UNDO_BUDGET_BYTES
 * @returns The budget state after recording.
 */
export function recordUndoBudget(
  db: DatabaseSync,
  nowIso: string,
  budget: number = UNDO_BUDGET_BYTES,
): UndoBudget {
  const now = undoBudget(db, budget);
  if (now.exceededAt !== null || now.bytes < budget) return now;
  db.prepare(
    `INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING`,
  ).run(UNDO_BUDGET_EXCEEDED_KEY, nowIso, nowIso);
  return { ...now, exceededAt: nowIso };
}
