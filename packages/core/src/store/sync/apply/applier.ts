/**
 * The applier loop (T12344; journal spec §3.1, §3.2, §2.9).
 *
 * {@link applyStagedTxns} drains a stream's inbox in `(seq, txn_idx)` order.
 * Each transaction is decided and applied in ONE apply frame, together with
 * its status, its conflict records, its row meta and its leaves:
 *
 * 1. **Schema.** A segment or transaction format newer than this build is
 *    `refused-schema` (E_SCHEMA_AHEAD), kept for replay after an upgrade.
 * 2. **Skew (§1.3).** A transaction whose HLC is beyond the skew bound is
 *    `held-skew`, and so is every later transaction of the same origin
 *    replica in this pass (FIFO); other replicas keep flowing.
 * 3. **Dependency holds.** A transaction touching a row a pending
 *    transaction writes waits (`pending`) behind it. Holds are scoped to
 *    those rows, never head-of-line.
 * 4. **Plan** (nothing written). Each op is decided against the store's
 *    state carried forward inside the transaction. The transaction is
 *    `pending` when an op updates a row never seen, re-keys a row never
 *    seen, references a target never seen (§3.2 NEW-2: no age limit), or
 *    carries a secret (not unsealed yet); `refused-schema` when an op names
 *    an unknown table or column, or is malformed.
 * 5. **Apply**, op by op, each against the store as it is now and inside its
 *    own savepoint:
 *    - references travel as target uids and are written as the targets'
 *      local keys ({@link resolveRef}, following `tasks_uid_aliases`); a
 *      reference to a deleted target is a `dangling-ref` conflict and a
 *      revivable void, never pending;
 *    - a guard trigger or constraint that aborts the write rolls back only
 *      that op: a `guard` conflict and a void (§3.2 D, T12777);
 *    - a parent delete whose CASCADE sync-set children remain follows the
 *      table's `onRemoteParentDelete` policy: `conflict` voids it with a
 *      `delete-with-live-children` conflict, `cascade-with-ops` deletes the
 *      children first with tombstones;
 *    - a K op re-keys the row through the write API (its meta and typed-rule
 *      state move with it), after `remapPending` moves local captures and
 *      unsent ops onto the new uid; a re-key onto a live uid is a
 *      `uid-collision` void.
 *    The effects go through the write API, which records the apply intents,
 *    so the sealer echoes nothing; row meta is set to the engine's state,
 *    conflicts are recorded, and the transaction is marked `applied`,
 *    `conflict` (something recorded) or `void` (every op refused).
 *
 * Passes repeat while a pass applies something, so a transaction pending on
 * a row a later transaction inserts applies in the same call.
 *
 * Deletes run with foreign keys ON: the origin journals cascaded child Ds
 * before the parent's D, so a child D whose row is already gone applies as a
 * tombstone, never a missing-row failure; and SET NULL actions are not
 * journaled yet (T13226), so this replica's own FK actions fill that gap
 * (the delete records their intents, so nothing is re-emitted).
 *
 * Out of this slice: Gate C validators (PR-5), soft references across
 * streams (`_sync_soft_ref`), holds that follow a re-keyed uid, and the
 * scoped rebase (§3.5).
 *
 * @module store/sync/apply/applier
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { LedgerOp, LedgerWireValue } from '@cleocode/contracts/ledger';
import { BIRTH_FP_COLUMN, UID_COLUMN } from '../../row-identity-registry.js';
import { type CaptureTableDef, captureTableDef } from '../capture.js';
import { recordConflicts } from '../conflicts.js';
import {
  clearFieldLeaves,
  type FieldFrontier,
  readFieldFrontiers,
  readFieldLeaves,
  recordFieldLeaves,
  setFieldFrontiers,
} from '../field-leave.js';
import { encodeHlc, genesisHlc, isWithinSkew, parseHlc } from '../hlc.js';
import { type InboxKey, type InboxStatus, markTxns, type StagedTxn, stagedTxns } from '../inbox.js';
import { applyOp, checkSchemaVersion } from '../merge/engine.js';
import { mergeSpecFor } from '../merge/rules.js';
import {
  type FieldState,
  type MergeConflict,
  type OpOutcome,
  type RowState,
  type TableMergeSpec,
  UNSEEN_ROW,
} from '../merge/types.js';
import { remapPending } from '../remap.js';
import { fieldHlcsOf } from '../row-meta.js';
import { canonicalJson } from '../sealer-values.js';
import { type ApplyApi, withApplyFrame } from './frame.js';
import { parentDeletePolicy } from './parent-delete.js';
import { checkApplyPreconditions, checkTaskTreeShape, type PageRow } from './post-apply.js';
import { resolveRef, uidOfKey } from './refs.js';

/** How {@link applyStagedTxns} runs. */
export interface ApplyStagedOptions {
  readonly scope: TableScope;
  readonly stream: string;
  /** This replica's id: its clock receives every applied transaction. */
  readonly replica: string;
  /** The wall clock in ms; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Seal this replica's pending captures first (§3.2 step 1), so the row
   * meta the merge reads covers every local write.
   */
  readonly seal?: () => void;
  /** At most this many passes; defaults to 16. */
  readonly maxPasses?: number;
}

