/**
 * Inherited rows on rebind (journal spec §1.5 H3; T12753).
 *
 * A rebind means this store file is no longer the replica that wrote its
 * outbox: it is a copy, a restore or a rolled-back file. Everything the old
 * replica captured or sealed and never sent belongs to that replica, not to
 * the new one. So, in the rebind transaction, every live capture and every
 * sealed transaction is marked `inherited`. The sealer reads only live
 * captures, and only non-inherited transactions are ever built or sent, so a
 * new replica never re-emits the original's rows.
 *
 * Segments the old replica built and never pushed are inherited too, with
 * the transactions they carry (S4, T13278): push only ever sends the active
 * replica's segments, and the state says why these never will be. A segment
 * the server already stored must be marked pushed before the rebind (the
 * rebind at head does, from the pull cursor), or it reads as inherited.
 *
 * What a copy changed and never sent is not lost: the reconcile re-emits
 * those fields under the new replica (§1.5 three-way rule, `reconcile.ts`).
 *
 * @task T12753
 * @module store/sync/inherit
 */

import type { DatabaseSync } from 'node:sqlite';
import { hasTable } from './schema.js';

/** The rows a rebind marked `inherited`. */
export interface InheritedRows {
  /** Captures that were still live (unsealed). */
  readonly captures: number;
  /** Sealed transactions not yet carried by a pushed segment. */
  readonly txns: number;
  /** Segments built and never pushed. */
  readonly segments: number;
}

/**
 * Mark every live capture, every sealed transaction, and every unpushed
 * segment with the transactions it carries `inherited`. Runs in the caller's
 * (rebind) transaction; a store without the outbox tables has nothing to
 * mark.
 *
 * @returns How many rows were marked.
 */
export function markInheritedRows(db: DatabaseSync): InheritedRows {
  const captures = hasTable(db, '_sync_capture')
    ? Number(
        db.prepare("UPDATE _sync_capture SET state = 'inherited' WHERE state = 'live'").run()
          .changes,
      )
    : 0;
  let txns = 0;
  let segments = 0;
  if (hasTable(db, '_sync_txn')) {
    if (hasTable(db, '_sync_segment')) {
      txns += Number(
        db
          .prepare(
            `UPDATE _sync_txn SET state = 'inherited' WHERE state = 'segmented' AND txn IN (
               SELECT m.txn FROM _sync_segment_txn m JOIN _sync_segment s
                 ON s.stream = m.stream AND s.replica_id = m.replica_id AND s.replica_seq = m.replica_seq
                WHERE s.state = 'sealed')`,
          )
          .run().changes,
      );
      segments = Number(
        db.prepare("UPDATE _sync_segment SET state = 'inherited' WHERE state = 'sealed'").run()
          .changes,
      );
    }
    txns += Number(
      db.prepare("UPDATE _sync_txn SET state = 'inherited' WHERE state = 'sealed'").run().changes,
    );
  }
  return { captures, txns, segments };
}
