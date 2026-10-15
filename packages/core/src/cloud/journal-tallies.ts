/**
 * The journal's tallies of a checkpoint window (journal spec §2.11, T12999):
 * the rows a stream holds after the segments since a checkpoint, from the
 * checkpoint's manifest, the window's declared per-transaction deltas and
 * what this store's inbox says each transaction became (`pending`, `void`,
 * applied). A vault snapshot of a journal stream checkpoints with them
 * instead of a synthetic delta segment, and `cleo cloud verify` compares the
 * store against them instead of the head snapshot's frozen counts.
 *
 * @task T12999
 * @module cloud/journal-tallies
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Checkpoint, TableDeltas, TxnRef } from '@cleocode/contracts/cloud';
import { LedgerTxn } from '@cleocode/contracts/ledger';
import { type InboxStatus, UNRESOLVED_INBOX_STATUSES } from '../store/sync/inbox.js';
import { hasTable } from '../store/sync/schema.js';
import { deltasOf } from '../store/sync/segments.js';
import { cursorFromCheckpoint, type Journal } from './journal.js';
import type { TrustedSigners } from './keys.js';
import { type DeclaredTxn, type SchemaRise, txnRefKey } from './manifest-check.js';

/** A window transaction: its ref, declared deltas and stream seq. */
export interface WindowTxn extends DeclaredTxn {
  /** The stream seq of its segment. */
  readonly seq: number;
}

/** The segments after a checkpoint, as the server declared them. */
export interface JournalWindow {
  /** Every transaction, in stream order. */
  readonly txns: readonly WindowTxn[];
  /** Each segment's seq and schemaVersion, in stream order. */
  readonly schemaVersions: readonly SchemaRise[];
  /** The last seq read (the checkpoint's coversSeq when the window is empty). */
  readonly after: number;
  /** The server's head seq. */
  readonly head: number;
}

/**
 * Read the segments after `parent` up to `upTo` (inclusive; the head when
 * omitted), verified by the journal client: each transaction's declared
 * deltas (`txnDeltas`, or a segment/v2's whole deltas as transaction 0).
 *
 * @param journal - The stream's journal client.
 * @param parent - The checkpoint the window starts after.
 * @param signers - The account's trusted signers.
 * @param upTo - The last seq to include.
 * @returns The window.
 */
export async function readJournalWindow(
  journal: Journal,
  parent: Pick<Checkpoint, 'coversSeq' | 'replicas'>,
  signers: TrustedSigners,
  upTo = Number.POSITIVE_INFINITY,
): Promise<JournalWindow> {
  const txns: WindowTxn[] = [];
  const schemaVersions: SchemaRise[] = [];
  let cursor = cursorFromCheckpoint(parent);
  let after = parent.coversSeq;
  for (;;) {
    const page = await journal.pull(cursor, signers, 200);
    for (const s of page.segments) {
      if (s.seq > upTo) return { txns, schemaVersions, after, head: page.head };
      const per = s.meta.txnDeltas ?? [{ txn: 0, deltas: s.meta.deltas }];
      for (const t of per) {
        txns.push({
          seq: s.seq,
          ref: { replicaId: s.replicaId, replicaSeq: s.replicaSeq, txn: t.txn },
          deltas: t.deltas,
        });
      }
      schemaVersions.push({ seq: s.seq, schemaVersion: s.meta.schemaVersion });
      after = s.seq;
    }
    cursor = page.cursor;
    if (page.segments.length === 0 || cursor.after >= page.head) {
      return { txns, schemaVersions, after, head: page.head };
    }
  }
}

/** A window's accounting (the v3 manifest fields) and the rows it leaves per manifest key. */
export interface JournalTallies {
  /** Per manifest key: parent rows + applied creates - applied deletes - voided. */
  readonly rows: Record<string, number>;
  /** Transactions not applied yet (the window's and the parent's still waiting). */
  readonly pending: TxnRef[];
  /** Effects of applied transactions that did not land. */
  readonly voided: DeclaredTxn[];
  /** Applied transactions whose effects all count (candidates for {@link settleShortfalls}). */
  readonly applied: DeclaredTxn[];
}

const OPEN: ReadonlySet<InboxStatus> = new Set(UNRESOLVED_INBOX_STATUSES);

type InboxRef = { replica_id: string; replica_seq: number; txn_idx: number };
type InboxEntry = InboxRef & { status: InboxStatus; txn_json: string };

const refOf = (r: InboxRef): TxnRef => ({
  replicaId: r.replica_id,
  replicaSeq: Number(r.replica_seq),
  txn: Number(r.txn_idx),
});

function addDeltas(rows: Record<string, number>, d: TableDeltas, sign: number): void {
  for (const [table, c] of Object.entries(d)) {
    rows[table] = (rows[table] ?? 0) + sign * (c.created - c.deleted);
  }
}

