/**
 * Retiring a replica (journal spec §1.5 "Retirement", §3.5 Rule 2 D5;
 * T13278, T12753).
 *
 * A rebind that does not announce the old replica's end pins the fold
 * horizon (§1.7) and skews the remint authority (T12341). So a rebind of the
 * same file emits a signed `retire` control transaction under the NEW replica
 * ({@link queueRetireTxn}): `{replica, successor, lastReplicaSeq}`, packed and
 * signed like any sealed transaction. Every receiver records it at staging
 * ({@link recordRetirement}, `_sync_retired`), with the stream seq it was
 * sequenced at.
 *
 * A recorded retire counts only once the SERVER confirmed it
 * ({@link confirmRetirements}, T13366): any device on the account can sign a
 * `retire` naming itself successor, and only the server checks that the
 * signer may retire that replica (the pinned device, or a project owner's;
 * E31 `not-pinned-or-owner`). The emitter confirms from its E31 answer; a
 * home-stream receiver from the home replica listing's `retiredAt` and
 * `successor`. Until then the retire changes nothing.
 *
 * Once confirmed:
 * - a transaction of the retired replica sequenced AFTER the retire (a late
 *   segment, pushed before the rebind) is inherited history
 *   ({@link isInheritedHistory}): applied as an ordinary op, its merge
 *   conflicts not recorded against the successor's reconcile. Every receiver
 *   decides it by stream seq, so they all decide the same;
 * - the fold horizon leaves the retired replica out ({@link liveReplicaHorizon});
 * - the remint authority sees it retired at the retire's HLC
 *   ({@link withRetirements}).
 *
 * A copy retires nothing: its original is still live.
 *
 * @task T13278
 * @module store/sync/retire
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { LedgerTxnRetire } from '@cleocode/contracts/ledger';
import type { ProjectReplica } from '../display-id-alias.js';
import { tickClock } from './clock-store.js';
import { hasTable } from './schema.js';
import { reserveLocalSeq } from './sealer.js';
import { canonicalJson } from './sealer-values.js';

/** One replica a stream retired (`_sync_retired`). */
export interface RetiredReplicaRow {
  readonly stream: string;
  readonly replicaId: string;
  readonly successor: string;
  /** The last replicaSeq of the retired replica that may still land. */
  readonly lastReplicaSeq: number;
  /** The `retire` transaction. */
  readonly txn: string;
  /** Its HLC: the remint authority's retirement time. */
  readonly hlc: string;
  /** The stream seq the retire was sequenced at; null until it is (an own retire before its echo). */
  readonly seq: number | null;
  /** When the server confirmed the retirement (its `retiredAt`); null until it has. */
  readonly confirmedAt: string | null;
}

/** The server's record of one retirement, as a confirmation of a recorded retire. */
export interface ServerRetirement {
  readonly replicaId: string;
  /** The successor the server stored; a retire naming another one stays unconfirmed. */
  readonly successor: string | null;
  /** When the server retired the replica. */
  readonly retiredAt: string;
}

/** Options for {@link queueRetireTxn}. */
export interface QueueRetireOptions {
  readonly scope: TableScope;
  /** The stream the retire is announced on. */
  readonly stream: string;
  /** What is retired; `retire.successor` is the emitting (new) replica. */
  readonly retire: LedgerTxnRetire;
  /** Wall clock, ms. */
  readonly nowMs: number;
}

/**
 * Write this replica's `retire` control transaction as a sealed transaction
 * of the successor, in the caller's transaction, and record the retirement
 * locally (its seq comes with its echo). The segment builder packs and signs
 * it like any sealed transaction (`kind: 'retire'`, `via: 'rebind'`, no ops).
 *
 * @param db - The store, inside a transaction.
 * @param o - Scope, stream, the retirement and the clock.
 * @returns The transaction id, `${successor}:${localSeq}`.
 */
export function queueRetireTxn(db: DatabaseSync, o: QueueRetireOptions): string {
  // @sync-invariant none:local-only programming-error guard: the retire commits with its rebind
  if (!db.isTransaction) throw new Error('queueRetireTxn must run inside a transaction');
  const nowIso = new Date(o.nowMs).toISOString();
  const localSeq = reserveLocalSeq(db, nowIso);
  const txn = `${o.retire.successor}:${localSeq}`;
  const hlc = tickClock(db, o.retire.successor, o.nowMs);
  db.prepare(
    `INSERT INTO _sync_txn (txn, local_seq, replica, hlc, scope, via, kind, actor, frame, unframed,
       partial, op_count, sealed_at_ms, retire_json)
     VALUES (?, ?, ?, ?, ?, 'rebind', 'retire', NULL, NULL, 0, 0, 0, ?, ?)`,
  ).run(txn, localSeq, o.retire.successor, hlc, o.scope, o.nowMs, canonicalJson(o.retire));
  recordRetirement(db, o.stream, { ...o.retire, txn, hlc, seq: null });
  return txn;
}

/**
 * Record a retirement a stream carries (staging), or this replica's own
 * before its echo. The first retirement of a replica stands; a later record
 * of the same retire transaction only fills its seq.
 *
 * @param db - The store, inside the staging transaction.
 * @param stream - The stream.
 * @param r - The retire body, its transaction, HLC and stream seq.
 */
export function recordRetirement(
  db: DatabaseSync,
  stream: string,
  r: LedgerTxnRetire & { readonly txn: string; readonly hlc: string; readonly seq: number | null },
): void {
  db.prepare(
    `INSERT INTO _sync_retired (stream, replica_id, successor, last_replica_seq, txn, hlc, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (stream, replica_id) DO UPDATE SET seq = coalesce(_sync_retired.seq, excluded.seq)
       WHERE _sync_retired.txn = excluded.txn`,
  ).run(stream, r.replica, r.successor, r.lastReplicaSeq, r.txn, r.hlc, r.seq);
}

