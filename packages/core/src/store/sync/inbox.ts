/**
 * The receive inbox (T12344; journal spec §3.1, §3.2).
 *
 * Every received transaction is staged in `_sync_inbox` in stream order,
 * keyed by `(stream, seq, txn_idx)`, so a re-pull stages nothing twice. The
 * applier ({@link stagedTxns} → apply → {@link markTxns}) moves each through
 * its statuses:
 *
 * - `staged`: received, not yet tried;
 * - `pending`: waits for something it needs (a never-seen row or reference,
 *   or a pending transaction it depends on); retried on every pass;
 * - `held-skew`: its HLC is beyond the skew bound; retried, FIFO per replica;
 * - `applied`, `conflict`, `void`: tried; `conflict` and `void` carry their
 *   records in `_sync_conflict` and are revivable;
 * - `refused-schema`: written by a newer schema or format; replayed after an
 *   upgrade, never skipped.
 *
 * A split transaction (`part: [i, n]`) is returned only once all n parts are
 * staged, as one transaction whose ops are the parts' ops in order (Q18).
 *
 * @module store/sync/inbox
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import { LEDGER_TXN_VERSION, LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { withImmediateTransaction } from './clock-store.js';

/** A transaction's apply status in the inbox. */
export type InboxStatus =
  | 'staged'
  | 'pending'
  | 'applied'
  | 'void'
  | 'conflict'
  | 'held-skew'
  | 'refused-schema';

/** The statuses the applier tries again. */
export const OPEN_INBOX_STATUSES: readonly InboxStatus[] = ['staged', 'pending', 'held-skew'];

/** One staged row's position in the stream. */
export interface InboxKey {
  readonly stream: string;
  readonly seq: number;
  readonly txnIdx: number;
}

/** One verified segment's transactions, as the receiver stages them. */
export interface InboxSegment {
  /** The segment's stream sequence number. */
  readonly seq: number;
  readonly replicaId: string;
  /** The origin replica's gap-free segment number. */
  readonly replicaSeq: number;
  readonly deviceId: string;
  /** The segment's `schemaVersion` (§2.9). */
  readonly schemaVersion: number;
  /** The decoded transactions, in segment order (secrets still inner-sealed). */
  readonly txns: readonly LedgerTxn[];
}

/** One transaction the applier may try, its parts joined. */
export interface StagedTxn {
  /** Position of its first part. */
  readonly key: InboxKey;
  /** Every part's position, in part order (one entry when not split). */
  readonly parts: readonly InboxKey[];
  readonly replicaId: string;
  readonly replicaSeq: number;
  readonly deviceId: string;
  readonly schemaVersion: number;
  /** The status it was staged under: `staged`, `pending` or `held-skew`. */
  readonly status: InboxStatus;
  /** The transaction, ops of every part in order, `hlc` the largest. */
  readonly txn: LedgerTxn;
}

type InboxRow = {
  stream: string;
  seq: number;
  txn_idx: number;
  replica_id: string;
  replica_seq: number;
  device_id: string;
  schema_version: number;
  txn_json: string;
  status: InboxStatus;
};

/**
 * Stage a verified segment's transactions. Rows already staged (same
 * stream, seq, index) are left alone, so a re-pull is idempotent.
 *
 * Exactly-once beyond the inbox's own rows is the receiver's: it stages only
 * segments past its persisted `_sync_cursor` and advances the cursor in the
 * same transaction (§3.1 step 3), so a segment whose applied rows were
 * pruned after a verified checkpoint is never staged again. Counter deltas
 * rely on it.
 *
 * @param db - The store (the journal schema applied); opens its own
 *   transaction unless the caller holds one.
 * @param stream - The stream id.
 * @param segment - The segment and its decoded transactions.
 * @param nowIso - The staging time.
 * @returns How many transactions were newly staged.
 */
