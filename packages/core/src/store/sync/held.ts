/**
 * Held rows (journal spec §3.5 Rule 5; T13193 R-3, T13269).
 *
 * A local op a scoped rebase cannot replay stays rewound and is held until
 * its echo is decided: the stream refused it (a dangling reference, a typed
 * rule, a guard, a post-apply check), so it is sent and sequenced as usual,
 * and the stream applies or voids it. While held:
 *
 * - its row meta carries `held = 1`, so the ledger check, the repair diff
 *   and the Gate D manifest skip the row (no spurious repair D for a held
 *   insert, whose meta has no live row);
 * - `_sync_ledger` moves by the op's row-count effect, in both `live` and
 *   `held`, so `live = count(*) + held` keeps holding;
 * - its row undo records when, why (the conflict preview `cleo show` returns
 *   with `E_SYNC_HELD`), and, for an insert, what the rewind kept that the
 *   stream cannot bring back (local-only columns, FK children outside the
 *   sync set), restored if the insert applies later.
 *
 * A rebase that rewinds a held op lifts the hold first and decides again.
 * A held transaction's echo never takes the own-echo fast path, so its echo
 * is always decided in a rebase, whose rewind lifts the hold.
 *
 * @task T13193
 * @module store/sync/held
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { LedgerOp, type LedgerWireValue } from '@cleocode/contracts/ledger';
import type { LAFSError } from '@cleocode/lafs';
import { CleoError } from '../../errors.js';
import { getDualScopeNativeDb, openDualScopeDb } from '../dual-scope-db.js';
import type { LocalDescendants } from './apply/write-api.js';
import { type RowMetaFull, readRowMetaFull, restoreRowMeta } from './row-meta.js';
import { hasTable } from './schema.js';

/** What a rewound insert kept that the stream cannot bring back (R7-2). */
export interface KeptRow {
  /** Its local-only columns, or null when the row had none to keep. */
  readonly local: Record<string, SQLInputValue> | null;
  /** Its FK children outside the sync set, removed by the rewind's DELETE. */
  readonly descendants: LocalDescendants;
}

/** One op to hold. */
export interface HoldInput {
  readonly txn: string;
  readonly idx: number;
  readonly op: LedgerOp;
  /** Whether the op's row exists now (after the rewind). */
  readonly exists: boolean;
  /** What refused the replay (the conflict preview). */
  readonly reason: string;
  /** The row's meta as the op left it, before the rewind (an insert's meta). */
  readonly afterMeta: RowMetaFull | null;
  readonly kept: KeptRow | null;
  readonly nowIso: string;
}

/** A held op, as its row undo records it. */
export interface HeldOp {
  readonly txn: string;
  readonly idx: number;
  readonly tbl: string;
  readonly uid: string;
  readonly at: string;
  readonly reason: string;
  /** The row-count effect the ledger moved by while held. */
  readonly effect: number;
  readonly kept: KeptRow | null;
}

/** A tagged JSON value: bigints and blobs survive the round trip. */
type KeptJson = string | number | null | { $i: string } | { $b: string };

function encodeValue(v: SQLInputValue): KeptJson {
  if (typeof v === 'bigint') return { $i: v.toString() };
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  return { $b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
}

function decodeValue(v: KeptJson): SQLInputValue {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if ('$i' in v) return BigInt(v.$i);
  return Buffer.from(v.$b, 'base64');
}

function mapValues<A, B>(o: Readonly<Record<string, A>>, f: (v: A) => B): Record<string, B> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
}

/** What a rewound insert kept, as text for `_sync_row_undo.kept_json`. */
function encodeKept(k: KeptRow): string {
  return JSON.stringify({
    local: k.local ? mapValues(k.local, encodeValue) : null,
    rows: k.descendants.rows.map((r) => ({
      table: r.table,
      values: mapValues(r.values, encodeValue),
    })),
    cleared: k.descendants.cleared.map((c) => ({
      table: c.table,
      where: mapValues(c.where, encodeValue),
      column: c.column,
      value: encodeValue(c.value),
    })),
  });
}

function decodeKept(text: string): KeptRow {
  const j = JSON.parse(text) as {
    local: Record<string, KeptJson> | null;
    rows: Array<{ table: string; values: Record<string, KeptJson> }>;
    cleared: Array<{
      table: string;
      where: Record<string, KeptJson>;
      column: string;
      value: KeptJson;
    }>;
  };
  return {
    local: j.local ? mapValues(j.local, decodeValue) : null,
    descendants: {
      rows: j.rows.map((r) => ({ table: r.table, values: mapValues(r.values, decodeValue) })),
      cleared: j.cleared.map((c) => ({
        table: c.table,
        where: mapValues(c.where, decodeValue),
        column: c.column,
        value: decodeValue(c.value),
      })),
    },
  };
}