/** What one {@link applyStagedTxns} call left in the inbox, per status. */
export interface ApplyReport {
  readonly applied: number;
  readonly conflict: number;
  readonly void: number;
  readonly pending: number;
  readonly heldSkew: number;
  readonly refusedSchema: number;
  /** Conflict records written. */
  readonly conflicts: number;
  readonly passes: number;
  /** Why nothing was applied (PAC-15 apply preconditions), when so. */
  readonly blocked?: string;
}

/** An op's decision inside its transaction. */
interface Decided {
  readonly op: LedgerOp;
  readonly def: CaptureTableDef;
  readonly before: RowState;
  readonly out: OpOutcome;
  /** Reference columns' local keys (wire uid → target key). */
  readonly refKeys: ReadonlyMap<string, LedgerWireValue>;
}

/** What applying one op did. */
type OpResult = 'applied' | 'void' | 'skipped';

/** The decision for a whole transaction. */
type TxnPlan =
  | { readonly kind: 'apply' }
  | {
      readonly kind: 'pending';
      readonly reason: string;
      /** Rows later transactions must not write before this one applies. */
      readonly holds: readonly string[];
    }
  | { readonly kind: 'refused-schema'; readonly reason: string };

const rowKey = (t: string, u: string): string => `${t}\u0000${u}`;
const keyText = (k: InboxKey): string => `${k.stream}:${k.seq}:${k.txnIdx}`;

/**
 * The row's state as the merge sees it: the live row with its field HLCs
 * and leaves, a tombstone, or never seen. A live row with no row meta (not
 * yet sealed) carries the genesis HLC, so any stream write wins over it.
 */
function loadRowState(
  db: DatabaseSync,
  api: ApplyApi,
  def: CaptureTableDef,
  uid: string,
  localReplica: string,
): RowState {
  const meta = api.rowMeta(def.table, uid);
  const row = api.readRow(def.table, uid);
  if (row === null) {
    return meta?.deleted ? { live: false, tombstone: meta.hlc, fields: {} } : UNSEEN_ROW;
  }
  const floor = encodeHlc(genesisHlc(localReplica));
  const fh = meta && !meta.deleted ? fieldHlcsOf(def, meta) : {};
  const leaves = readFieldLeaves(db, def.table, uid);
  const frontiers = readFieldFrontiers(db, def.table, uid);
  const fields: Record<string, FieldState> = {};
  for (const [col, stored] of Object.entries(row)) {
    // The merge compares stream values: a reference reads as its target's uid.
    const target = def.refs.get(col);
    const value = target && stored !== null ? (uidOfKey(db, target, stored) ?? stored) : stored;
    const hlc = fh[col] ?? (meta && !meta.deleted ? meta.hlc : floor);
    const leave = leaves[col];
    const frontier = frontiers[col];
    fields[col] = {
      value,
      hlc,
      ...(leave !== undefined ? { leave } : {}),
      ...(frontier !== undefined ? { frontier } : {}),
    };
  }
  return { live: true, tombstone: null, fields };
}

/**
 * This replica's own echo (§3.1: own segments are staged and applied like
 * any other) without its counter deltas: a `{ $inc }` the replica authored is
 * already in its row, and applying it again would double it. Everything else
 * is idempotent for an echo (the fields already carry the op's HLCs).
 */
