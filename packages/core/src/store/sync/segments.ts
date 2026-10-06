/**
 * Persist before push: the segment outbox (journal spec §2.8 "Building
 * segments", "Persist before push"; T12343 O-1).
 *
 * Sealed local transactions are packed, in local commit order, into a
 * segment of one stream: `deflate-raw(canonical JSON of LedgerTxn[])` with
 * its plaintext metadata (op count, HLC range, per-table and per-transaction
 * deltas, schema version). The caller's sealer encrypts it (the journal
 * client's `sealSegment`, under the stream key), and ONE local transaction
 * then:
 * - inserts the `_sync_segment` row with the exact sealed bytes and their
 *   hash, at the next `replicaSeq` of (stream, replica), state `sealed`;
 * - maps every packed transaction to it (`_sync_segment_txn`) and marks it
 *   `segmented` (it stays unsequenced until its echo, §3.5);
 * - sets `_sync_row_meta.sent` for every row it carries;
 * - writes the `row_identity_synced` marker if absent (§3.4: uids are about
 *   to leave the device).
 *
 * A push sends the persisted bytes, never re-sealed: re-encrypting would
 * change the hash and defeat the server's (replica, hash) idempotency, so a
 * crash at any point resends the same segment or finds it stored.
 *
 * @task T12343
 * @module store/sync/segments
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';
import type { TableDeltas, TxnDelta } from '@cleocode/contracts/cloud';
import { LedgerActor, LedgerOp, type LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import type { SegmentMetaFields } from '../../cloud/signing.js';
import { ROW_IDENTITY_META_TABLE, ROW_IDENTITY_SYNCED_KEY } from '../row-identity.js';
import { hasTable } from './schema.js';
import { canonicalJson } from './sealer-values.js';

/** Encrypts a segment for one stream (the journal client's `sealSegment`). */
export type SegmentSealer = (
  replicaSeq: number,
  plaintext: Uint8Array,
  meta: SegmentMetaFields,
) => Buffer;

/** What {@link buildSegment} needs. */
export interface BuildSegmentOptions {
  /** The stream (`project:<id>` or `home:<userId>`). */
  readonly stream: string;
  /** This store's bound replica (the segment's author). */
  readonly replica: string;
  /** The merge key's project, or null on a home stream. */
  readonly project: string | null;
  readonly sealer: SegmentSealer;
  /** Signs each packed transaction for the stream (§2.8: `signTxn` of txn-signing.ts, with the device key). */
  readonly signTxn: (stream: string, txn: LedgerTxn) => LedgerTxn;
  readonly nowIso: string;
  /** Stop packing once the canonical JSON passes this many bytes (one txn always goes in). */
  readonly maxPlaintextBytes?: number;
}

/** A persisted segment, as push reads it. */
export interface PersistedSegment {
  readonly stream: string;
  readonly replica: string;
  readonly replicaSeq: number;
  readonly meta: SegmentMetaFields;
  readonly sealed: Buffer;
  readonly segmentHash: string;
  readonly state: 'sealed' | 'pushed';
  readonly serverSeq: number | null;
  /** The transactions it carries, in order. */
  readonly txns: readonly string[];
}

/** Default plaintext budget: comfortably under the 1 MiB inline ciphertext limit once deflated. */
export const SEGMENT_PLAINTEXT_BUDGET = 512 * 1024;

/** The server's cap on transactions per segment (`MAX_TXNS_PER_SEGMENT`). */
const MAX_TXNS_PER_SEGMENT = 10_000;

/** A sealed local transaction as the wire carries it, before {@link BuildSegmentOptions.signTxn} signs it. */
function ledgerTxnOf(
  db: DatabaseSync,
  row: { txn: string; hlc: string; scope: string; via: string; kind: string; actor: string | null },
  project: string | null,
): LedgerTxn {
  let actor: LedgerActor | null = null;
  if (row.actor?.startsWith('{')) {
    const parsed = LedgerActor.safeParse(JSON.parse(row.actor));
    if (parsed.success) actor = parsed.data;
  }
  const ops = (
    db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx').all(row.txn) as Array<{
      body: string;
    }>
  ).map((o) => LedgerOp.parse(JSON.parse(o.body)));
  return {
    v: 1,
    txn: row.txn,
    hlc: row.hlc,
    project,
    scope: row.scope === 'global' ? 'global' : 'project',
    via: row.via as LedgerTxn['via'],
    kind: row.kind as LedgerTxn['kind'],
    actor,
    ops,
    sig: '',
  };
}