/**
 * The window's tallies as this store's inbox resolved it (§2.11 §3, §4). A
 * window transaction this store never staged (a segment past its pull, or a
 * vault delta segment) counts as applied; one staged and still open is
 * pending; a `void` one is voided whole. The parent's pending refs stay
 * pending until the inbox resolves them.
 *
 * @param db - The store (read only), or null for none (every transaction applied).
 * @param stream - The stream id.
 * @param parent - The checkpoint the window starts after.
 * @param window - The window ({@link readJournalWindow}).
 * @returns The tallies.
 */
export function journalTallies(
  db: DatabaseSync | null,
  stream: string,
  parent: Pick<Checkpoint, 'coversSeq' | 'manifest'>,
  window: Pick<JournalWindow, 'txns'>,
): JournalTallies {
  const inbox = db !== null && hasTable(db, '_sync_inbox');
  const entries = new Map<string, InboxEntry>();
  if (inbox) {
    const rows = db
      .prepare(
        'SELECT replica_id, replica_seq, txn_idx, status, txn_json FROM _sync_inbox WHERE stream = ? AND seq > ?',
      )
      .all(stream, parent.coversSeq) as InboxEntry[];
    for (const r of rows) entries.set(txnRefKey(refOf(r)), r);
  }
  const rows: Record<string, number> = {};
  for (const [table, e] of Object.entries(parent.manifest.tables)) rows[table] = e.rows;
  const pending: TxnRef[] = [];
  const voided: DeclaredTxn[] = [];
  const applied: DeclaredTxn[] = [];
  const settle = (ref: TxnRef, deltas: TableDeltas, status: InboxStatus | undefined): void => {
    if (status !== undefined && OPEN.has(status)) {
      pending.push(ref);
      return;
    }
    addDeltas(rows, deltas, 1);
    if (status === 'void') {
      addDeltas(rows, deltas, -1);
      voided.push({ ref, deltas });
    } else {
      applied.push({ ref, deltas });
    }
  };
  for (const t of window.txns) settle(t.ref, t.deltas, entries.get(txnRefKey(t.ref))?.status);
  const find = inbox
    ? db.prepare(
        'SELECT replica_id, replica_seq, txn_idx, status, txn_json FROM _sync_inbox WHERE stream = ? AND replica_id = ? AND replica_seq = ? AND txn_idx = ?',
      )
    : null;
  for (const ref of parent.manifest.pending ?? []) {
    const e = find?.get(stream, ref.replicaId, ref.replicaSeq, ref.txn) as InboxEntry | undefined;
    // Not staged here: still pending, as the parent said.
    if (e === undefined) pending.push(ref);
    else settle(ref, deltasOf(LedgerTxn.parse(JSON.parse(e.txn_json)).ops), e.status);
  }
  return { rows, pending, voided, applied };
}

/**
 * Explain the difference between the store's rows and the tallies as voided
 * effects of applied transactions: fewer rows than tallied voids declared
 * creates, more rows voids declared deletes, never beyond a transaction's
 * declared counts (§2.11 §4). What no declared count explains is returned
 * unexplained, and the checkpoint must not be written.
 *
 * shortcut: the applier records no per-op tallies, so a partial void is
 * attributed by count to the window's applied transactions in order, not to
 * the exact op; the server rule (counts within each declared transaction)
 * still holds. Upgrade when the replay records per-op outcomes.
 *
 * @param tallies - The window's tallies.
 * @param local - The store's rows per manifest key.
 * @param keys - The keys to settle (the journal's tables).
 * @returns The tallies with the extra voids, and the keys left unexplained.
 */
export function settleShortfalls(
  tallies: JournalTallies,
  local: Readonly<Record<string, number>>,
  keys: readonly string[],
): { tallies: JournalTallies; unexplained: string[] } {
  const rows = { ...tallies.rows };
  const extra = new Map<string, DeclaredTxn>();
  const unexplained: string[] = [];
  for (const table of keys) {
    let diff = (local[table] ?? 0) - (rows[table] ?? 0);
    const kind = diff < 0 ? 'created' : 'deleted';
    for (const t of tallies.applied) {
      if (diff === 0) break;
      const declared = t.deltas[table]?.[kind] ?? 0;
      const take = Math.min(declared, Math.abs(diff));
      if (take === 0) continue;
      const k = txnRefKey(t.ref);
      const v = extra.get(k) ?? { ref: t.ref, deltas: {} };
      const was = v.deltas[table] ?? { created: 0, deleted: 0 };
      extra.set(k, { ref: t.ref, deltas: { ...v.deltas, [table]: { ...was, [kind]: take } } });
      diff += diff < 0 ? take : -take;
      rows[table] = (rows[table] ?? 0) + (kind === 'created' ? -take : take);
    }
    if (diff !== 0) unexplained.push(table);
  }
  return {
    tallies: { ...tallies, rows, voided: [...tallies.voided, ...extra.values()] },
    unexplained,
  };
}