function ownEcho(op: LedgerOp, st: StagedTxn, localReplica: string): LedgerOp {
  if (st.replicaId !== localReplica || !op.a) return op;
  const a = Object.fromEntries(
    Object.entries(op.a).filter(([, v]) => !(typeof v === 'object' && v !== null && '$inc' in v)),
  );
  return { ...op, a };
}

/** Why this slice cannot apply `op` yet, or null. */
function notYet(op: LedgerOp, def: CaptureTableDef): string | null {
  for (const [col, v] of Object.entries(op.a ?? {})) {
    if (v !== null && def.secret.has(col))
      return `${op.t}/${op.u}: secret ${col} (needs unsealing)`;
  }
  return null;
}

/** Whether a row with `uid` exists in `table`. */
function rowExists(api: ApplyApi, table: string, uid: string): boolean {
  return api.readRow(table, uid) !== null;
}

/**
 * A missing reference of `op` (a target never seen), or null. A target the
 * transaction itself inserts or re-keys to counts as present wherever its op
 * sits: netting keeps an op at its FIRST capture, so a row may reference a
 * row inserted after it in the same transaction (T13238).
 */
function missingRef(
  db: DatabaseSync,
  op: LedgerOp,
  def: CaptureTableDef,
  inTxn: ReadonlySet<string>,
): { readonly col: string; readonly uid: string } | 'malformed' | null {
  for (const [col, v] of Object.entries(op.a ?? {})) {
    const target = def.refs.get(col);
    if (!target || v === null) continue;
    if (typeof v !== 'string') return 'malformed';
    if (inTxn.has(rowKey(target.table, v))) continue;
    if (resolveRef(db, target, v).kind === 'missing') return { col, uid: v };
  }
  return null;
}

/** Decide every op of `txn` against the store, carrying row state forward. */
function planTxn(
  db: DatabaseSync,
  api: ApplyApi,
  st: StagedTxn,
  defs: (table: string) => CaptureTableDef | null,
  localReplica: string,
): TxnPlan {
  const states = new Map<string, RowState>();
  const specs = new Map<string, TableMergeSpec>();
  // Rows the transaction itself creates: its inserts and re-key targets.
  const txnRows = new Set(
    st.txn.ops.flatMap((o) =>
      o.o === 'I' ? [rowKey(o.t, o.u)] : o.o === 'K' && o.nu ? [rowKey(o.t, o.nu)] : [],
    ),
  );
  // Rows a pending transaction holds: every row it writes but the one it waits for.
  const holds = (except?: string): string[] => [
    ...new Set(st.txn.ops.map((o) => rowKey(o.t, o.u)).filter((k) => k !== except)),
  ];
  for (const op of st.txn.ops) {
    const def = defs(op.t);
    if (!def) return { kind: 'refused-schema', reason: `unknown table ${op.t}` };
    const blocked = notYet(op, def);
    if (blocked !== null) return { kind: 'pending', reason: blocked, holds: holds() };
    const k = rowKey(op.t, op.u);
    if (op.o === 'K') {
      const nu = op.nu ?? op.u;
      const known = (u: string): boolean =>
        states.get(rowKey(op.t, u))?.live === true ||
        rowExists(api, op.t, u) ||
        api.rowMeta(op.t, u)?.deleted === 1;
      if (!known(op.u) && !known(nu)) {
        return {
          kind: 'pending',
          reason: `${op.t}/${op.u}: re-key of a row not seen yet`,
          holds: holds(k),
        };
      }
      continue;
    }
    const missing = missingRef(db, op, def, txnRows);
    if (missing === 'malformed') {
      return { kind: 'refused-schema', reason: `${op.t}/${op.u}: a reference that is not a uid` };
    }
    if (missing !== null) {
      return {
        kind: 'pending',
        reason: `${op.t}/${op.u}: reference ${missing.col} to ${missing.uid} not seen yet`,
        holds: holds(),
      };
    }
    const before = states.get(k) ?? loadRowState(db, api, def, op.u, localReplica);
    let spec = specs.get(op.t);
    if (!spec) {
      spec = mergeSpecFor(op.t, def.columns);
      specs.set(op.t, spec);
    }
    const out = applyOp(before, ownEcho(op, st, localReplica), {
      table: spec,
      actorOp: st.txn.actor?.op ?? null,
    });
    if (out.status === 'refused-schema') {
      const reason = out.malformed?.length
        ? `${op.t}/${op.u}: malformed column(s) ${out.malformed.join(', ')}`
        : `${op.t}: unknown column(s) ${(out.unknownColumns ?? []).join(', ')}`;
      return { kind: 'refused-schema', reason };
    }
    if (out.status === 'pending') {
      return { kind: 'pending', reason: `${op.t}/${op.u}: row not seen yet`, holds: holds(k) };
    }
    states.set(k, out.next);
  }
  return { kind: 'apply' };
}