/** Per-table created/deleted counts of ops (an I creates, a D deletes; U and K count as neither). */
function deltasOf(ops: readonly LedgerOp[]): TableDeltas {
  const out: Record<string, { created: number; deleted: number }> = {};
  for (const op of ops) {
    if (op.o !== 'I' && op.o !== 'D') continue;
    const d = out[op.t] ?? { created: 0, deleted: 0 };
    out[op.t] = d;
    if (op.o === 'I') d.created += 1;
    else d.deleted += 1;
  }
  return out;
}

/** Sum per-transaction deltas into the segment's deltas. */
function sumDeltas(parts: readonly TableDeltas[]): TableDeltas {
  const out: Record<string, { created: number; deleted: number }> = {};
  for (const p of parts) {
    for (const [t, d] of Object.entries(p)) {
      const s = out[t] ?? { created: 0, deleted: 0 };
      out[t] = s;
      s.created += d.created;
      s.deleted += d.deleted;
    }
  }
  return out;
}

/**
 * The segment metadata of `txns` (§2.8): op count, HLC range over every
 * transaction and op, per-table deltas and per-transaction deltas
 * (segment/v3), at this build's sync schema version.
 *
 * @param txns - The transactions, in segment order.
 * @returns The metadata.
 */
export function segmentMetaOf(
  txns: readonly LedgerTxn[],
): SegmentMetaFields & { txnDeltas: TxnDelta[] } {
  const hlcs = txns.flatMap((t) => [t.hlc, ...t.ops.map((o) => o.h)]).sort();
  const txnDeltas = txns.map((t, i) => ({ txn: i, deltas: deltasOf(t.ops) }));
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    opCount: txns.reduce((n, t) => n + t.ops.length, 0),
    hlcMin: hlcs[0] as string,
    hlcMax: hlcs[hlcs.length - 1] as string,
    deltas: sumDeltas(txnDeltas.map((t) => t.deltas)),
    txnDeltas,
  };
}

/**
 * The plaintext of a segment: `deflate-raw` of the canonical JSON of its
 * transactions (§2.8).
 *
 * @param txns - The transactions, in segment order.
 * @returns The bytes the stream key encrypts.
 */
export function segmentPlaintext(txns: readonly LedgerTxn[]): Buffer {
  return deflateRawSync(Buffer.from(canonicalJson(txns), 'utf8'));
}

/** The next `replicaSeq` of (stream, replica): one past the last persisted, or 0. */
function nextReplicaSeq(db: DatabaseSync, stream: string, replica: string): number {
  const row = db
    .prepare('SELECT max(replica_seq) AS s FROM _sync_segment WHERE stream = ? AND replica_id = ?')
    .get(stream, replica) as { s: number | null };
  return row.s === null ? 0 : Number(row.s) + 1;
}

/**
 * Pack the next sealed transactions into one segment of `stream`, seal it,
 * and persist it before any push (§2.8). Opens its own `BEGIN IMMEDIATE`, so
 * it must run outside a transaction and outside any frame.
 *
 * @param db - The store.
 * @param o - Stream, replica, project, sealer and clock.
 * @returns The persisted segment, or null when nothing is waiting.
 */