export function stageTxns(
  db: DatabaseSync,
  stream: string,
  segment: InboxSegment,
  nowIso: string,
): number {
  const run = (): number => {
    const ins = db.prepare(
      `INSERT INTO _sync_inbox (stream, seq, txn_idx, replica_id, replica_seq, device_id,
         schema_version, txn_json, hlc, status, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)
       ON CONFLICT (stream, seq, txn_idx) DO NOTHING`,
    );
    let staged = 0;
    segment.txns.forEach((txn, i) => {
      const r = ins.run(
        stream,
        segment.seq,
        i,
        segment.replicaId,
        segment.replicaSeq,
        segment.deviceId,
        segment.schemaVersion,
        JSON.stringify(txn),
        txn.hlc,
        nowIso,
      );
      staged += Number(r.changes);
    });
    return staged;
  };
  return db.isTransaction ? run() : withImmediateTransaction(db, run);
}

const keyOf = (r: InboxRow): InboxKey => ({ stream: r.stream, seq: r.seq, txnIdx: r.txn_idx });

/** The split-transaction marker a refused part's reason carries (T13242). */
const txnMarker = (txn: string): string => `[txn ${txn}]`;

/** A refused row's txn id, from its JSON or, when that is unreadable, its text. */
function txnIdOf(text: string): string | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw === 'object' && raw !== null && 'txn' in raw && typeof raw.txn === 'string') {
      return raw.txn;
    }
  } catch {
    // not JSON: fall back to the text
  }
  return /"txn"\s*:\s*"([^"\\]+)"/.exec(text)?.[1] ?? null;
}

/**
 * A staged row's transaction, or why it cannot be read (T13234): a format
 * newer than this build (`E_SCHEMA_AHEAD`), or a malformed row.
 */
function parseStaged(r: InboxRow): LedgerTxn | string {
  let raw: unknown;
  try {
    raw = JSON.parse(r.txn_json);
  } catch {
    return 'malformed transaction: not JSON';
  }
  const ok = LedgerTxn.safeParse(raw);
  if (ok.success) return ok.data;
  const v =
    typeof raw === 'object' && raw !== null && 'v' in raw && typeof raw.v === 'number' ? raw.v : 0;
  if (v > LEDGER_TXN_VERSION || r.schema_version > SYNC_SCHEMA_VERSION) {
    return `E_SCHEMA_AHEAD: transaction format v${v} (segment schemaVersion ${r.schema_version}) is newer than this build; upgrade CLEO to apply it`;
  }
  return `malformed transaction: ${ok.error.issues[0]?.message ?? 'invalid'}`;
}

/**
 * The transactions the applier may try, in `(seq, txn_idx)` order: every
 * `staged`, `pending` and `held-skew` row, a split transaction once all of
 * its parts are staged.
 *
 * @param db - The store.
 * @param stream - The stream id.
 * @param limit - At most this many transactions; 0 for all.
 * @returns The transactions, parts joined.
 */