/** Values of `cols` in the merged row. */
function valuesOf(next: RowState, cols: readonly string[]): Record<string, LedgerWireValue> {
  const out: Record<string, LedgerWireValue> = {};
  for (const c of cols) {
    const f = next.fields[c];
    if (f) out[c] = f.value;
  }
  return out;
}

/** {@link valuesOf} with reference uids translated to the targets' local keys. */
function localValues(
  next: RowState,
  cols: readonly string[],
  refKeys: ReadonlyMap<string, LedgerWireValue>,
): Record<string, LedgerWireValue> {
  const out = valuesOf(next, cols);
  for (const c of Object.keys(out)) {
    const key = refKeys.get(c);
    if (key !== undefined && out[c] !== null) out[c] = key;
  }
  return out;
}

/** Perform one decided op through the write API; returns the conflicts recorded. */
function effect(
  db: DatabaseSync,
  api: ApplyApi,
  st: StagedTxn,
  opIdx: number,
  d: Decided,
  nowIso: string,
): number {
  const { op, def, before, out } = d;
  const actor = st.txn.actor ? JSON.stringify(st.txn.actor) : null;
  const meta = { origin: st.replicaId, actor, keyJson: op.k ? canonicalJson(op.k) : null };
  // Merged field HLCs; on insert a column the op omits (a NULL) is at op.h.
  const liveHlcs = (): Record<string, string> => {
    const m: Record<string, string> = {};
    if (out.effect === 'insert') for (const c of def.columns) m[c] = op.h;
    for (const [c, f] of Object.entries(out.next.fields)) m[c] = f.hlc;
    return m;
  };
  switch (out.effect) {
    case 'insert': {
      // The sealer sends the birth fingerprint as `bfp`, not in `a` (identity
      // columns are read from the live row at capture); the insert needs it.
      const values = localValues(out.next, out.written, d.refKeys);
      if (def.identity.includes(BIRTH_FP_COLUMN) && values[BIRTH_FP_COLUMN] == null && op.bfp) {
        values[BIRTH_FP_COLUMN] = op.bfp;
      }
      api.insertRow(op.t, op.u, values);
      api.setMergedRowMeta(op.t, op.u, {
        ...meta,
        fieldHlc: liveHlcs(),
        tombstone: null,
        bfp: op.bfp ?? null,
      });
      break;
    }
    case 'update':
      api.writeFields(op.t, op.u, localValues(out.next, out.written, d.refKeys));
      api.setMergedRowMeta(op.t, op.u, { ...meta, fieldHlc: liveHlcs(), tombstone: null });
      break;
    case 'delete':
    case 'tombstone': {
      if (out.effect === 'delete') api.deleteRow(op.t, op.u);
      clearFieldLeaves(db, op.t, op.u);
      api.setMergedRowMeta(op.t, op.u, {
        ...meta,
        fieldHlc: {},
        tombstone: out.next.tombstone,
        chash: api.rowMeta(op.t, op.u)?.chash ?? null,
        bfp: op.bfp ?? null,
      });
      break;
    }
    case 'none':
      // A later delete of a deleted row moves its tombstone forward.
      if (!out.next.live && out.next.tombstone !== before.tombstone) {
        api.setMergedRowMeta(op.t, op.u, {
          ...meta,
          fieldHlc: {},
          tombstone: out.next.tombstone,
          chash: api.rowMeta(op.t, op.u)?.chash ?? null,
        });
      }
      break;
  }
  if (out.next.live) {
    const leaves: Record<string, string> = {};
    const frontiers: Record<string, FieldFrontier | null> = {};
    for (const [c, f] of Object.entries(out.next.fields)) {
      const was = before.fields[c];
      if (f.leave !== undefined && f.leave !== was?.leave) leaves[c] = f.leave;
      if (canonicalJson(f.frontier ?? null) !== canonicalJson(was?.frontier ?? null)) {
        frontiers[c] = f.frontier ?? null;
      }
    }
    recordFieldLeaves(db, op.t, op.u, leaves);
    setFieldFrontiers(db, op.t, op.u, frontiers);
  }
  recordConflicts(db, { ...st.key, opIdx }, out.conflicts, st.replicaId, nowIso);
  return out.conflicts.length;
}