/** Move `table`'s ledger by `live` and `held` (no row yet: the sealer's first sight counts it). */
function adjustLedger(db: DatabaseSync, table: string, live: number, held: number): void {
  if (live === 0 && held === 0) return;
  db.prepare('UPDATE _sync_ledger SET live = live + ?, held = held + ? WHERE tbl = ?').run(
    live,
    held,
    table,
  );
}

/**
 * Account a rebase's own row-count change to `table` (a rewind's delete or
 * re-insert, a replay's insert or delete). Rewind and replay write with
 * capture suspended, so the sealer never sees them; without this the ledger
 * would drift by every rewound insert whose echo then applies.
 *
 * @param db - The store, inside the rebase frame.
 * @param table - Sync-set table.
 * @param delta - Rows added (positive) or removed (negative).
 */
export function accountRebaseRows(db: DatabaseSync, table: string, delta: number): void {
  adjustLedger(db, table, delta, 0);
}

/**
 * Hold an op the replay left rewound: mark its row meta held (creating it
 * from the op's after-meta for an insert, whose rewind removed it), move the
 * ledger by its row-count effect, and record the hold on its row undo.
 *
 * @param db - The store, inside the rebase frame.
 * @param h - The op and why it is held.
 */
export function holdOp(db: DatabaseSync, h: HoldInput): void {
  const { op } = h;
  const effect = op.o === 'I' && !h.exists ? 1 : op.o === 'D' && h.exists ? -1 : 0;
  const meta = readRowMetaFull(db, op.t, op.u) ?? h.afterMeta;
  if (meta) restoreRowMeta(db, op.t, op.u, { ...meta, held: 1 });
  adjustLedger(db, op.t, effect, effect);
  db.prepare(
    `UPDATE _sync_row_undo SET held_at = ?, held_reason = ?, held_effect = ?, kept_json = ?
      WHERE txn = ? AND idx = ?`,
  ).run(
    h.nowIso,
    h.reason.slice(0, 500),
    effect,
    h.kept && op.o === 'I' ? encodeKept(h.kept) : null,
    h.txn,
    h.idx,
  );
}

/**
 * The hold on a local op, or null when it is not held.
 *
 * @param db - The store.
 * @param txn - The local transaction.
 * @param idx - The op's index.
 */
export function heldOp(db: DatabaseSync, txn: string, idx: number): HeldOp | null {
  const r = db
    .prepare(
      `SELECT txn, idx, tbl, uid, held_at, held_reason, held_effect, kept_json FROM _sync_row_undo
        WHERE txn = ? AND idx = ? AND held_at IS NOT NULL`,
    )
    .get(txn, idx) as HeldRow | undefined;
  return r ? toHeld(r) : null;
}

type HeldRow = {
  txn: string;
  idx: number;
  tbl: string;
  uid: string;
  held_at: string;
  held_reason: string | null;
  held_effect: number;
  kept_json: string | null;
};

function toHeld(r: HeldRow): HeldOp {
  return {
    txn: r.txn,
    idx: Number(r.idx),
    tbl: r.tbl,
    uid: r.uid,
    at: r.held_at,
    reason: r.held_reason ?? '',
    effect: Number(r.held_effect),
    kept: r.kept_json ? decodeKept(r.kept_json) : null,
  };
}

/**
 * Lift the hold on a local op: reverse its ledger effect, clear `held` in
 * its row meta, and clear the hold (what it kept stays, for a later apply).
 *
 * @param db - The store, inside the frame.
 * @param txn - The local transaction.
 * @param idx - The op's index.
 */
export function unholdOp(db: DatabaseSync, txn: string, idx: number): void {
  const h = heldOp(db, txn, idx);
  if (!h) return;
  adjustLedger(db, h.tbl, -h.effect, -h.effect);
  const meta = readRowMetaFull(db, h.tbl, h.uid);
  if (meta?.held) restoreRowMeta(db, h.tbl, h.uid, { ...meta, held: 0 });
  db.prepare(
    'UPDATE _sync_row_undo SET held_at = NULL, held_reason = NULL, held_effect = 0 WHERE txn = ? AND idx = ?',
  ).run(txn, idx);
}

/**
 * Whether a local transaction has a held op.
 *
 * @param db - The store.
 * @param txn - The local transaction.
 */
export function txnHasHold(db: DatabaseSync, txn: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM _sync_row_undo WHERE txn = ? AND held_at IS NOT NULL LIMIT 1')
      .get(txn) !== undefined
  );
}