/**
 * Confirm recorded retires against the server's records (T13366): each
 * recorded, unconfirmed retire of a listed replica whose successor matches
 * gets the server's `retiredAt`. A server record for a retire not received
 * yet, or naming another successor, confirms nothing.
 *
 * @param db - The store.
 * @param stream - The stream the records are for.
 * @param records - The server's retirements on it.
 * @returns How many retires this confirmed.
 */
export function confirmRetirements(
  db: DatabaseSync,
  stream: string,
  records: readonly ServerRetirement[],
): number {
  if (records.length === 0 || !hasTable(db, '_sync_retired')) return 0;
  const confirm = db.prepare(
    `UPDATE _sync_retired SET confirmed_at = ?
      WHERE stream = ? AND replica_id = ? AND successor = ? AND confirmed_at IS NULL`,
  );
  let n = 0;
  for (const r of records) {
    n += Number(confirm.run(r.retiredAt, stream, r.replicaId, r.successor).changes);
  }
  return n;
}

/**
 * The replicas the server confirmed retired on `stream` (every stream when
 * omitted), by replica id: the set the fold horizon and the remint authority
 * leave out. `includeUnconfirmed` adds the retires received but not yet
 * confirmed (diagnostics). Read-only; empty before the journal schema is
 * installed.
 *
 * @param db - The store.
 * @param stream - The stream, or every stream.
 * @param opts - `includeUnconfirmed`: every recorded retire.
 * @returns The retirements.
 */
export function retiredReplicas(
  db: DatabaseSync,
  stream?: string,
  opts: { readonly includeUnconfirmed?: boolean } = {},
): Map<string, RetiredReplicaRow> {
  const out = new Map<string, RetiredReplicaRow>();
  if (!hasTable(db, '_sync_retired')) return out;
  const confirmed = opts.includeUnconfirmed === true ? '' : 'confirmed_at IS NOT NULL';
  const where = [stream === undefined ? '' : 'stream = ?', confirmed].filter((c) => c !== '');
  const sql = `SELECT * FROM _sync_retired${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY stream, replica_id`;
  const rows = (
    stream === undefined ? db.prepare(sql).all() : db.prepare(sql).all(stream)
  ) as Array<{
    stream: string;
    replica_id: string;
    successor: string;
    last_replica_seq: number;
    txn: string;
    hlc: string;
    seq: number | null;
    confirmed_at: string | null;
  }>;
  for (const r of rows) {
    out.set(r.replica_id, {
      stream: r.stream,
      replicaId: r.replica_id,
      successor: r.successor,
      lastReplicaSeq: Number(r.last_replica_seq),
      txn: r.txn,
      hlc: r.hlc,
      seq: r.seq === null ? null : Number(r.seq),
      confirmedAt: r.confirmed_at === null ? null : String(r.confirmed_at),
    });
  }
  return out;
}

/**
 * Whether a transaction of `replicaId` at stream seq `seq` is inherited
 * history: its replica was retired on this stream by a retire sequenced
 * before it (§3.5 D5) and the server confirmed that retirement (T13366).
 * Stream order decides which transactions are late; a receiver that applies
 * one before its confirmation arrives records its conflicts, which changes
 * conflict records only, never the applied values.
 *
 * @param db - The store.
 * @param stream - The stream.
 * @param replicaId - The transaction's replica.
 * @param seq - The transaction's stream seq.
 * @returns True for a late transaction of a retired replica.
 */
export function isInheritedHistory(
  db: DatabaseSync,
  stream: string,
  replicaId: string,
  seq: number,
): boolean {
  if (!hasTable(db, '_sync_retired')) return false;
  const row = db
    .prepare(
      'SELECT seq FROM _sync_retired WHERE stream = ? AND replica_id = ? AND confirmed_at IS NOT NULL',
    )
    .get(stream, replicaId) as { seq: number | null } | undefined;
  return row !== undefined && row.seq !== null && seq > Number(row.seq);
}

/**
 * The fold horizon's input over live replicas only (§1.7, §1.5): the lowest
 * HLC among `heads` once every retired replica is left out, or null when no
 * live replica remains. A retired replica never holds the horizon back.
 *
 * @param heads - Per replica, the HLC it has covered (its receive watermark).
 * @param retired - The retired replica ids.
 * @returns The lowest live HLC, or null.
 */
export function liveReplicaHorizon(
  heads: Readonly<Record<string, string>>,
  retired: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): string | null {
  let low: string | null = null;
  for (const [replica, hlc] of Object.entries(heads)) {
    if (retired.has(replica)) continue;
    if (low === null || hlc < low) low = hlc;
  }
  return low;
}

/**
 * The project membership the remint authority evaluates (T12341 §9.2), with
 * every replica this store saw retired marked `retiredHlc` at its retire's
 * HLC (a membership's own earlier retirement stands).
 *
 * @param replicas - The project's replicas.
 * @param retired - {@link retiredReplicas}.
 * @returns The membership with retirements applied.
 */
export function withRetirements(
  replicas: readonly ProjectReplica[],
  retired: ReadonlyMap<string, RetiredReplicaRow>,
): ProjectReplica[] {
  return replicas.map((r) => {
    const gone = retired.get(r.id);
    if (!gone || r.retiredHlc != null) return r;
    return { ...r, retiredHlc: gone.hlc };
  });
}