/**
 * The page PAC-01 judges: only rows whose shape this transaction could have
 * changed (an insert, a re-key, or an op carrying `parent_id` or `type`).
 * A row that already broke the matrix before (legacy data) never voids an
 * unrelated edit of it; two valid ops that merge into a bad tree each carry
 * one of those columns, so nothing introduced is missed (T13244).
 */
function treeShapePage(ops: readonly LedgerOp[]): PageRow[] {
  return ops
    .filter(
      (o) =>
        o.o === 'I' || o.o === 'K' || (o.a !== undefined && ('parent_id' in o.a || 'type' in o.a)),
    )
    .map((o) => ({
      table: o.t,
      uid: o.o === 'K' && o.nu ? o.nu : o.u,
      typeChanged: o.o === 'I' || (o.a !== undefined && 'type' in o.a),
    }));
}

/** The status of an applied transaction from its ops' results. */
function txnStatus(results: readonly OpResult[], conflicts: number): InboxStatus {
  const voided = results.filter((r) => r === 'void').length;
  const effective = results.filter((r) => r === 'applied').length;
  if (voided > 0 && effective === 0) return 'void';
  return conflicts > 0 ? 'conflict' : 'applied';
}

/** SQLite's primary result code for a constraint violation (trigger RAISE, FK, UNIQUE, CHECK, NOT NULL). */
const SQLITE_CONSTRAINT = 19;

/**
 * A write the store refused by rule: a guard trigger's `RAISE(ABORT)` or a
 * constraint (primary code SQLITE_CONSTRAINT). Anything else (disk full, I/O,
 * corruption, read-only, a schema error) is not the op's fault: it fails the
 * pass, to be retried, and never voids a remote op (T13239).
 */
function isGuardRefusal(err: unknown): err is Error {
  return (
    err instanceof Error &&
    'errcode' in err &&
    typeof err.errcode === 'number' &&
    (err.errcode & 0xff) === SQLITE_CONSTRAINT
  );
}

/**
 * The order to apply a transaction's ops in: its own order, except that an
 * insert another op references comes before that op (T13238). Netting keeps
 * each row's single op at its first capture, so `I A(parent = B)` can precede
 * `I B`; with immediate foreign keys A's insert would fail. Each row has one
 * op per transaction, so moving an insert never reorders a row's own ops. A
 * reference cycle keeps the original order (its first insert then fails as a
 * guard conflict). An insert is never hoisted ahead of an earlier delete on
 * its table, so a natural-key re-add keeps its order.
 */
