/**
 * The journal's window tallies (T12999, journal spec §2.11): pending and
 * voided transactions from the inbox, and the count attribution a journal
 * checkpoint settles its rows with.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { journalTallies, settleShortfalls, type WindowTxn } from '../journal-tallies.js';

const STREAM = 'project:p';
const ref = (replicaId: string, replicaSeq: number) => ({ replicaId, replicaSeq, txn: 0 });

/** An inbox holding `entries` (seq, replica, status). */
function inboxOf(entries: Array<[number, string, string]>): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE _sync_inbox (stream TEXT, seq INTEGER, txn_idx INTEGER, replica_id TEXT, replica_seq INTEGER, txn_json TEXT, status TEXT)',
  );
  const ins = db.prepare("INSERT INTO _sync_inbox VALUES (?, ?, 0, ?, ?, '{}', ?)");
  for (const [seq, replica, status] of entries) ins.run(STREAM, seq, replica, 0, status);
  return db;
}

const parent = {
  coversSeq: 10,
  manifest: { schemaVersion: 1, tables: { tasks: { rows: 5, hash: 'h' } } },
};
const window: WindowTxn[] = [
  { seq: 11, ref: ref('a', 0), deltas: { tasks: { created: 1, deleted: 0 } } },
  { seq: 12, ref: ref('b', 0), deltas: { tasks: { created: 1, deleted: 0 } } },
  { seq: 13, ref: ref('c', 0), deltas: { tasks: { created: 0, deleted: 1 } } },
];

describe('journalTallies (T12999)', () => {
  it('an open transaction is pending, a void one voided whole, and an unstaged one applied', () => {
    const db = inboxOf([
      [12, 'b', 'pending'],
      [13, 'c', 'void'],
    ]);
    const t = journalTallies(db, STREAM, parent, { txns: window });
    expect(t.pending).toEqual([ref('b', 0)]);
    expect(t.voided).toEqual([{ ref: ref('c', 0), deltas: { tasks: { created: 0, deleted: 1 } } }]);
    expect(t.applied.map((x) => x.ref)).toEqual([ref('a', 0)]);
    expect(t.rows).toEqual({ tasks: 6 });
    // Without a store, every transaction counts as applied.
    expect(journalTallies(null, STREAM, parent, { txns: window }).rows).toEqual({ tasks: 6 });
  });

  it('settles a shortfall as voids of applied transactions, never past their declared counts', () => {
    const t = journalTallies(inboxOf([]), STREAM, parent, { txns: window });
    expect(t.rows).toEqual({ tasks: 6 });
    // One create did not land.
    const fewer = settleShortfalls(t, { tasks: 5 }, ['tasks']);
    expect(fewer.unexplained).toEqual([]);
    expect(fewer.tallies.rows).toEqual({ tasks: 5 });
    expect(fewer.tallies.voided).toEqual([
      { ref: ref('a', 0), deltas: { tasks: { created: 1, deleted: 0 } } },
    ]);
    // The delete did not land.
    const more = settleShortfalls(t, { tasks: 7 }, ['tasks']);
    expect(more.unexplained).toEqual([]);
    expect(more.tallies.voided).toEqual([
      { ref: ref('c', 0), deltas: { tasks: { created: 0, deleted: 1 } } },
    ]);
    // More rows than every declared delete explains: refused.
    expect(settleShortfalls(t, { tasks: 8 }, ['tasks']).unexplained).toEqual(['tasks']);
  });
});
