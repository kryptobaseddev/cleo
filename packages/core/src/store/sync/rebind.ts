/**
 * The rebind at the next pull to head (journal spec §3.5 Rule 2 D5, §1.5;
 * T13278).
 *
 * Undo grows exactly while a replica cannot reach the stream. At 100% of its
 * budget the store keeps writing undo and records `sync.undo_budget_exceeded`
 * (`sequencing.ts`); a forced rebind then would need the network it does not
 * have. So the rebind waits for the next pull that reaches the stream's head,
 * and {@link rebindAtHead} runs it, in one transaction with the rebind:
 *
 * 1. segments of the old replica the server already holds (at or below the
 *    pull cursor's replicaSeq for it) are marked pushed first, so they are
 *    never mistaken for an unsent outbox;
 * 2. the store rebinds to a new replica (`undo-budget`): the old outbox
 *    (live captures, sealed transactions, unpushed segments) is inherited;
 * 3. the undo log is emptied; every transaction of the old replica the
 *    stream has not sequenced is inherited first;
 * 4. the reconcile re-emits what the old replica changed and never sent,
 *    under the new replica (`reconcileInPlace`, the §1.5 three-way rule);
 * 5. a signed `retire` transaction for the old id is queued
 *    (`queueRetireTxn`), naming the successor and the last replicaSeq the
 *    server holds of the old replica; a replica that never landed a segment
 *    pins nothing and retires with no journal transaction;
 * 6. `sync.undo_budget_exceeded` is cleared. Only this clears it.
 *
 * The server half (attach the new replica to this device, sign the E31
 * retirement, update the link) needs the network, so the transaction also
 * records {@link REBIND_PENDING_KEY}: the cloud layer completes it before the
 * store pushes or pulls again, and a crash in between resumes there.
 *
 * @task T13278
 * @module store/sync/rebind
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { withImmediateTransaction } from './clock-store.js';
import type { StreamCursor } from './pull.js';
import { type ReconcileReport, reconcileInPlace } from './reconcile.js';
import { activeReplica, rebindReplicaWith, type SyncOpenOptions } from './replica.js';
import { queueRetireTxn } from './retire.js';
import { hasTable } from './schema.js';
import {
  FOREIGN_TOUCH_COUNT_KEY,
  FOREIGN_TOUCH_INCOMPLETE_KEY,
  UNDO_BUDGET_EXCEEDED_KEY,
} from './sequencing.js';

/**
 * `_sync_meta` key holding the server half of a rebind the store committed
 * and the cloud has not completed yet ({@link PendingRebind}).
 */
export const REBIND_PENDING_KEY = 'sync.rebind_pending';

/** The server half of a committed rebind: attach `to`, retire `from` (E31). */
export interface PendingRebind {
  readonly stream: string;
  readonly scope: TableScope;
  /** The retired replica. */
  readonly from: string;
  /** Its successor, this store's replica now. */
  readonly to: string;
  /** The last replicaSeq of `from` the server holds, or null when it holds none. */
  readonly lastReplicaSeq: number | null;
  /** The journal `retire` transaction, or null when `from` landed nothing. */
  readonly retireTxn: string | null;
  /** When the store rebound. */
  readonly at: string;
}

/** Options for {@link rebindAtHead}. */
export interface RebindAtHeadOptions extends SyncOpenOptions {
  /** The stream the pull reached the head of. */
  readonly stream: string;
  /** The pull cursor at head: the server's last replicaSeq per replica. */
  readonly cursor: StreamCursor;
}

/** What {@link rebindAtHead} did. */
export interface RebindAtHeadReport {
  readonly previousReplicaId: string;
  readonly replicaId: string;
  /** The server half the cloud must complete. */
  readonly pending: PendingRebind;
  /** Old segments the server held, marked pushed before the rebind. */
  readonly segmentsMarkedPushed: number;
  /** Undo rows dropped (`_sync_undo` plus `_sync_row_undo`). */
  readonly undoDropped: number;
  readonly reconcile: ReconcileReport;
}

const metaGet = (db: DatabaseSync, key: string): string | undefined =>
  hasTable(db, '_sync_meta')
    ? (
        db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(key) as
          | { value: string }
          | undefined
      )?.value
    : undefined;

/**
 * Whether the undo budget scheduled a rebind (D5): `sync.undo_budget_exceeded`
 * is set. Read-only.
 *
 * @param db - The store.
 * @returns True when the next pull to head must rebind.
 */
export function undoBudgetRebindDue(db: DatabaseSync): boolean {
  return metaGet(db, UNDO_BUDGET_EXCEEDED_KEY) !== undefined;
}

/**
 * The server half of a rebind still to complete, or null. Read-only.
 *
 * @param db - The store.
 * @returns The pending rebind, or null.
 */
export function pendingRebind(db: DatabaseSync): PendingRebind | null {
  const raw = metaGet(db, REBIND_PENDING_KEY);
  return raw === undefined ? null : (JSON.parse(raw) as PendingRebind);
}

/**
 * Record that the server half of a rebind completed (the new replica is
 * attached and the old one retired on the server).
 *
 * @param db - The store, outside a transaction.
 * @param to - The replica the completed rebind bound; a newer pending rebind is kept.
 */
export function clearPendingRebind(db: DatabaseSync, to: string): void {
  withImmediateTransaction(db, () => {
    const now = pendingRebind(db);
    if (now !== null && now.to === to) {
      db.prepare('DELETE FROM _sync_meta WHERE key = ?').run(REBIND_PENDING_KEY);
    }
  });
}

