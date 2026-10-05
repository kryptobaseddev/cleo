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
import type { LedgerActor, LedgerOp, LedgerWireValue } from '@cleocode/contracts/ledger';
import { BIRTH_FP_COLUMN, UID_COLUMN } from '../../row-identity-registry.js';
import { type CaptureTableDef, captureTableDef } from '../capture.js';
import { recordConflicts } from '../conflicts.js';
import {
  clearFieldLeaves,
  type FieldFrontier,
  readFieldFrontiers,
  readFieldLeaves,
  recordFieldLeaves,
  restoreFieldState,
  setFieldFrontiers,
} from '../field-leave.js';
import { accountRebaseRows, heldOp, holdOp, type KeptRow, txnHasHold, unholdOp } from '../held.js';
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
import { fieldHlcsOf, type RowMetaFull, readRowMetaFull, restoreRowMeta } from '../row-meta.js';
import { hasTable } from '../schema.js';
import { canonicalJson } from '../sealer-values.js';
import {
  capturePosition,
  type LocalTxn,
  markSequenced,
  ownEchoFastPath,
  readRowUndo,
  recordForeignTouches,
  resnapshotRowUndo,
  type TouchedRow,
  type UnsequencedTxn,
  unsequencedLocalTxn,
  unsequencedLocalTxns,
} from '../sequencing.js';
import { withTriggersSuspended } from '../trigger-classes.js';
import { widenFootprint } from './footprints.js';
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
  /** Ops per page; defaults to {@link REBASE_PAGE_OPS}. */
  readonly pageOps?: number;
  /** A page stops taking transactions after this many ms; defaults to {@link REBASE_PAGE_MS}. */
  readonly pageMs?: number;
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
  /** Transactions applied inside a scoped rebase frame (§3.5 Rule 2). */
  readonly rebased: number;
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
  quiet = false,
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
  if (!quiet) recordConflicts(db, { ...st.key, opIdx }, out.conflicts, st.replicaId, nowIso);
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
  /**
   * Set while a rebase replays a local op (§3.5): the op is this replica's,
   * with its own actor; counter deltas are applied (the rewind took them
   * out); conflicts are not recorded here, since its echo records them.
   */
  readonly replay?: {
    readonly actor: LedgerActor | null;
    /** Told why an op the replay refuses stays rewound (its hold reason, Rule 5). */
    readonly onVoid?: (conflicts: readonly MergeConflict[]) => void;
  };
}

