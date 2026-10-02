/**
 * Minimal tombstones (journal spec §1.7, NEW-2, R5-5; T12986, S3c).
 *
 * The sealer writes a FULL tombstone on D: the row meta with `deleted = 1`,
 * the delete HLC, the natural key and the before-image hash. GC never forgets
 * that a uid was deleted; once the stream is safely past a tombstone,
 * {@link compactTombstones} shrinks it to the minimal form
 * (`tbl`, `uid`, `hlc`, `deleted = 1`), so a receiver can still tell a
 * deleted uid from a never-seen one and a late op never resurrects the row.
 * It is found by its WITHOUT ROWID key and has no entry in the tombstone
 * index (which holds only full tombstones): about 155 B per row as measured,
 * within the spec's ~190 B.
 *
 * Append-only tables get no per-row tombstone at all (the sealer removes
 * their meta on D); the horizon fold into `_sync_tomb_fold` needs checkpoint
 * receive watermarks and is S4.
 *
 * What makes a tombstone compactable is stream state this slice does not own
 * (the latest verified checkpoint's `ReplicaHeads`, T12338; the inbox's
 * pending and void transactions, T12344), so the caller supplies it as a
 * {@link TombstoneGcPolicy}.
 *
 * @module store/sync/tombstones
 * @task T12986
 * @epic T12323
 */

import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from './clock-store.js';
import { HlcError, parseHlc } from './hlc.js';
import { hasTable } from './schema.js';

/** Grace after a tombstone's physical time before it may be compacted (§1.7). */
export const TOMBSTONE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** When a full tombstone may shrink to its minimal form. */
export interface TombstoneGcPolicy {
  /**
   * The highest HLC every live replica has covered: in the latest verified
   * checkpoint's `ReplicaHeads`, each live replica's `lastReplicaSeq` covers a
   * segment whose `hlcMax` is at least this. Retired replicas are left out by
   * the caller (§1.5). Only tombstones at or below it are compacted.
   */
  readonly coveredHlc: string;
  /** Wall clock, ms. */
  readonly now: number;
  /** @defaultValue {@link TOMBSTONE_GRACE_MS} */
  readonly graceMs?: number;
  /**
   * Whether a `pending` or `void` inbox transaction references the uid
   * (T12344). Such a full tombstone is kept: the void may yet be revived.
   */
  readonly referenced: (tbl: string, uid: string) => boolean;
  /** Most tombstones examined per call. @defaultValue 5000 */
  readonly budget?: number;
}

/** What {@link compactTombstones} did. */
export interface TombstoneCompactReport {
  /** Full tombstones shrunk to the minimal form. */
  readonly compacted: number;
  /** Eligible by HLC and age, kept because an inbox transaction references the uid. */
  readonly referenced: number;
  /** Covered, but younger than the grace period. */
  readonly young: number;
}

/**
 * A full tombstone: the sealer always writes `version >= 1`, compaction sets
 * it to 0. The predicate matches the partial index `_sync_row_meta_tomb`
 * (`(hlc) WHERE deleted = 1 AND version > 0`), so GC scans only full ones and
 * a minimal tombstone carries no index entry.
 */
const FULL = 'version > 0';

/**
 * Shrink full tombstones the stream no longer needs to their minimal form,
 * in one `BEGIN IMMEDIATE`. Never deletes a tombstone: a minimal one is kept
 * for good (NEW-2).
 *
 * The minimal form keeps `tbl`, `uid`, `hlc` and `deleted = 1`; `origin` and
 * `version` take their empty values (`''`, `0`) because the columns are
 * NOT NULL, and `sent`, `held` and `fk_excluded` are left as they are.
 */
export function compactTombstones(
  db: DatabaseSync,
  policy: TombstoneGcPolicy,
): TombstoneCompactReport {
  if (!hasTable(db, '_sync_row_meta')) return { compacted: 0, referenced: 0, young: 0 };
  const grace = policy.graceMs ?? TOMBSTONE_GRACE_MS;
  const budget = Math.max(1, policy.budget ?? 5000);
  return withImmediateTransaction(db, () => {
    const rows = db
      .prepare(
        `SELECT tbl, uid, hlc FROM _sync_row_meta
          WHERE deleted = 1 AND ${FULL} AND hlc <= ?
          ORDER BY hlc LIMIT ?`,
      )
      .all(policy.coveredHlc, budget) as Array<{ tbl: string; uid: string; hlc: string }>;
    const shrink = db.prepare(
      `UPDATE _sync_row_meta
          SET fhlc = NULL, origin = '', actor = NULL, version = 0,
              key_json = NULL, chash = NULL, shash = NULL, bfp = NULL
        WHERE tbl = ? AND uid = ? AND deleted = 1`,
    );
    let compacted = 0;
    let referenced = 0;
    let young = 0;
    for (const r of rows) {
      if (policy.now - physicalMs(r.hlc) < grace) {
        young += 1;
        continue;
      }
      if (policy.referenced(r.tbl, r.uid)) {
        referenced += 1;
        continue;
      }
      shrink.run(r.tbl, r.uid);
      compacted += 1;
    }
    return { compacted, referenced, young };
  });
}

/** The physical ms of an HLC; an unparseable one counts as brand new (kept). */
function physicalMs(hlc: string): number {
  try {
    return parseHlc(hlc).phys;
  } catch (err) {
    if (err instanceof HlcError) return Number.POSITIVE_INFINITY;
    throw err;
  }
}

/** Tombstone counts for the doctor and the growth measurement (§1.7 R5-5). */
export function tombstoneCounts(db: DatabaseSync): { full: number; minimal: number } {
  if (!hasTable(db, '_sync_row_meta')) return { full: 0, minimal: 0 };
  const row = db
    .prepare(
      `SELECT coalesce(sum(CASE WHEN ${FULL} THEN 1 ELSE 0 END), 0) AS full,
              coalesce(sum(CASE WHEN ${FULL} THEN 0 ELSE 1 END), 0) AS minimal
         FROM _sync_row_meta WHERE deleted = 1`,
    )
    .get() as { full: number; minimal: number };
  return { full: row.full, minimal: row.minimal };
}