/** A held insert, as `cleo show` reports it. */
export interface HeldInsert {
  readonly table: string;
  readonly uid: string;
  readonly txn: string;
  readonly heldAt: string;
  /** The conflict preview: what refused the replay. */
  readonly reason: string;
  /** The values the insert would write (its sealed after-image, references as uids). */
  readonly values: Readonly<Record<string, LedgerWireValue>>;
}

/**
 * Every held op, oldest first (for `cleo sync status` and `cleo doctor`).
 *
 * @param db - The store.
 * @returns The holds, or none when the journal has no row undo.
 */
export function listHeldOps(db: DatabaseSync): HeldOp[] {
  if (!hasTable(db, '_sync_row_undo')) return [];
  return (
    db
      .prepare(
        `SELECT txn, idx, tbl, uid, held_at, held_reason, held_effect, kept_json FROM _sync_row_undo
          WHERE held_at IS NOT NULL ORDER BY held_at, txn, idx`,
      )
      .all() as HeldRow[]
  ).map(toHeld);
}

/**
 * The held insert into `table` whose sealed values carry `column = value`
 * (a held row is absent, so `cleo show` finds it here), or null.
 *
 * @param db - The store.
 * @param table - Sync-set table.
 * @param column - A column of the insert's after-image (for tasks, `id`).
 * @param value - The value it must carry.
 * @returns The held insert, or null.
 */
export function findHeldInsert(
  db: DatabaseSync,
  table: string,
  column: string,
  value: string,
): HeldInsert | null {
  if (!hasTable(db, '_sync_row_undo')) return null;
  const rows = db
    .prepare(
      `SELECT u.txn, u.uid, u.held_at, u.held_reason, o.body FROM _sync_row_undo u
         JOIN _sync_op o ON o.txn = u.txn AND o.idx = u.idx
        WHERE u.tbl = ? AND u.held_at IS NOT NULL AND u.held_effect = 1`,
    )
    .all(table) as Array<{
    txn: string;
    uid: string;
    held_at: string;
    held_reason: string | null;
    body: string;
  }>;
  for (const r of rows) {
    const op = LedgerOp.parse(JSON.parse(r.body));
    if (op.a?.[column] !== value) continue;
    const values: Record<string, LedgerWireValue> = {};
    for (const [k, v] of Object.entries(op.a ?? {})) {
      if (typeof v !== 'object' || v === null || !('$inc' in v)) values[k] = v as LedgerWireValue;
    }
    return {
      table,
      uid: r.uid,
      txn: r.txn,
      heldAt: r.held_at,
      reason: r.held_reason ?? '',
      values,
    };
  }
  return null;
}

/**
 * The held insert of task `id` in this project's store, or null (also when
 * the store cannot be read: the caller's not-found stands).
 *
 * @param id - The task id (`T…`).
 * @param cwd - The project directory.
 * @returns The held insert, or null.
 */
export async function findHeldTask(id: string, cwd?: string): Promise<HeldInsert | null> {
  try {
    const db = getDualScopeNativeDb(await openDualScopeDb('project', cwd));
    return findHeldInsert(db, 'tasks_tasks', 'id', id);
  } catch {
    return null;
  }
}

/**
 * `cleo show` of a row a rebase holds (§3.5 Rule 5): not `E_NOT_FOUND`, but
 * `E_SYNC_HELD`, with the held values and the conflict preview. The insert
 * is sent and the stream decides it: applied (its parent came back) or
 * voided with a visible conflict.
 */
export class SyncHeldError extends CleoError {
  /** Stable string error code for envelope `codeName` / log correlation. */
  readonly codeName = 'E_SYNC_HELD' as const;
  /** The held insert. */
  readonly held: HeldInsert;

  /**
   * @param id - The id the caller asked for.
   * @param held - The held insert.
   */
  constructor(id: string, held: HeldInsert) {
    super(
      ExitCode.NOT_FOUND,
      `${id} is held by a sync rebase: ${held.reason || 'the stream refused its replay'}. It is sent; the stream applies or voids it.`,
      {
        fix: `Resolve what blocks it (cleo cloud conflicts), or wait for its echo to be decided`,
        details: {
          field: 'id',
          actual: id,
          held: { table: held.table, uid: held.uid, txn: held.txn, heldAt: held.heldAt },
          preview: held.reason,
          values: held.values,
        },
      },
    );
    this.name = 'SyncHeldError';
    this.held = held;
  }

  /** The LAFS error, coded `E_SYNC_HELD`. */
  override toLAFSError(): LAFSError {
    return { ...super.toLAFSError(), code: this.codeName };
  }
}
