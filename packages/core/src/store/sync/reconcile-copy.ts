/**
 * The copy reconcile (journal spec §1.5 N7, H3; T13335).
 *
 * Every rebind the open pass makes (a copy, a move, a rollback, another
 * device's store) discards the inherited pull cursor, pauses push and records
 * `sync.reconcile_due` (`replica.ts`). The new replica then reconciles its
 * own state against the stream's MERGED state: the latest verified
 * checkpoint restored into a scratch store (`sync: 'off'`) and pulled to head
 * there with the merge engine (`cloud/nexus-vault.ts` builds it). Here, in
 * one apply frame on the store:
 *
 * - **Rule 1** (`reconcile.ts`): a field an inherited capture or an
 *   inherited sealed-but-unpushed op changed is re-emitted from the live row
 *   at `tick(at_ms)` of that change.
 * - Every other field is compared per (table, uid, column) with the merged
 *   state; a differing field is decided by {@link decideReconcileField}:
 *   - **rule 2**, the local field HLC is below the merged one (or unknown):
 *     the merged value is written locally in the apply frame, its intents
 *     recorded so the sealer never sends it, and the merged field HLC stored
 *     in the row meta. Nothing is emitted;
 *   - **rule 3**, the local HLC is at or above the merged one (a value the
 *     original replica sealed but the stream never saw): it is emitted in
 *     the `rebind` frame with that HLC pinned (op `fh`, or `h` for a delete).
 * - The store takes the merged state's pull position, and the due record is
 *   cleared, which lets push resume.
 *
 * Rows: a row only the merged state has is adopted (inserted) unless the
 * store holds a newer tombstone for it (rule 3: a pinned delete); a row the
 * merged state deleted is adopted (deleted) unless the store's row is newer
 * (rule 3: its fields, pinned). A live row the merged state never knew, with
 * no inherited change, is emitted: with its row meta's HLCs pinned when it
 * has meta, else as a plain insert (nothing local is ever deleted that the
 * stream cannot account for).
 *
 * Reference columns are compared by the uid of the row they point at, and an
 * adopted reference is resolved to this store's local key ({@link resolveRef}).
 * A merged row whose reference does not resolve here, or whose insert hits a
 * local constraint, is left out and counted in `unresolved`.
 *
 * @task T13335
 * @module store/sync/reconcile-copy
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { LedgerWireValue } from '@cleocode/contracts/ledger';
import { UID_COLUMN } from '../row-identity-registry.js';
import { withApplyFrame } from './apply/frame.js';
import { resolveRef, uidOfKey } from './apply/refs.js';
import { type ApplyWriteApi, createApplyWriteApi } from './apply/write-api.js';
import { type CaptureTableDef, captureTableDef, hasCaptureStamp } from './capture.js';
import { readSyncFlags, syncSetTables } from './flags.js';
import { type StreamCursor, writeStreamCursor } from './pull.js';
import {
  decideReconcileField,
  emitRebindFrame,
  gatherInherited,
  type PinnedEmit,
  type ReconcileReport,
  type TouchedRow,
  touchedRowKey,
} from './reconcile.js';
import { RECONCILE_DUE_KEY, reconcileDue } from './replica.js';
import { fieldHlcsOf, type RowMetaFull, type RowMetaRow, readRowMetaFull } from './row-meta.js';
import { hasTable } from './schema.js';
import { canonicalJson } from './sealer-values.js';

/** Options for {@link reconcileCopy}. */
export interface ReconcileCopyOptions {
  readonly scope: TableScope;
  /** The stream the merged state was pulled to the head of. */
  readonly stream: string;
  /** The merged state's pull position at head: the store takes it. */
  readonly mergedCursor: StreamCursor;
  /** Wall clock (ms). @defaultValue Date.now */
  readonly now?: () => number;
}

/** What {@link reconcileCopy} did. */
export interface ReconcileCopyReport {
  /** Fields adopted from the merged state (rule 2), and rows inserted and deleted by adoption. */
  readonly adoptedFields: number;
  readonly adoptedInserts: number;
  readonly adoptedDeletes: number;
  /** Rule-3 emits with pinned HLCs. */
  readonly pinned: number;
  /** Merged rows left out: a reference that does not resolve here, or a local constraint. */
  readonly unresolved: number;
  /** The `rebind` frame (rule 1 and rule 3). */
  readonly frame: ReconcileReport;
}

const UNKNOWN_HLC = '';

/** The row-level HLC of a row meta: a tombstone's, or the newest field's. */
const rowHlc = (meta: RowMetaRow | undefined): string | null => meta?.hlc ?? null;

/**
 * Reconcile a rebound store against the merged state (module docs). Must
 * run outside a transaction. Does nothing, and returns null, when no
 * reconcile is due.
 *
 * @param db - The rebound store (the canonical store).
 * @param merged - The scratch store: the latest verified checkpoint pulled to head. Read-only here.
 * @param o - Scope, stream, the merged pull position and the clock.
 * @returns What was adopted and emitted, or null when nothing was due.
 */
