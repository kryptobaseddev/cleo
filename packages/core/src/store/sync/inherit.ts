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
 * What a copy changed and never sent is not lost: the S4 reconcile restores
 * the latest checkpoint, diffs it against this store and re-emits those
 * fields under the new replica (§1.5 three-way rule). Segmented transactions
 * and segments are S4's to mark when they arrive.
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
  /** Sealed transactions not yet carried by a segment. */
  readonly txns: number;
}

/**
 * Mark every live capture and every sealed transaction `inherited`. Runs in
 * the caller's (rebind) transaction; a store without the outbox tables has
 * nothing to mark.
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
  const txns = hasTable(db, '_sync_txn')
    ? Number(
        db.prepare("UPDATE _sync_txn SET state = 'inherited' WHERE state = 'sealed'").run().changes,
      )
    : 0;
  return { captures, txns };
}