export function stagedTxns(db: DatabaseSync, stream: string, limit = 0): StagedTxn[] {
  const rows = db
    .prepare(
      `SELECT stream, seq, txn_idx, replica_id, replica_seq, device_id, schema_version, txn_json, status
       FROM _sync_inbox WHERE stream = ? AND status IN (${OPEN_INBOX_STATUSES.map(() => '?').join(', ')})
       ORDER BY seq, txn_idx`,
    )
    .all(stream, ...OPEN_INBOX_STATUSES) as InboxRow[];
  const parsed: Array<{ row: InboxRow; txn: LedgerTxn }> = [];
  const nowIso = new Date().toISOString();
  for (const r of rows) {
    const txn = parseStaged(r);
    if (typeof txn === 'string') {
      // One unreadable row (a newer writer's format) never stalls the stream:
      // it is refused, kept for replay after an upgrade, and the rest flows.
      // Its txn id rides in the reason, so its sibling parts are found even
      // when its JSON is unreadable.
      const id = txnIdOf(r.txn_json);
      const reason = id !== null ? `${txn} ${txnMarker(id)}` : txn;
      markTxns(db, [keyOf(r)], 'refused-schema', { reason, nowIso });
      continue;
    }
    parsed.push({ row: r, txn });
  }
  // A split transaction is refused whole (T13242): when one of its parts was
  // refused (now or in an earlier pass), its other parts can never complete.
  const refusedPart = db.prepare(
    `SELECT 1 FROM _sync_inbox WHERE stream = ? AND replica_id = ? AND status = 'refused-schema'
       AND ((json_valid(txn_json) AND json_extract(txn_json, '$.txn') = ?)
         OR instr(coalesce(reason, ''), ?) > 0) LIMIT 1`,
  );
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i] as (typeof parsed)[number];
    if (!p.txn.part) continue;
    if (!refusedPart.get(stream, p.row.replica_id, p.txn.txn, txnMarker(p.txn.txn))) continue;
    markTxns(db, [keyOf(p.row)], 'refused-schema', {
      reason: `another part of split transaction ${p.txn.txn} was refused`,
      nowIso,
    });
    parsed.splice(i, 1);
  }
  // Parts of one split transaction: same origin replica and txn id.
  const groups = new Map<string, Array<(typeof parsed)[number]>>();
  for (const p of parsed) {
    if (!p.txn.part) continue;
    const g = `${p.row.replica_id}\u0000${p.txn.txn}`;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const out: StagedTxn[] = [];
  for (const p of parsed) {
    if (limit > 0 && out.length >= limit) break;
    const base = {
      key: keyOf(p.row),
      replicaId: p.row.replica_id,
      replicaSeq: p.row.replica_seq,
      deviceId: p.row.device_id,
      schemaVersion: p.row.schema_version,
      status: p.row.status,
    };
    const part = p.txn.part;
    if (!part) {
      out.push({ ...base, parts: [base.key], txn: p.txn });
      continue;
    }
    if (part[0] !== 1) continue; // returned at its first part
    const all = groups.get(`${p.row.replica_id}\u0000${p.txn.txn}`) ?? [];
    const byIndex = new Map(all.map((x) => [x.txn.part?.[0], x]));
    const ordered = Array.from({ length: part[1] }, (_, i) => byIndex.get(i + 1));
    const complete = ordered.filter((x): x is (typeof parsed)[number] => x !== undefined);
    if (complete.length !== part[1]) continue; // not every part staged yet
    const hlc = complete.reduce((m, x) => (x.txn.hlc > m ? x.txn.hlc : m), p.txn.hlc);
    const { part: _part, ...head } = p.txn;
    out.push({
      ...base,
      parts: complete.map((x) => keyOf(x.row)),
      txn: { ...head, hlc, ops: complete.flatMap((x) => x.txn.ops) },
    });
  }
  return out;
}

/**
 * Set the status of a transaction's rows (every part of it).
 *
 * @param db - The store, inside the applier's transaction (or its own).
 * @param keys - The transaction's parts.
 * @param status - The new status.
 * @param opts - The apply frame, a reason, and the time (`applied_at` for a tried status).
 */
export function markTxns(
  db: DatabaseSync,
  keys: readonly InboxKey[],
  status: InboxStatus,
  opts: {
    readonly frame?: string | null;
    readonly reason?: string | null;
    readonly nowIso: string;
  },
): void {
  const tried = !OPEN_INBOX_STATUSES.includes(status) && status !== 'refused-schema';
  const up = db.prepare(
    `UPDATE _sync_inbox SET status = ?, applied_frame = ?, reason = ?, applied_at = ?
     WHERE stream = ? AND seq = ? AND txn_idx = ?`,
  );
  for (const k of keys) {
    up.run(
      status,
      opts.frame ?? null,
      opts.reason ?? null,
      tried ? opts.nowIso : null,
      k.stream,
      k.seq,
      k.txnIdx,
    );
  }
}

/**
 * Inbox rows per status for a stream (doctor and tests).
 *
 * @param db - The store.
 * @param stream - The stream id.
 * @returns Status → row count; absent statuses omitted.
 */
export function inboxCounts(
  db: DatabaseSync,
  stream: string,
): Partial<Record<InboxStatus, number>> {
  const rows = db
    .prepare('SELECT status, count(*) AS n FROM _sync_inbox WHERE stream = ? GROUP BY status')
    .all(stream) as Array<{ status: InboxStatus; n: number }>;
  const out: Partial<Record<InboxStatus, number>> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