export function reconcileCopy(
  db: DatabaseSync,
  merged: DatabaseSync,
  o: ReconcileCopyOptions,
): ReconcileCopyReport | null {
  if (reconcileDue(db) === null) return null;
  if (readSyncFlags(db)['sync.capture'] && !hasCaptureStamp(db)) {
    // @sync-invariant none:local-only programming-error guard: without the stamp the apply frame's writes would seal as local writes
    throw new Error(
      'reconcileCopy needs the canonical store handle (capture is on, this connection has no capture stamp)',
    );
  }
  const now = o.now ?? Date.now;
  const mergedApi = createApplyWriteApi(merged, o.scope, null, () => undefined);
  return withApplyFrame(db, o.scope, null, (api) => {
    // Raced by another reconcile while the frame waited for the lock.
    if (reconcileDue(db) === null) return null;
    const gathered = gatherInherited(db, o.scope, null);
    const touchedOf = (tbl: string, uid: string): TouchedRow | undefined =>
      gathered.rows.get(touchedRowKey(tbl, uid));
    const pinned: PinnedEmit[] = [];
    const atMs = now();
    let adoptedFields = 0;
    let adoptedInserts = 0;
    let adoptedDeletes = 0;
    let unresolved = 0;
    const tables = syncSetTables(o.scope)
      .map((t) => captureTableDef(db, o.scope, t))
      .filter(
        (d): d is CaptureTableDef =>
          d?.identity.includes(UID_COLUMN) === true && hasTable(merged, d.table),
      );
    const deletes: Array<{
      def: CaptureTableDef;
      uid: string;
      tombstone: string;
      meta: RowMetaFull;
    }> = [];

    for (const def of tables) {
      const fields = def.columns.filter((c) => !def.identity.includes(c) && !def.secret.has(c));
      const sameValue = (col: string, a: LedgerWireValue, b: LedgerWireValue): boolean => {
        const ref = def.refs.get(col);
        if (ref === undefined || a === null || b === null)
          return canonicalJson(a) === canonicalJson(b);
        return uidOfKey(db, ref, a) === uidOfKey(merged, ref, b);
      };
      /** A merged value as this store must hold it, or undefined when its reference does not resolve here. */
      const localValue = (col: string, v: LedgerWireValue): LedgerWireValue | undefined => {
        const ref = def.refs.get(col);
        if (ref === undefined || v === null) return v;
        const target = uidOfKey(merged, ref, v);
        if (target === null) return undefined;
        const here = resolveRef(db, ref, target);
        return here.kind === 'row' ? here.key : undefined;
      };

      for (const uid of uidsOf(db, merged, def.table)) {
        const touched = touchedOf(def.table, uid);
        // Rule 1 owns a row an inherited change inserted or deleted.
        if (touched?.inserted || touched?.deleted) continue;
        const local = api.readRow(def.table, uid);
        const theirs = mergedApi.readRow(def.table, uid);
        const lMeta = api.rowMeta(def.table, uid);
        const mMeta = readRowMetaFull(merged, def.table, uid);

        if (local !== null && theirs !== null) {
          const lH = lMeta && !lMeta.deleted ? fieldHlcsOf(def, lMeta) : {};
          const mH = mMeta && !mMeta.deleted ? fieldHlcsOf(def, mMeta) : {};
          const adopt: Record<string, LedgerWireValue> = {};
          const adoptH: Record<string, string> = {};
          const pinCols = new Set<string>();
          const pinH: Record<string, string> = {};
          for (const col of fields) {
            if (touched?.cols.has(col)) continue;
            const a = local[col] ?? null;
            const b = theirs[col] ?? null;
            if (sameValue(col, a, b)) continue;
            const mergedHlc = mH[col] ?? UNKNOWN_HLC;
            // One HLC names one write (it carries the replica): the values
            // differ only in how each store holds them (a timestamp's form).
            if (lH[col] !== undefined && lH[col] === mergedHlc) continue;
            const rule = decideReconcileField({
              touchedByInherited: false,
              localHlc: lH[col] ?? null,
              mergedHlc,
            });
            if (rule === 'adopt-merged') {
              const v = localValue(col, b);
              if (v === undefined) {
                unresolved += 1;
                continue;
              }
              adopt[col] = v;
              adoptH[col] = mergedHlc;
            } else {
              pinCols.add(col);
              pinH[col] = lH[col] as string;
            }
          }
          if (Object.keys(adopt).length > 0) {
            api.writeFields(def.table, uid, adopt);
            if (mMeta) {
              api.setMergedRowMeta(def.table, uid, {
                fieldHlc: lMeta && !lMeta.deleted ? adoptH : { ...lH, ...mH, ...adoptH },
                tombstone: null,
                origin: mMeta.origin,
                actor: mMeta.actor,
              });
            }
            adoptedFields += Object.keys(adopt).length;
          }
          if (pinCols.size > 0) {
            pinned.push({ tbl: def.table, uid, op: 'U', cols: pinCols, pin: { fh: pinH }, atMs });
          }
          continue;
        }

        if (local !== null) {
          // The merged state has no live row.
          if (mMeta?.deleted) {
            const localH = rowHlc(lMeta);
            if (localH === null || localH < mMeta.hlc) {
              deletes.push({ def, uid, tombstone: mMeta.hlc, meta: mMeta });
            } else {
              const lH = fieldHlcsOf(def, lMeta as RowMetaRow);
              pinned.push({
                tbl: def.table,
                uid,
                op: 'U',
                cols: new Set(fields),
                pin: { fh: Object.fromEntries(fields.map((c) => [c, lH[c] as string])) },
                atMs,
              });
            }
            continue;
          }
          // The stream never knew the row and no inherited change explains it.
          pinned.push({
            tbl: def.table,
            uid,
            op: 'I',
            pin: lMeta && !lMeta.deleted ? { fh: fieldHlcsOf(def, lMeta) } : {},
            atMs,
          });
          continue;
        }

        if (theirs !== null) {
          // Only the merged state has the row.
          if (lMeta?.deleted && mMeta && lMeta.hlc >= mMeta.hlc) {
            pinned.push({ tbl: def.table, uid, op: 'D', pin: { h: lMeta.hlc }, atMs });
            continue;
          }
          const values: Record<string, LedgerWireValue> = {};
          let resolvable = true;
          for (const col of def.columns) {
            if (col === UID_COLUMN || def.secret.has(col)) continue;
            const v = localValue(col, theirs[col] ?? null);
            if (v === undefined) {
              resolvable = false;
              break;
            }
            values[col] = v;
          }
          if (!resolvable || !insertAdopted(api, def, uid, values, mMeta)) {
            unresolved += 1;
            continue;
          }
          adoptedInserts += 1;
        }
      }
    }
    // Deletes after every insert and update, children first.
    for (const d of deletes.reverse()) {
      if (!api.deleteRow(d.def.table, d.uid)) continue;
      api.setMergedRowMeta(d.def.table, d.uid, {
        fieldHlc: {},
        tombstone: d.tombstone,
        origin: d.meta.origin,
        actor: d.meta.actor,
      });
      adoptedDeletes += 1;
    }

    const frame = emitRebindFrame(db, o.scope, gathered, pinned);
    writeStreamCursor(db, o.stream, o.mergedCursor, new Date(atMs).toISOString());
    db.prepare('DELETE FROM _sync_meta WHERE key = ?').run(RECONCILE_DUE_KEY);
    return {
      adoptedFields,
      adoptedInserts,
      adoptedDeletes,
      pinned: pinned.length,
      unresolved,
      frame,
    };
  });
}