export function buildSegment(db: DatabaseSync, o: BuildSegmentOptions): PersistedSegment | null {
  const budget = o.maxPlaintextBytes ?? SEGMENT_PLAINTEXT_BUDGET;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare(
        `SELECT txn, hlc, scope, via, kind, actor FROM _sync_txn
          WHERE state = 'sealed' ORDER BY local_seq LIMIT ?`,
      )
      .all(MAX_TXNS_PER_SEGMENT) as Array<{
      txn: string;
      hlc: string;
      scope: string;
      via: string;
      kind: string;
      actor: string | null;
    }>;
    const txns: LedgerTxn[] = [];
    let bytes = 0;
    for (const r of rows) {
      const t = o.signTxn(o.stream, ledgerTxnOf(db, r, o.project));
      const size = Buffer.byteLength(canonicalJson(t), 'utf8');
      if (txns.length > 0 && bytes + size > budget) break;
      txns.push(t);
      bytes += size;
    }
    if (txns.length === 0) {
      db.exec('COMMIT');
      return null;
    }
    const replicaSeq = nextReplicaSeq(db, o.stream, o.replica);
    const meta = segmentMetaOf(txns);
    const sealed = o.sealer(replicaSeq, segmentPlaintext(txns), meta);
    const segmentHash = createHash('sha256').update(sealed).digest('hex');
    db.prepare(
      `INSERT INTO _sync_segment (stream, replica_id, replica_seq, meta_json, sealed, segment_hash, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sealed', ?)`,
    ).run(o.stream, o.replica, replicaSeq, canonicalJson(meta), sealed, segmentHash, o.nowIso);
    const map = db.prepare(
      'INSERT INTO _sync_segment_txn (stream, replica_id, replica_seq, idx, txn) VALUES (?, ?, ?, ?, ?)',
    );
    const mark = db.prepare("UPDATE _sync_txn SET state = 'segmented' WHERE txn = ?");
    const sent = db.prepare('UPDATE _sync_row_meta SET sent = 1 WHERE tbl = ? AND uid = ?');
    txns.forEach((t, i) => {
      map.run(o.stream, o.replica, replicaSeq, i, t.txn);
      mark.run(t.txn);
      for (const op of t.ops) {
        sent.run(op.t, op.u);
        if (op.o === 'K' && op.nu) sent.run(op.t, op.nu);
      }
    });
    markRowIdentitySynced(db, o.replica, o.stream, o.nowIso);
    db.exec('COMMIT');
    return {
      stream: o.stream,
      replica: o.replica,
      replicaSeq,
      meta,
      sealed,
      segmentHash,
      state: 'sealed',
      serverSeq: null,
      txns: txns.map((t) => t.txn),
    };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** Write `row_identity_synced` once, before the first uid leaves the device (§3.4). */
function markRowIdentitySynced(
  db: DatabaseSync,
  replica: string,
  stream: string,
  nowIso: string,
): void {
  if (!hasTable(db, ROW_IDENTITY_META_TABLE)) return;
  db.prepare(
    `INSERT INTO main.${ROW_IDENTITY_META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
  ).run(
    ROW_IDENTITY_SYNCED_KEY,
    JSON.stringify({ at: nowIso, replicaId: replica, stream, reason: 'send' }),
  );
}

type SegmentRow = {
  stream: string;
  replica_id: string;
  replica_seq: number;
  meta_json: string;
  sealed: Uint8Array;
  segment_hash: string;
  state: string;
  server_seq: number | null;
};

function toSegment(db: DatabaseSync, r: SegmentRow): PersistedSegment {
  const txns = (
    db
      .prepare(
        'SELECT txn FROM _sync_segment_txn WHERE stream = ? AND replica_id = ? AND replica_seq = ? ORDER BY idx',
      )
      .all(r.stream, r.replica_id, r.replica_seq) as Array<{ txn: string }>
  ).map((t) => t.txn);
  return {
    stream: r.stream,
    replica: r.replica_id,
    replicaSeq: Number(r.replica_seq),
    meta: JSON.parse(r.meta_json) as SegmentMetaFields,
    sealed: Buffer.from(r.sealed),
    segmentHash: r.segment_hash,
    state: r.state === 'pushed' ? 'pushed' : 'sealed',
    serverSeq: r.server_seq === null ? null : Number(r.server_seq),
    txns,
  };
}

/**
 * The persisted segments of `stream` not yet acknowledged by the server, in
 * `replicaSeq` order (push sends the lowest first, one at a time).
 *
 * @param db - The store.
 * @param stream - The stream.
 * @param replica - This store's replica.
 * @returns The unpushed segments.
 */
export function unpushedSegments(
  db: DatabaseSync,
  stream: string,
  replica: string,
): PersistedSegment[] {
  return (
    db
      .prepare(
        `SELECT stream, replica_id, replica_seq, meta_json, sealed, segment_hash, state, server_seq
           FROM _sync_segment WHERE stream = ? AND replica_id = ? AND state = 'sealed' ORDER BY replica_seq`,
      )
      .all(stream, replica) as SegmentRow[]
  ).map((r) => toSegment(db, r));
}

/**
 * Record that the server stored a segment (a new append or a duplicate):
 * its stream `seq`.
 *
 * @param db - The store.
 * @param s - The segment and the server's seq.
 */
export function markSegmentPushed(
  db: DatabaseSync,
  s: {
    readonly stream: string;
    readonly replica: string;
    readonly replicaSeq: number;
    readonly serverSeq: number;
    readonly nowIso: string;
  },
): void {
  db.prepare(
    `UPDATE _sync_segment SET state = 'pushed', server_seq = ?, pushed_at = ?
      WHERE stream = ? AND replica_id = ? AND replica_seq = ?`,
  ).run(s.serverSeq, s.nowIso, s.stream, s.replica, s.replicaSeq);
}