const voidWith = (
  c: OpContext,
  opIdx: number,
  conflict: MergeConflict,
): { readonly result: OpResult; readonly conflicts: number } => {
  if (!c.replay) {
    recordConflicts(c.db, { ...c.st.key, opIdx }, [conflict], c.st.replicaId, c.nowIso);
  } else {
    c.replay.onVoid?.([conflict]);
  }
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
  const out = applyOp(before, c.replay ? op : ownEcho(op, c.st, c.replica), {
    table: mergeSpecFor(op.t, def.columns),
    actorOp: (c.replay ? c.replay.actor?.op : c.st.txn.actor?.op) ?? null,
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
    const st: StagedTxn = c.replay
      ? { ...c.st, replicaId: c.replica, txn: { ...c.st.txn, actor: c.replay.actor } }
      : c.st;
    const n = effect(
      c.db,
      c.api,
      st,
      opIdx,
      { op, def, before, out, refKeys },
      c.nowIso,
      c.replay !== undefined,
    );
    c.db.exec(`RELEASE ${sp}`);
    const result: OpResult =
      out.status === 'applied' || out.status === 'partial'
        ? 'applied'
        : out.status === 'void'
          ? 'void'
          : 'skipped';
    if (c.replay && result === 'void') c.replay.onVoid?.(out.conflicts);
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

/** What a scoped rebase does around one incoming transaction (§3.5 Rule 3). */
interface RebasePlan {
  /** Local transactions to rewind, in local commit order. */
  readonly rewind: readonly UnsequencedTxn[];
  /** Of those, the ones to replay after the incoming transaction applies. */
  readonly replay: readonly UnsequencedTxn[];
  /** The local transaction the incoming one echoes, when it is ours. */
  readonly own: UnsequencedTxn | null;
}

/** The rows a transaction's ops write (a re-key's both uids). */
function touchedRows(ops: readonly LedgerOp[]): TouchedRow[] {
  return ops.flatMap((o) =>
    o.o === 'K' && o.nu && o.nu !== o.u
      ? [
          { table: o.t, uid: o.u },
          { table: o.t, uid: o.nu },
        ]
      : [{ table: o.t, uid: o.u }],
  );
}

/**
 * Give the unfilled natural-key rows `ops` name their uid (T13273): the
 * op's key (`k`, references as uids) resolved to local keys. A key whose
 * reference does not resolve is left for planning to judge.
 */
function adoptNaturalRows(
  db: DatabaseSync,
  api: ApplyApi,
  defs: (table: string) => CaptureTableDef | null,
  ops: readonly LedgerOp[],
): void {
  for (const op of ops) {
    const def = defs(op.t);
    if (!def || !op.k) continue;
    const local: Record<string, LedgerWireValue> = {};
    let resolved = true;
    for (const [col, v] of Object.entries(op.k)) {
      if (typeof v === 'object' && v !== null && '$inc' in v) {
        resolved = false;
        break;
      }
      const target = def.refs.get(col);
      if (target && typeof v === 'string') {
        const ref = resolveRef(db, target, v);
        if (ref.kind !== 'row') {
          resolved = false;
          break;
        }
        local[col] = ref.key;
      } else {
        local[col] = v;
      }
    }
    if (resolved) api.adoptNaturalRow(op.t, op.u, local);
  }
}

/** Whether `op` writes an append-only table (insert-only rows, never rewound). */
function isAppendOnly(defs: (table: string) => CaptureTableDef | null, op: LedgerOp): boolean {
  return defs(op.t)?.appendOnly === true;
}

/**
 * The rows ops write or reference, widened by what their guards and checks
 * read (their footprint, Rule 3; R7-6), by row key.
 */
function footprintOf(
  db: DatabaseSync,
  ops: readonly LedgerOp[],
  defs: (table: string) => CaptureTableDef | null,
): Map<string, TouchedRow> {
  const out = new Map<string, TouchedRow>();
  const add = (table: string, uid: string): void => {
    out.set(rowKey(table, uid), { table, uid });
  };
  widenFootprint(db, ops, defs, add);
  for (const o of ops) {
    add(o.t, o.u);
    if (o.o === 'K' && o.nu) add(o.t, o.nu);
    const def = defs(o.t);
    for (const [col, v] of Object.entries(o.a ?? {})) {
      const target = def?.refs.get(col);
      if (target && typeof v === 'string') add(target.table, v);
    }
  }
  return out;
}

/**
 * Whether an own echo may apply in place and be sequenced (the fast path,
 * Rule 3): no foreign touch of its footprint since its commit, and no later
 * unsequenced local transaction on that footprint (the echo would otherwise
 * apply over that transaction's effects). Otherwise a rebase decides.
 */
function echoInPlace(
  db: DatabaseSync,
  st: StagedTxn,
  defs: (table: string) => CaptureTableDef | null,
  local: LocalTxn,
  unsequenced: readonly UnsequencedTxn[],
): boolean {
  // A held op sits rewound: only a rebase can apply it and restore what it kept.
  if (txnHasHold(db, local.txn)) return false;
  const fp = footprintOf(db, st.txn.ops, defs);
  if (!ownEchoFastPath(db, local, [...fp.values()])) return false;
  const later = unsequenced.slice(unsequenced.findIndex((l) => l.txn === local.txn) + 1);
  return later.every((l) => ![...footprintOf(db, l.ops, defs).keys()].some((k) => fp.has(k)));
}

/**
 * Grow `scope` over `locals` to a fixed point (Rule 3): a local transaction
 * whose footprint meets `reach` joins, and its footprint joins `reach`. The
 * rewind set, in local commit order, or null when it is empty or a member
 * has an op without row undo (it cannot be rewound: apply in place, as
 * before undo existed).
 */
function scopeRewind(
  db: DatabaseSync,
  locals: readonly UnsequencedTxn[],
  defs: (table: string) => CaptureTableDef | null,
  reach: Set<string>,
  scope: Set<string>,
): UnsequencedTxn[] | null {
  for (let grown = true; grown; ) {
    grown = false;
    for (const l of locals) {
      if (scope.has(l.txn)) continue;
      const fp = [...footprintOf(db, l.ops, defs).keys()];
      if (fp.some((k) => reach.has(k))) {
        scope.add(l.txn);
        for (const k of fp) reach.add(k);
        grown = true;
      }
    }
  }
  const rewind = locals.filter((l) => scope.has(l.txn));
  if (rewind.length === 0) return null;
  for (const l of rewind) {
    for (let i = 0; i < l.ops.length; i++) if (!readRowUndo(db, l.txn, i)) return null;
  }
  return rewind;
}

/**
 * Plan the scoped rebase around one own echo the post-apply checks refused
 * while it sat in place (Rule 6): its transaction and the local ones its
 * footprint reaches, leaving out those the page already rewound.
 */
function planOwnRebase(
  db: DatabaseSync,
  st: StagedTxn,
  defs: (table: string) => CaptureTableDef | null,
  exclude: ReadonlySet<string>,
): RebasePlan | null {
  const locals = unsequencedLocalTxns(db).filter((l) => !exclude.has(l.txn));
  const own = locals.find((l) => l.txn === st.txn.txn) ?? null;
  if (!own) return null;
  const reach = new Set(footprintOf(db, st.txn.ops, defs).keys());
  for (const k of footprintOf(db, own.ops, defs).keys()) reach.add(k);
  const rewind = scopeRewind(db, locals, defs, reach, new Set([own.txn]));
  return rewind ? { rewind, replay: rewind.filter((l) => l !== own), own } : null;
}

/**
 * Plan a page's scoped rebase (Rule 3): the unsequenced local transactions
 * whose footprint meets a foreign transaction of the page, or an own echo
 * of the page that fails the fast path, to a fixed point. Null when none.
 */
function planPageRebase(
  db: DatabaseSync,
  page: readonly StagedTxn[],
  defs: (table: string) => CaptureTableDef | null,
  localReplica: string,
): { readonly plan: RebasePlan | null; readonly inPlace: ReadonlySet<string> } {
  const inPlace = new Set<string>();
  const locals = unsequencedLocalTxns(db);
  if (locals.length === 0) return { plan: null, inPlace };
  const reach = new Set<string>();
  const scope = new Set<string>();
  for (const st of page) {
    if (st.replicaId !== localReplica) {
      for (const k of footprintOf(db, st.txn.ops, defs).keys()) reach.add(k);
      continue;
    }
    const own = locals.find((l) => l.txn === st.txn.txn);
    if (!own) continue;
    // Judged once per page: a page write meeting it puts it in scope instead.
    if (echoInPlace(db, st, defs, own, locals)) {
      inPlace.add(own.txn);
      continue;
    }
    scope.add(own.txn);
    for (const k of footprintOf(db, st.txn.ops, defs).keys()) reach.add(k);
    for (const k of footprintOf(db, own.ops, defs).keys()) reach.add(k);
  }
  const rewind = scopeRewind(db, locals, defs, reach, scope);
  for (const l of rewind ?? []) inPlace.delete(l.txn);
  return { plan: rewind ? { rewind, replay: rewind, own: null } : null, inPlace };
}

/** Wire values with references turned into local keys (unresolvable ones drop to NULL). */
function toLocal(
  db: DatabaseSync,
  def: CaptureTableDef,
  values: Readonly<Record<string, LedgerWireValue>>,
): Record<string, LedgerWireValue> {
  const out: Record<string, LedgerWireValue> = {};
  for (const [col, v] of Object.entries(values)) {
    if (col === UID_COLUMN) continue;
    const target = def.refs.get(col);
    if (target && typeof v === 'string') {
      const ref = resolveRef(db, target, v);
      out[col] = ref.kind === 'row' ? ref.key : null;
    } else {
      out[col] = v;
    }
  }
  return out;
}

/** Put back what a rewound insert kept, once its insert applied again. */
function restoreKept(
  c: OpContext,
  op: LedgerOp,
  result: OpResult,
  kept: ReadonlyMap<string, KeptRow>,
): void {
  if (op.o !== 'I' || result !== 'applied') return;
  const k = kept.get(rowKey(op.t, op.u));
  if (!k) return;
  if (k.local) c.api.writeLocalOnly(op.t, op.u, k.local);
  c.api.writeLocalDescendants(k.descendants);
}

/** Re-snapshot op `i`'s row undo with the row as it stands now (D2). */
function resnapshotOp(c: OpContext, l: UnsequencedTxn, i: number, op: LedgerOp): void {
  const def = c.defs(op.t);
  if (!def) return;
  const state = loadRowState(c.db, c.api, def, op.u, c.replica);
  const now: Record<string, LedgerWireValue> = {};
  const cols = op.o === 'U' ? Object.keys(op.a ?? {}) : Object.keys(state.fields);
  for (const col of cols) {
    const f = state.fields[col];
    if (f) now[col] = f.value;
  }
  resnapshotRowUndo(c.db, l.txn, i, op.t, op.u, now);
}

/**
 * Rewind the plan's local transactions, newest op first (Rules 2, 4): each
 * row's values go back to what they were before the op (its last replay's
 * snapshot, else the sealed op's own before-image), and its row meta, leaves
 * and frontiers back to the op's row undo. Capture, guard and side-effect
 * triggers are suspended; local-only columns of rewound inserts are kept for
 * the replay (R7-2).
 */
/** What a rewind leaves its replay: kept inserts and each op's after-meta. */
interface Rewound {
  /** What rewound inserts kept, by row key. */
  readonly kept: Map<string, KeptRow>;
  /** Each rewound op's row meta as the op left it, by {@link opKey}. */
  readonly after: Map<string, RowMetaFull | null>;
}

const opKey = (txn: string, idx: number): string => `${txn}\u0000${idx}`;

/** A one-line conflict preview of why a replay refused an op (Rule 5). */
function describeConflicts(cs: readonly MergeConflict[]): string {
  return cs
    .map(
      (x) =>
        `${x.kind}${x.rule ? ` (${x.rule})` : ''} on ${x.table}/${x.uid}${x.columns.length > 0 ? ` [${x.columns.join(', ')}]` : ''}`,
    )
    .join('; ');
}

function rewindTxns(c: OpContext, plan: RebasePlan): Rewound {
  const kept = new Map<string, KeptRow>();
  const after = new Map<string, RowMetaFull | null>();
  withTriggersSuspended(c.db, ['capture', 'guard', 'side-effect'], 'rewind', () => {
    for (const l of [...plan.rewind].reverse()) {
      adoptNaturalRows(c.db, c.api, c.defs, l.ops);
      for (let i = l.ops.length - 1; i >= 0; i--) {
        const op = l.ops[i] as LedgerOp;
        const def = c.defs(op.t);
        const undo = readRowUndo(c.db, l.txn, i);
        if (!def || !undo || def.appendOnly) continue;
        const exists = (uid: string): boolean => c.api.readRow(op.t, uid) !== null;
        // A held op is decided again: lift its hold, keep what it kept.
        const held = heldOp(c.db, l.txn, i);
        if (held) {
          unholdOp(c.db, l.txn, i);
          if (held.kept) kept.set(rowKey(op.t, op.u), held.kept);
        }
        const had = exists(op.u);
        const before = undo.values ?? op.b ?? {};
        // A replay that found its row already gone snapshotted it as absent.
        const absent = undo.values !== null && Object.keys(undo.values).length === 0;
        if (op.o === 'I' && exists(op.u) && undo.values && Object.keys(undo.values).length > 0) {
          // Its last replay sat on a row the stream had inserted too (a natural
          // twin): rewinding restores that row, never deletes it (D2).
          const local = toLocal(c.db, def, undo.values);
          if (Object.keys(local).length > 0) c.api.writeFields(op.t, op.u, local);
        } else if (op.o === 'I' && exists(op.u)) {
          kept.set(rowKey(op.t, op.u), {
            local: c.api.readLocalOnly(op.t, op.u),
            descendants: c.api.readLocalDescendants(op.t, op.u),
          });
          c.api.deleteRow(op.t, op.u);
        } else if (op.o === 'U' && exists(op.u)) {
          const cols = Object.keys(op.a ?? {});
          const vals: Record<string, LedgerWireValue> = {};
          for (const col of cols) if (col in before) vals[col] = before[col] as LedgerWireValue;
          const local = toLocal(c.db, def, vals);
          if (Object.keys(local).length > 0) c.api.writeFields(op.t, op.u, local);
        } else if (op.o === 'D' && !absent && !exists(op.u)) {
          const vals = toLocal(c.db, def, before);
          if (def.identity.includes(BIRTH_FP_COLUMN) && vals[BIRTH_FP_COLUMN] == null && op.bfp) {
            vals[BIRTH_FP_COLUMN] = op.bfp;
          }
          c.api.insertRow(op.t, op.u, vals);
        } else if (op.o === 'K' && op.nu && exists(op.nu)) {
          c.api.rekeyRow(op.t, op.nu, op.u, op.obfp ?? null);
        }
        if (op.o === 'I' || op.o === 'D') {
          accountRebaseRows(c.db, op.t, Number(exists(op.u)) - Number(had));
        }
        after.set(opKey(l.txn, i), readRowMetaFull(c.db, op.t, op.u) ?? null);
        restoreRowMeta(c.db, op.t, op.u, undo.meta);
        restoreFieldState(c.db, op.t, op.u, undo.state);
      }
    }
  });
  return { kept, after };
}

/**
 * Replay the plan's local transactions in commit order, after the incoming
 * one applied (Rule 4): each op goes through the merge engine against the
 * state now, so a field the stream wrote with a newer HLC is not overwritten
 * (R6-7), and an op the stream now refuses stays rewound (Rule 6). Before each
 * op its row undo is re-snapshotted, so the next rewind restores exactly what
 * this replay sat on (D2). Capture and side-effect triggers are suspended;
 * guards stay active, and each replayed transaction gets the post-apply
 * checks: one that fails them stays rewound whole (Rule 6, T13268).
 */
function replayTxns(c: OpContext, plan: RebasePlan, rw: Rewound): void {
  const exists = (op: LedgerOp): boolean => c.api.readRow(op.t, op.u) !== null;
  withTriggersSuspended(c.db, ['capture', 'side-effect'], 'forward', () => {
    for (const l of plan.replay) {
      let refused: string | null = null;
      const rc: OpContext = {
        ...c,
        replay: {
          actor: l.actor,
          onVoid: (cs) => {
            refused = describeConflicts(cs);
          },
        },
      };
      let holds: Array<{ readonly idx: number; readonly reason: string }> = [];
      c.db.exec('SAVEPOINT replay_txn');
      l.ops.forEach((op, i) => {
        if (isAppendOnly(c.defs, op)) return; // never rewound, so never replayed
        resnapshotOp(c, l, i, op);
        const had = exists(op);
        refused = null;
        const r = applyOne(rc, i, op);
        if (op.o === 'I' || op.o === 'D') {
          accountRebaseRows(c.db, op.t, Number(exists(op)) - Number(had));
        }
        restoreKept(c, op, r.result, rw.kept);
        if (r.result === 'void') holds.push({ idx: i, reason: refused ?? 'refused on replay' });
      });
      // Gate C over the replay too (T13268): a replayed transaction that
      // breaks a post-apply check stays rewound whole, as its echo will be
      // voided on every receiver. Every op of it now sits on the rewound row.
      const broken = checkTaskTreeShape(c.db, treeShapePage(l.ops));
      if (broken.length > 0) {
        c.db.exec('ROLLBACK TO replay_txn');
        l.ops.forEach((op, i) => {
          resnapshotOp(c, l, i, op);
        });
        const reason = broken.map((v) => `${v.check}: ${v.message}`).join('; ');
        holds = l.ops.map((_, i) => ({ idx: i, reason }));
      }
      c.db.exec('RELEASE replay_txn');
      // What stays rewound is held until its echo is decided (Rule 5).
      for (const h of holds) {
        const op = l.ops[h.idx] as LedgerOp;
        holdOp(c.db, {
          txn: l.txn,
          idx: h.idx,
          op,
          exists: exists(op),
          reason: h.reason,
          afterMeta: rw.after.get(opKey(l.txn, h.idx)) ?? null,
          kept: rw.kept.get(rowKey(op.t, op.u)) ?? null,
          nowIso: c.nowIso,
        });
      }
    }
  });
}

/** A page holds at most this many ops (§3.5 Rule 3), unless one transaction is larger. */
export const REBASE_PAGE_OPS = 2_000;
/** A page stops taking transactions after this long (§3.5 Rule 3). */
export const REBASE_PAGE_MS = 50;

/** A staged transaction of a page, with the actor its apply frame records. */
interface PageTxn {
  readonly st: StagedTxn;
  readonly actor: string | null;
}

/**
 * The next page from `staged[from]`: consecutive transactions with the same
 * actor (one apply frame records one), up to `maxOps` ops. A
 * page breaks only between transactions, and a transaction larger than a
 * page is a page alone (the declared exemption).
 */
function takePage(staged: readonly StagedTxn[], from: number, maxOps: number): PageTxn[] {
  const out: PageTxn[] = [];
  let ops = 0;
  for (let i = from; i < staged.length; i++) {
    const st = staged[i] as StagedTxn;
    const actor = st.txn.actor ? JSON.stringify(st.txn.actor) : null;
    const first = out[0];
    if (first && (actor !== first.actor || ops + st.txn.ops.length > maxOps)) break;
    out.push({ st, actor });
    ops += st.txn.ops.length;
  }
  return out;
}

/** What {@link applyInPage} needs from its page. */
interface PageContext {
  readonly db: DatabaseSync;
  readonly api: ApplyApi;
  readonly defs: (table: string) => CaptureTableDef | null;
  readonly opts: ApplyStagedOptions;
  readonly sequencingOn: boolean;
  /** Local transactions the page rewound. */
  readonly rewound: ReadonlySet<string>;
  /** Local transactions whose echo in this page takes the fast path. */
  readonly inPlace: ReadonlySet<string>;
  readonly rw: Rewound;
  readonly nowMs: number;
  readonly nowIso: string;
  readonly held: ReadonlySet<string>;
  readonly heldReplicas: ReadonlySet<string>;
}

/** How one staged transaction of a page ended. */
interface InPageResult {
  readonly status: InboxStatus;
  /** Rows a pending transaction holds. */
  readonly holds: readonly string[];
  /** Conflicts recorded. */
  readonly n: number;
  /** Whether it went through apply (not refused or held before it). */
  readonly applied: boolean;
  /** The rewound local transaction its echo decided, when it was one. */
  readonly decided: string | null;
}

/**
 * Apply one staged transaction inside its page's frame: the pre-checks,
 * planning, the clock, its ops in one Gate C savepoint, the post-apply
 * checks, sequencing and the inbox mark. The page's rewind is already done
 * and its replay follows the page.
 */
function applyInPage(x: PageContext, st: StagedTxn): InPageResult {
  const { db, api, defs, opts, nowIso } = x;
  const stop = (status: InboxStatus, reason: string | null, holds: readonly string[] = []) => {
    markTxns(db, st.parts, status, { reason, nowIso });
    return { status, holds, n: 0, applied: false, decided: null };
  };
  const refusal = checkSchemaVersion(st.schemaVersion, st.txn.v);
  if (refusal) return stop('refused-schema', `${refusal.code}: ${refusal.message}`);
  if (x.heldReplicas.has(st.replicaId)) {
    return stop('held-skew', `behind a held transaction of replica ${st.replicaId}`);
  }
  if (!isWithinSkew(parseHlc(st.txn.hlc), x.nowMs)) {
    return stop('held-skew', `HLC ${st.txn.hlc} is beyond the skew bound`);
  }
  const waits = st.txn.ops.find((o) => x.held.has(rowKey(o.t, o.u)));
  if (waits) {
    return stop(
      'pending',
      `waits on a pending transaction writing ${waits.t}/${waits.u}`,
      st.txn.ops.map((o) => rowKey(o.t, o.u)),
    );
  }
  const plan = planTxn(db, api, st, defs, opts.replica);
  if (plan.kind !== 'apply') {
    return stop(plan.kind, plan.reason, plan.kind === 'pending' ? plan.holds : []);
  }
  if (api.clockReceive(opts.replica, st.txn.hlc, x.nowMs).held) {
    return stop('held-skew', 'clock refused the HLC');
  }
  // §3.5 Rule 3 (T13193): where this txn sits in the capture order.
  const touchPos = x.sequencingOn ? capturePosition(db) : 0;
  const local =
    x.sequencingOn && st.replicaId === opts.replica ? unsequencedLocalTxn(db, st.txn.txn) : null;
  // An own echo whose transaction the page rewound applies it at its stream position.
  const rewoundEcho = local !== null && x.rewound.has(local.txn);
  const c: OpContext = { db, api, st, defs, replica: opts.replica, nowIso };
  let n = 0;
  // Gate C (§3.6): the whole transaction is one savepoint, so a broken
  // multi-row invariant rolls all of it back (the page's rewind stays).
  db.exec('SAVEPOINT apply_txn');
  const results = applyOrder(st.txn.ops, defs).map((i) => {
    const op = st.txn.ops[i] as LedgerOp;
    const r = applyOne(c, i, op);
    n += r.conflicts;
    // A rewound own insert applies again here: put back what it kept.
    if (rewoundEcho && r.result === 'applied' && op.o === 'I') {
      withTriggersSuspended(db, ['capture', 'side-effect'], 'forward', () => {
        restoreKept(c, op, r.result, x.rw.kept);
      });
    }
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
    // A refused own echo stays rewound and keeps its undo (Rule 6). Rewound
    // by the page, the rollback left it so; in place, rewind it now.
    const own = local && !rewoundEcho ? planOwnRebase(db, st, defs, x.rewound) : null;
    if (own) replayTxns(c, own, rewindTxns(c, own));
    if (local && (rewoundEcho || own)) {
      markSequenced(db, local, { stream: st.key.stream, seq: st.key.seq, nowIso, outcome: 'void' });
    }
    markTxns(db, st.parts, 'void', {
      frame: api.frame,
      reason: `post-apply: ${violations.map((v) => v.check).join(', ')}`,
      nowIso,
    });
    return {
      status: 'void',
      holds: [],
      n: violations.length,
      applied: true,
      decided: rewoundEcho && local ? local.txn : null,
    };
  }
  db.exec('RELEASE apply_txn');
  const status = txnStatus(results, n);
  if (x.sequencingOn) {
    if (st.replicaId !== opts.replica) {
      // The rows it wrote: an echo widens its own footprint by what its
      // guards read, so a write to any of those rows meets it (R7-6).
      recordForeignTouches(db, touchedRows(st.txn.ops), touchPos);
    } else if (local && rewoundEcho) {
      // Rebased at its stream position: the stream decided it. A voided
      // echo stays rewound and keeps its undo (Rule 6).
      markSequenced(db, local, {
        stream: st.key.stream,
        seq: st.key.seq,
        nowIso,
        outcome: results.includes('void') ? 'void' : 'applied',
      });
    } else if (local && !results.includes('void') && x.inPlace.has(local.txn)) {
      // Own echo in place: the stream order agrees with ours.
      markSequenced(db, local, { stream: st.key.stream, seq: st.key.seq, nowIso });
    }
  }
  markTxns(db, st.parts, status, {
    frame: api.frame,
    reason: n > 0 ? `${n} conflict(s) recorded` : null,
    nowIso,
  });
  return { status, holds: [], n, applied: true, decided: rewoundEcho && local ? local.txn : null };
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
      rebased: 0,
      blocked,
    };
  }
  opts.seal?.();
  const sequencingOn = hasTable(db, '_sync_sequenced');
  const defCache = new Map<string, CaptureTableDef | null>();
  const defs = (table: string): CaptureTableDef | null => {
    if (!defCache.has(table)) defCache.set(table, captureTableDef(db, opts.scope, table) ?? null);
    return defCache.get(table) ?? null;
  };
  const last = new Map<string, InboxStatus>();
  let conflicts = 0;
  let passes = 0;
  let rebased = 0;
  for (let progress = true; progress && passes < maxPasses; ) {
    progress = false;
    passes += 1;
    const heldReplicas = new Set<string>();
    const held = new Set<string>(); // rows written by a pending transaction
    const staged = [...stagedTxns(db, opts.stream)];
    // Each page is one frame and one scoped rebase (§3.5 Rule 3): rewind the
    // page's scope once, apply its transactions in stream order, replay once.
    for (let at = 0; at < staged.length; ) {
      const page = takePage(staged, at, opts.pageOps ?? REBASE_PAGE_OPS);
      const pageStart = now();
      const done = withApplyFrame(db, opts.scope, page[0]?.actor ?? null, (api) => {
        const pageIso = new Date(pageStart).toISOString();
        for (const p of page) adoptNaturalRows(db, api, defs, p.st.txn.ops);
        const planned = sequencingOn
          ? planPageRebase(
              db,
              page.map((p) => p.st),
              defs,
              opts.replica,
            )
          : { plan: null, inPlace: new Set<string>() };
        const rebase = planned.plan;
        const c0: OpContext = {
          db,
          api,
          st: (page[0] as PageTxn).st,
          defs,
          replica: opts.replica,
          nowIso: pageIso,
        };
        const rw: Rewound = rebase ? rewindTxns(c0, rebase) : { kept: new Map(), after: new Map() };
        const rewound = new Set(rebase?.rewind.map((l) => l.txn) ?? []);
        const decided = new Set<string>(); // rewound locals whose echo this page applied
        let taken = 0;
        for (const { st } of page) {
          // The time bound cuts a page between transactions (never inside one).
          if (taken > 0 && now() - pageStart > (opts.pageMs ?? REBASE_PAGE_MS)) break;
          taken += 1;
          const nowMs = now();
          const nowIso = new Date(nowMs).toISOString();
          const id = keyText(st.key);
          const result = applyInPage(
            {
              db,
              api,
              defs,
              opts,
              sequencingOn,
              rewound,
              inPlace: planned.inPlace,
              rw,
              nowMs,
              nowIso,
              held,
              heldReplicas,
            },
            st,
          );
          if (result.decided) decided.add(result.decided);
          if (result.status !== null) last.set(id, result.status);
          conflicts += result.n;
          if (rebase && result.applied) rebased += 1;
          if (result.status === 'held-skew') heldReplicas.add(st.replicaId);
          if (result.status === 'pending') for (const k of result.holds) held.add(k);
          if (
            result.status === 'applied' ||
            result.status === 'conflict' ||
            result.status === 'void'
          ) {
            progress = true;
          }
        }
        // Replay what the page rewound and did not decide by its echo.
        if (rebase) {
          const replay = rebase.rewind.filter((l) => !decided.has(l.txn));
          replayTxns(c0, { rewind: rebase.rewind, replay, own: null }, rw);
        }
        return taken;
      });
      at += done;
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
    rebased,
  };
}
