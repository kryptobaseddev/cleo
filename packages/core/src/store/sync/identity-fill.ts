/**
 * The open-time row-identity fill under capture (journal spec §2.3a rule 1;
 * the S2 capture interactions of T12806 and T12801).
 *
 * The fill, the refill of pre-release fingerprints and the graveyard re-link
 * are DERIVED rewrites: every value they write is a deterministic function of
 * the store (spec §12.1), and a refill runs only before any uid has synced.
 * Capturing them would journal one K and one F per filled row under shadow
 * capture. So on a store with the sync schema they run inside
 * {@link withSyncTriggersSuspended}, and the tables they wrote are marked
 * suspect, for the sealer's repair diff (S3).
 *
 * One exception is journaled: a row whose identity a CAPTURED write cleared
 * (a snapshot-overwrite import, K old → NULL) gets the K that records its
 * new uid ({@link captureRemints}), in a `remint` frame, so the pair nets to
 * old → new instead of leaving the new identity unjournaled.
 *
 * @task T12343
 * @module store/sync/identity-fill
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { prepareRowIdentity, ROW_IDENTITY, type RowUidFillReport } from '../row-identity.js';
import {
  captureRemints,
  clearCaptureFrame,
  finishCaptureFrame,
  openCaptureFrame,
} from './capture.js';
import { readSyncFlags } from './flags.js';
import { refreshPendingBirthFps } from './remap.js';
import { hasTable } from './schema.js';
import { markSuspect, touchSet, withSyncTriggersSuspended } from './structural.js';

/** What the open-time fill did under capture. */
export interface IdentityFillUnderCapture {
  readonly report: RowUidFillReport | null;
  /** Tables marked suspect (the fill wrote them uncaptured). */
  readonly suspect: string[];
  /** Re-mint K captures written, per table. */
  readonly remints: Record<string, number>;
}

/** The tables a fill report says were written. */
export function filledTables(scope: TableScope, report: RowUidFillReport): string[] {
  const written = new Set<string>();
  const add = (counts: Readonly<Record<string, number>>) => {
    for (const [key, n] of Object.entries(counts)) {
      if (n > 0) written.add(key.split('.')[0] as string);
    }
  };
  add(report.filled);
  add(report.fingerprinted);
  add(report.refsFilled);
  if (report.relinked > 0) written.add('tasks_task_acceptance_criteria');
  if (report.refill === 'cleared') {
    for (const spec of ROW_IDENTITY[scope]) written.add(spec.table);
  }
  return [...written];
}

/**
 * Run the open-time identity fill ({@link prepareRowIdentity}). With
 * `sync.capture` on: with the capture triggers dropped, the written tables
 * marked suspect, and re-mint K captures for identities a captured write
 * cleared. With it off: exactly {@link prepareRowIdentity}, even when the
 * sync tables exist (`cleo project link` creates them, T13025).
 *
 * Never throws, like {@link prepareRowIdentity}: a failed bracket (busy,
 * a broken sync schema) is logged and reported as no fill.
 */
export function prepareRowIdentityUnderCapture(
  db: DatabaseSync,
  scope: TableScope,
  options: Parameters<typeof prepareRowIdentity>[2] = {},
): IdentityFillUnderCapture {
  const capture = readSyncFlags(db)['sync.capture'] && hasTable(db, '_sync_capture');
  if (!capture) {
    return { report: prepareRowIdentity(db, scope, options), suspect: [], remints: {} };
  }
  try {
    return bracketedFill(db, scope, options);
  } catch (err) {
    getLogger('row-identity').warn(
      { scope, err: err instanceof Error ? err.message : String(err) },
      'identity fill under capture failed; the store opens without it (T13025)',
    );
    return { report: null, suspect: [], remints: {} };
  }
}

function bracketedFill(
  db: DatabaseSync,
  scope: TableScope,
  options: Parameters<typeof prepareRowIdentity>[2],
): IdentityFillUnderCapture {
  return withSyncTriggersSuspended(db, scope, () => {
    const report = prepareRowIdentity(db, scope, options);
    const suspect = report ? markSuspect(db, scope, touchSet(db, filledTables(scope, report))) : [];
    // A refill re-derived birth fingerprints: what is still pending follows
    // the rows (§3.3 G, T12779).
    if (report?.refill === 'cleared') refreshPendingBirthFps(db, scope);
    const frame = openCaptureFrame(db, 'remint');
    try {
      const remints = captureRemints(db, scope);
      finishCaptureFrame(db, frame);
      return { report, suspect, remints };
    } finally {
      clearCaptureFrame(db, frame);
    }
  });
}