function applyOrder(
  ops: readonly LedgerOp[],
  defs: (table: string) => CaptureTableDef | null,
): number[] {
  const insertAt = new Map<string, number>();
  ops.forEach((o, i) => {
    if (o.o === 'I') insertAt.set(rowKey(o.t, o.u), i);
  });
  const order: number[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (i: number): void => {
    if (state.has(i)) return;
    state.set(i, 'visiting');
    const op = ops[i] as LedgerOp;
    // An insert never moves ahead of a delete on its table that preceded it:
    // a natural-key re-add (D X, I Y with X's key) must keep its order.
    if (op.o === 'I') {
      for (let k = 0; k < i; k++) {
        const prior = ops[k] as LedgerOp;
        if (prior.o === 'D' && prior.t === op.t && state.get(k) !== 'visiting') visit(k);
      }
    }
    const def = defs(op.t);
    for (const [col, v] of Object.entries(op.a ?? {})) {
      const target = def?.refs.get(col);
      if (!target || typeof v !== 'string') continue;
      const j = insertAt.get(rowKey(target.table, v));
      if (j !== undefined && j !== i && state.get(j) !== 'visiting') visit(j);
    }
    state.set(i, 'done');
    order.push(i);
  };
  ops.forEach((_, i) => {
    visit(i);
  });
  return order;
}

/** Everything one op's apply needs. */
interface OpContext {
  readonly db: DatabaseSync;
  readonly api: ApplyApi;
  readonly st: StagedTxn;
  readonly defs: (table: string) => CaptureTableDef | null;
  readonly replica: string;
  readonly nowIso: string;
}

const voidWith = (
  c: OpContext,
  opIdx: number,
  conflict: MergeConflict,
): { readonly result: OpResult; readonly conflicts: number } => {
  recordConflicts(c.db, { ...c.st.key, opIdx }, [conflict], c.st.replicaId, c.nowIso);
  return { result: 'void', conflicts: 1 };
};

/** Apply a K op: move the row to its new uid (and birth fingerprint). */
function applyRekey(
  c: OpContext,
  opIdx: number,
  op: LedgerOp,
): { readonly result: OpResult; readonly conflicts: number } {
  const nu = op.nu ?? op.u;
  const oldLive = rowExists(c.api, op.t, op.u);
  const newLive = nu !== op.u && rowExists(c.api, op.t, nu);
  if (!oldLive) return { result: 'skipped', conflicts: 0 }; // already re-keyed, or deleted
  if (newLive || (nu !== op.u && c.api.rowMeta(op.t, nu) !== undefined)) {
    return voidWith(c, opIdx, {
      kind: 'uid-collision',
      table: op.t,
      uid: op.u,
      columns: [UID_COLUMN],
      resolution: 'op-voided',
      opHlc: op.h,
    });
  }
  // Local captures and unsent ops still naming the old uid follow it (§3.3 G).
  // First: remapping after the re-key would rewrite the re-key's own capture,
  // and it would no longer match its `*K` intent.
  remapPending(c.db, { table: op.t, oldUid: op.u, newUid: nu, newBfp: op.bfp ?? null });
  c.api.rekeyRow(op.t, op.u, nu, op.bfp ?? null);
  return { result: 'applied', conflicts: 0 };
}

/**
 * Delete a row and, depth-first, its CASCADE sync-set children, each with a
 * tombstone. `seen` stops a reference cycle in the data. Children without a
 * uid are not listed (`childRows`), so SQLite's own cascade removes them
 * with no intent; every sync-set row has a uid while row uids are on.
 */
function cascadeDelete(
  c: OpContext,
  table: string,
  uid: string,
  h: string,
  actor: string | null,
  seen: Set<string> = new Set(),
): void {
  if (seen.has(rowKey(table, uid))) return;
  seen.add(rowKey(table, uid));
  for (const child of c.api.childRows(table, uid)) {
    if (child.key.onDelete === 'CASCADE') {
      cascadeDelete(c, child.key.child, child.uid, h, actor, seen);
    }
  }
  c.api.deleteRow(table, uid);
  clearFieldLeaves(c.db, table, uid);
  c.api.setMergedRowMeta(table, uid, {
    fieldHlc: {},
    tombstone: h,
    origin: c.st.replicaId,
    actor,
    chash: c.api.rowMeta(table, uid)?.chash ?? null,
  });
}

/**
 * Decide and apply one op against the store as it is now, inside its own
 * savepoint: a guard refusal rolls back only this op and records it.
 */
function applyOne(
  c: OpContext,
  opIdx: number,
  op: LedgerOp,
): { readonly result: OpResult; readonly conflicts: number } {
  if (op.o === 'K') {
    // A re-key gets the same savepoint and guard path as any op (T13239).
    const sp = `apply_op_${opIdx}`;
    c.db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = applyRekey(c, opIdx, op);
      c.db.exec(`RELEASE ${sp}`);
      return r;
    } catch (err) {
      c.db.exec(`ROLLBACK TO ${sp}`);
      c.db.exec(`RELEASE ${sp}`);
      if (!isGuardRefusal(err)) throw err;
      return voidWith(c, opIdx, {
        kind: 'guard',
        table: op.t,
        uid: op.u,
        columns: [UID_COLUMN],
        rule: err.message.slice(0, 200),
        resolution: 'op-voided',
        opHlc: op.h,
      });
    }
  }
  const def = c.defs(op.t);
  // @sync-invariant none:input-shape planning refused-schema'd every op on an unknown table
  if (!def) throw new Error(`apply: ${op.t} is not a sync-set table`);
  const refKeys = new Map<string, LedgerWireValue>();
  for (const [col, v] of Object.entries(op.a ?? {})) {
    const target = def.refs.get(col);
    if (!target || typeof v !== 'string') continue;
    const ref = resolveRef(c.db, target, v);
    if (ref.kind === 'row') {
      refKeys.set(col, ref.key);
      continue;
    }
    // Planning saw it; a tombstoned target is a revivable dangling reference.
    return voidWith(c, opIdx, {
      kind: 'dangling-ref',
      table: op.t,
      uid: op.u,
      columns: [col],
      resolution: 'op-voided',
      opHlc: op.h,
    });
  }
  const before = loadRowState(c.db, c.api, def, op.u, c.replica);
  const out = applyOp(before, ownEcho(op, c.st, c.replica), {
    table: mergeSpecFor(op.t, def.columns),
    actorOp: c.st.txn.actor?.op ?? null,
  });
  const live =
    out.effect === 'delete'
      ? c.api.childRows(op.t, op.u).filter((x) => x.key.onDelete === 'CASCADE')
      : [];
  if (live.length > 0) {
    if (parentDeletePolicy(op.t) === 'conflict') {
      return voidWith(c, opIdx, {
        kind: 'delete-with-live-children',
        table: op.t,
        uid: op.u,
        columns: live.map((x) => `${x.key.child}:${x.uid}`).sort(),
        resolution: 'op-voided',
        opHlc: op.h,
      });
    }
  }
  const sp = `apply_op_${opIdx}`;
  c.db.exec(`SAVEPOINT ${sp}`);
  try {
    // cascade-with-ops: the remaining children go first, with ops' tombstones.
    const actor = c.st.txn.actor ? JSON.stringify(c.st.txn.actor) : null;
    for (const x of live) cascadeDelete(c, x.key.child, x.uid, op.h, actor);
    const n = effect(c.db, c.api, c.st, opIdx, { op, def, before, out, refKeys }, c.nowIso);
    c.db.exec(`RELEASE ${sp}`);
    const result: OpResult =
      out.status === 'applied' || out.status === 'partial'
        ? 'applied'
        : out.status === 'void'
          ? 'void'
          : 'skipped';
    return { result, conflicts: n };
  } catch (err) {
    c.db.exec(`ROLLBACK TO ${sp}`);
    c.db.exec(`RELEASE ${sp}`);
    if (!isGuardRefusal(err)) throw err;
    return voidWith(c, opIdx, {
      kind: 'guard',
      table: op.t,
      uid: op.u,
      columns: [...out.written],
      rule: err.message.slice(0, 200),
      resolution: 'op-voided',
      opHlc: op.h,
    });
  }
}

