/**
 * Session-end SQLite snapshot, taken AFTER the session is persisted.
 *
 * ADR-013 / T5158: `.cleo/cleo.db` is not tracked in git, so session end
 * writes a point-in-time snapshot to `.cleo/backups/sqlite/`. This used to be
 * a `SessionEnd` hook handler, but `endSession` dispatches those hooks BEFORE
 * it runs the memory bridge and marks the session ended, and the hook
 * registry runs every handler concurrently — so the snapshot could miss the
 * session's own final writes. {@link endSession} now calls this explicitly as
 * its last step (T12508).
 *
 * The request uses the snapshot gate's `required` mode (`store/snapshot-gate.ts`):
 * not debounced by earlier per-write checkpoints, satisfied only by a snapshot
 * that started after this request, and serialised by the project-wide lock so
 * a burst of session ends produces one snapshot. The lock wait is short
 * ({@link SESSION_END_LOCK_WAIT_RETRIES}, about 6.5 s) because session end runs
 * inside host shutdown hooks that may be killed.
 *
 * @task T12508
 */

import { getLogger } from '../logger.js';
import {
  describeSnapshotMiss,
  SESSION_END_LOCK_WAIT_RETRIES,
  type SnapshotGateResult,
} from '../store/snapshot-gate.js';

/**
 * Snapshot the project databases after a session has been persisted as ended.
 *
 * Never throws. A result other than a written or covered snapshot is logged
 * at warn level with its cause.
 *
 * @param projectRoot - Project root of the ended session.
 * @returns The gate outcome, or `null` when no snapshot could be attempted.
 * @task T12508
 */
export async function snapshotAfterSessionEnd(
  projectRoot: string,
): Promise<SnapshotGateResult | null> {
  const log = getLogger('session-end-snapshot');
  try {
    const { vacuumIntoBackupAll } = await import('../store/sqlite-backup.js');
    const result = await vacuumIntoBackupAll({
      cwd: projectRoot,
      mode: 'required',
      lockWaitRetries: SESSION_END_LOCK_WAIT_RETRIES,
    });
    const miss = describeSnapshotMiss(result);
    if (miss) log.warn({ projectRoot, cause: miss }, 'Session-end snapshot not taken');
    return result;
  } catch (err) {
    log.warn({ err, projectRoot }, 'Session-end snapshot failed');
    return null;
  }
}
