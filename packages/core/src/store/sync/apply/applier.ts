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
 * 4. **Decide.** Each op's row state is read from the store (the row, its
 *    row meta and its leaves), carried forward op by op inside the
 *    transaction, and passed to the merge engine ({@link applyOp}). An op the
 *    engine cannot apply yet (an update of a never-seen row) makes the whole
 *    transaction `pending`, with nothing written; so does an op this slice
 *    does not apply yet: a re-key (K), a non-NULL reference, or a secret.
 *    An op naming an unknown table or column makes it `refused-schema`.
 * 5. **Apply.** The effects go through the write API, which records the
 *    apply intents, so the sealer echoes nothing; row meta is set to the
 *    engine's state, conflicts are recorded, and the transaction is marked
 *    `applied`, `conflict` (something recorded) or `void` (every op refused).
 *
 * Passes repeat while a pass applies something, so a transaction pending on
 * a row a later transaction inserts applies in the same call.
 *
 * Deletes run with foreign keys ON: the origin journals cascaded child Ds
 * before the parent's D, so a child D whose row is already gone applies as a
 * tombstone, never a missing-row failure; and SET NULL actions are not
 * journaled yet (T13226), so this replica's own FK actions fill that gap.
 *
 * Out of this slice: references and re-keys (PR-4: pending, dangling-ref,
 * aliases, `remapPending`), guard-trigger refusals as conflicts and
 * children-first deletes with `onRemoteParentDelete` (PR-4), Gate C
 * validators (PR-5), the scoped rebase (§3.5).
 *
 * @module store/sync/apply/applier
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { LedgerOp, LedgerWireValue } from '@cleocode/contracts/ledger';
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
  type OpOutcome,
  type RowState,
  type TableMergeSpec,
  UNSEEN_ROW,
} from '../merge/types.js';
import { fieldHlcsOf } from '../row-meta.js';
import { canonicalJson } from '../sealer-values.js';
import { type ApplyApi, withApplyFrame } from './frame.js';

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
}

/** An op's decision inside its transaction. */
interface Decided {
  readonly op: LedgerOp;
  readonly def: CaptureTableDef;
  readonly before: RowState;
  readonly out: OpOutcome;
}

/** The decision for a whole transaction. */
type TxnPlan =
  | { readonly kind: 'apply'; readonly ops: readonly Decided[] }
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
  for (const [col, value] of Object.entries(row)) {
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

/** Why this slice cannot apply `op` yet, or null. */
function notYet(op: LedgerOp, def: CaptureTableDef): string | null {
  if (op.o === 'K') return `${op.t}/${op.u}: re-key (applied by the re-key path)`;
  for (const [col, v] of Object.entries(op.a ?? {})) {
    if (v === null) continue;
    if (def.refs.has(col)) return `${op.t}/${op.u}: reference ${col} (resolved by the ref path)`;
    if (def.secret.has(col)) return `${op.t}/${op.u}: secret ${col} (needs unsealing)`;
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
  const decided: Decided[] = [];
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
    const before = states.get(k) ?? loadRowState(db, api, def, op.u, localReplica);
    let spec = specs.get(op.t);
    if (!spec) {
      spec = mergeSpecFor(op.t, def.columns);
      specs.set(op.t, spec);
    }
    const out = applyOp(before, op, { table: spec, actorOp: st.txn.actor?.op ?? null });
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
    decided.push({ op, def, before, out });
  }
  return { kind: 'apply', ops: decided };
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
    case 'insert':
      api.insertRow(op.t, op.u, valuesOf(out.next, out.written));
      api.setMergedRowMeta(op.t, op.u, {
        ...meta,
        fieldHlc: liveHlcs(),
        tombstone: null,
        bfp: op.bfp ?? null,
      });
      break;
    case 'update':
      api.writeFields(op.t, op.u, valuesOf(out.next, out.written));
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

/** The status of an applied transaction from its decisions. */
function txnStatus(ops: readonly Decided[], conflicts: number): InboxStatus {
  const voided = ops.filter((d) => d.out.status === 'void').length;
  const effective = ops.filter((d) => d.out.status === 'applied' || d.out.status === 'partial');
  if (voided > 0 && effective.length === 0) return 'void';
  return conflicts > 0 ? 'conflict' : 'applied';
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
        let n = 0;
        plan.ops.forEach((d, i) => {
          n += effect(db, api, st, i, d, nowIso);
        });
        const status = txnStatus(plan.ops, n);
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