/**
 * Apply a stream's staged transactions (see the module doc).
 *
 * @param db - The store (the journal schema applied, capture on); must not
 *   be inside a transaction.
 * @param opts - Scope, stream, this replica, clock, sealing and pass bound.
 * @returns What the inbox holds for the transactions tried, per status.
 *
 * @example
 * ```ts
 * stageTxns(db, stream, segment, new Date().toISOString());
 * const r = applyStagedTxns(db, { scope: 'project', stream, replica });
 * if (r.pending > 0) reportHolds();
 * ```
 */
export function applyStagedTxns(db: DatabaseSync, opts: ApplyStagedOptions): ApplyReport {
  const now = opts.now ?? Date.now;
  const maxPasses = opts.maxPasses ?? 16;
  // PAC-15: a store that refuses writes applies nothing; the inbox waits.
  const blocked = checkApplyPreconditions(db);
  if (blocked !== null) {
    return {
      applied: 0,
      conflict: 0,
      void: 0,
      pending: 0,
      heldSkew: 0,
      refusedSchema: 0,
      conflicts: 0,
      passes: 0,
      blocked,
    };
  }
  opts.seal?.();
  const defCache = new Map<string, CaptureTableDef | null>();
  const defs = (table: string): CaptureTableDef | null => {
    if (!defCache.has(table)) defCache.set(table, captureTableDef(db, opts.scope, table) ?? null);
    return defCache.get(table) ?? null;
  };
  const last = new Map<string, InboxStatus>();
  let conflicts = 0;
  let passes = 0;
  for (let progress = true; progress && passes < maxPasses; ) {
    progress = false;
    passes += 1;
    const heldReplicas = new Set<string>();
    const held = new Set<string>(); // rows written by a pending transaction
    for (const st of stagedTxns(db, opts.stream)) {
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      const id = keyText(st.key);
      const mark = (status: InboxStatus, reason: string | null): void => {
        markTxns(db, st.parts, status, { reason, nowIso });
        last.set(id, status);
      };
      const refusal = checkSchemaVersion(st.schemaVersion, st.txn.v);
      if (refusal) {
        mark('refused-schema', `${refusal.code}: ${refusal.message}`);
        continue;
      }
      if (heldReplicas.has(st.replicaId)) {
        mark('held-skew', `behind a held transaction of replica ${st.replicaId}`);
        continue;
      }
      if (!isWithinSkew(parseHlc(st.txn.hlc), nowMs)) {
        heldReplicas.add(st.replicaId);
        mark('held-skew', `HLC ${st.txn.hlc} is beyond the skew bound`);
        continue;
      }
      const waits = st.txn.ops.find((o) => held.has(rowKey(o.t, o.u)));
      if (waits) {
        for (const o of st.txn.ops) held.add(rowKey(o.t, o.u));
        mark('pending', `waits on a pending transaction writing ${waits.t}/${waits.u}`);
        continue;
      }
      const actor = st.txn.actor ? JSON.stringify(st.txn.actor) : null;
      const result = withApplyFrame(db, opts.scope, actor, (api) => {
        const plan = planTxn(db, api, st, defs, opts.replica);
        if (plan.kind !== 'apply') {
          markTxns(db, st.parts, plan.kind, { reason: plan.reason, nowIso });
          return { status: plan.kind, holds: plan.kind === 'pending' ? plan.holds : [], n: 0 };
        }
        if (api.clockReceive(opts.replica, st.txn.hlc, nowMs).held) {
          markTxns(db, st.parts, 'held-skew', { reason: 'clock refused the HLC', nowIso });
          return { status: 'held-skew' as const, holds: [], n: 0 };
        }
        const c: OpContext = { db, api, st, defs, replica: opts.replica, nowIso };
        let n = 0;
        // Gate C (§3.6): the whole transaction is one savepoint, so a broken
        // multi-row invariant rolls all of it back.
        db.exec('SAVEPOINT apply_txn');
        const results = applyOrder(st.txn.ops, defs).map((i) => {
          const r = applyOne(c, i, st.txn.ops[i] as LedgerOp);
          n += r.conflicts;
          return r.result;
        });
        // Every per-transaction post-apply check, by name (the registry's runtime gates).
        const violations = [...checkTaskTreeShape(db, treeShapePage(st.txn.ops))];
        if (violations.length > 0) {
          db.exec('ROLLBACK TO apply_txn');
          db.exec('RELEASE apply_txn');
          recordConflicts(
            db,
            { ...st.key, opIdx: -1 },
            violations.map((v) => ({
              kind: 'post-apply' as const,
              table: v.table,
              uid: v.uid,
              columns: [],
              rule: `${v.check}: ${v.message}`.slice(0, 200),
              resolution: 'op-voided' as const,
              opHlc: st.txn.hlc,
            })),
            st.replicaId,
            nowIso,
          );
          markTxns(db, st.parts, 'void', {
            frame: api.frame,
            reason: `post-apply: ${violations.map((v) => v.check).join(', ')}`,
            nowIso,
          });
          return { status: 'void' as const, holds: [], n: violations.length };
        }
        db.exec('RELEASE apply_txn');
        const status = txnStatus(results, n);
        markTxns(db, st.parts, status, {
          frame: api.frame,
          reason: n > 0 ? `${n} conflict(s) recorded` : null,
          nowIso,
        });
        return { status, holds: [], n };
      });
      last.set(id, result.status);
      conflicts += result.n;
      if (result.status === 'held-skew') heldReplicas.add(st.replicaId);
      if (result.status === 'pending') for (const k of result.holds) held.add(k);
      if (result.status === 'applied' || result.status === 'conflict' || result.status === 'void') {
        progress = true;
      }
    }
  }
  const count = (s: InboxStatus): number => [...last.values()].filter((v) => v === s).length;
  return {
    applied: count('applied'),
    conflict: count('conflict'),
    void: count('void'),
    pending: count('pending'),
    heldSkew: count('held-skew'),
    refusedSchema: count('refused-schema'),
    conflicts,
    passes,
  };
}