/**
 * Every uid of `table` either store knows: its live rows and its row meta
 * (tombstones included), in a stable order.
 */
function uidsOf(db: DatabaseSync, merged: DatabaseSync, table: string): string[] {
  const out = new Set<string>();
  const q = `"${table.replaceAll('"', '""')}"`;
  for (const store of [db, merged]) {
    for (const r of store
      .prepare(`SELECT ${UID_COLUMN} AS uid FROM ${q} WHERE ${UID_COLUMN} IS NOT NULL`)
      .all() as Array<{ uid: string }>) {
      out.add(r.uid);
    }
    if (hasTable(store, '_sync_row_meta')) {
      for (const r of store
        .prepare('SELECT uid FROM _sync_row_meta WHERE tbl = ?')
        .all(table) as Array<{ uid: string }>) {
        out.add(r.uid);
      }
    }
  }
  return [...out].sort();
}

/**
 * Insert a merged row in the apply frame, with the merged row meta. A local
 * constraint (a key another local row holds) leaves it out: the statement
 * is undone and nothing is recorded.
 *
 * @returns Whether the row was inserted.
 */
function insertAdopted(
  api: ApplyWriteApi,
  def: CaptureTableDef,
  uid: string,
  values: Readonly<Record<string, LedgerWireValue>>,
  mMeta: RowMetaFull | undefined,
): boolean {
  try {
    api.insertRow(def.table, uid, values);
  } catch (err) {
    if (err instanceof Error && /constraint/i.test(err.message)) return false;
    throw err;
  }
  if (mMeta && !mMeta.deleted) {
    api.setMergedRowMeta(def.table, uid, {
      fieldHlc: fieldHlcsOf(def, mMeta),
      tombstone: null,
      origin: mMeta.origin,
      actor: mMeta.actor,
    });
  }
  return true;
}
