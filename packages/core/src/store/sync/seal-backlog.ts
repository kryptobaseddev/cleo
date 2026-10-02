/**
 * The sealer's capture backlog, read-only (T13029, T13036).
 *
 * Its own module so `cleo doctor` reads the backlog without importing the
 * sealer itself.
 *
 * @module store/sync/seal-backlog
 * @task T13036
 * @epic T12323
 */

import type { DatabaseSync } from 'node:sqlite';
import { hasTable } from './schema.js';

/**
 * The capture backlog, for `cleo doctor`: live captures, and the oldest
 * one's seq and age. A head that stays put across seals is stuck. Read-only.
 */
export function sealBacklog(db: DatabaseSync): {
  readonly live: number;
  readonly oldestSeq: number | null;
  readonly oldestAtMs: number | null;
} {
  if (!hasTable(db, '_sync_capture')) return { live: 0, oldestSeq: null, oldestAtMs: null };
  const r = db
    .prepare(
      "SELECT count(*) AS n, min(seq) AS s, (SELECT at_ms FROM _sync_capture WHERE state = 'live' ORDER BY seq LIMIT 1) AS a FROM _sync_capture WHERE state = 'live'",
    )
    .get() as { n: number; s: number | null; a: number | null };
  return { live: r.n, oldestSeq: r.s, oldestAtMs: r.a };
}