/**
 * Run the scheduled rebind after a pull reached the stream's head (module
 * docs). Must run outside a transaction, and only after a pull that staged
 * and applied everything up to the server's head.
 *
 * @param db - The store.
 * @param o - The open options of the canonical store, the stream and the pull cursor.
 * @returns What was done, or null when no rebind is due.
 * @throws {Error} When the store has no active replica.
 */
export function rebindAtHead(db: DatabaseSync, o: RebindAtHeadOptions): RebindAtHeadReport | null {
  if (!undoBudgetRebindDue(db)) return null;
  const now = o.now?.() ?? new Date();
  const nowIso = now.toISOString();

  // 1. What the server holds of the old replica is pushed, whatever the
  //    local state says (an upload whose answer was lost): never inherited.
  //    Its own transaction, before the rebind's: true whatever follows.
  const marked = withImmediateTransaction(db, () => {
    const active = activeReplica(db, o.scope)?.replicaId;
    const held = active ? o.cursor.replicas[active]?.replicaSeq : undefined;
    if (!active || held === undefined || !hasTable(db, '_sync_segment')) return 0;
    return Number(
      db
        .prepare(
          `UPDATE _sync_segment SET state = 'pushed', pushed_at = coalesce(pushed_at, ?)
            WHERE stream = ? AND replica_id = ? AND replica_seq <= ? AND state = 'sealed'`,
        )
        .run(nowIso, o.stream, active, held).changes,
    );
  });

  // 2–6, with the rebind, in one transaction.
  const out = rebindReplicaWith(db, o, 'undo-budget', {}, (tx, { previous, current }) => {
    const undoDropped = dropUndo(tx, previous.replicaId);
    const reconcile = reconcileInPlace(tx, { scope: o.scope, previousReplica: previous.replicaId });
    const serverHeld = o.cursor.replicas[previous.replicaId]?.replicaSeq ?? null;
    const localPushed = hasTable(tx, '_sync_segment')
      ? (
          tx
            .prepare(
              "SELECT max(replica_seq) AS s FROM _sync_segment WHERE stream = ? AND replica_id = ? AND state = 'pushed'",
            )
            .get(o.stream, previous.replicaId) as { s: number | null }
        ).s
      : null;
    const candidates = [serverHeld, localPushed === null ? null : Number(localPushed)].filter(
      (n): n is number => n !== null,
    );
    const lastReplicaSeq = candidates.length > 0 ? Math.max(...candidates) : null;
    const retireTxn =
      lastReplicaSeq === null
        ? null
        : queueRetireTxn(tx, {
            scope: o.scope,
            stream: o.stream,
            retire: {
              replica: previous.replicaId,
              successor: current.replicaId,
              lastReplicaSeq,
            },
            nowMs: now.getTime(),
          });
    const pending: PendingRebind = {
      stream: o.stream,
      scope: o.scope,
      from: previous.replicaId,
      to: current.replicaId,
      lastReplicaSeq,
      retireTxn,
      at: nowIso,
    };
    tx.prepare('DELETE FROM _sync_meta WHERE key = ?').run(UNDO_BUDGET_EXCEEDED_KEY);
    tx.prepare(
      'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(REBIND_PENDING_KEY, JSON.stringify(pending), nowIso);
    return { undoDropped, reconcile, pending };
  });
  return {
    previousReplicaId: out.previousReplicaId,
    replicaId: out.replicaId,
    pending: out.result.pending,
    segmentsMarkedPushed: marked,
    undoDropped: out.result.undoDropped,
    reconcile: out.result.reconcile,
  };
}

/**
 * Empty the undo log in the rebind transaction (D5). First every transaction
 * of the old replica the stream has not sequenced is inherited, including
 * one carried by a segment the server stored after this pull reached head:
 * its echo would arrive under a replica this store no longer is, so it could
 * never be sequenced as its own. It lands as history instead, and the
 * reconcile re-emits its fields. Nothing is left to rewind, so the
 * foreign-touch index resets, as after the last echo.
 *
 * @returns The undo rows dropped.
 */
function dropUndo(db: DatabaseSync, previousReplica: string): number {
  if (hasTable(db, '_sync_txn') && hasTable(db, '_sync_sequenced')) {
    db.prepare(
      `UPDATE _sync_txn SET state = 'inherited' WHERE replica = ? AND state IN ('sealed', 'segmented')
         AND NOT EXISTS (SELECT 1 FROM _sync_sequenced s WHERE s.txn = _sync_txn.txn)`,
    ).run(previousReplica);
  }
  let dropped = 0;
  if (hasTable(db, '_sync_undo')) {
    dropped += Number(db.prepare('DELETE FROM _sync_undo').run().changes);
  }
  if (hasTable(db, '_sync_row_undo')) {
    dropped += Number(db.prepare('DELETE FROM _sync_row_undo').run().changes);
  }
  if (hasTable(db, '_sync_foreign_touch')) {
    db.prepare('DELETE FROM _sync_foreign_touch').run();
    db.prepare('DELETE FROM _sync_meta WHERE key IN (?, ?)').run(
      FOREIGN_TOUCH_INCOMPLETE_KEY,
      FOREIGN_TOUCH_COUNT_KEY,
    );
  }
  return dropped;
}
