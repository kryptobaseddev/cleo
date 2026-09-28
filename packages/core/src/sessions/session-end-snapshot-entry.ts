/**
 * Detached worker for the session-end SQLite snapshot.
 *
 * Spawned by `requestSessionEndSnapshot` (`session-end-snapshot.ts`) as a
 * detached, unref'd process, so the command that ended the session returns
 * without waiting for a VACUUM. Takes the snapshot through the gate's
 * `required` mode, waiting up to the full pre-destructive bound for the lock
 * (nobody is waiting on this process).
 *
 * As soon as it holds the gate lock it drops the per-project "worker pending"
 * marker — so a later session end spawns the next worker instead of
 * coalescing onto a snapshot that may no longer contain its writes — and then
 * snapshots UNCONDITIONALLY (`alwaysSnapshot`). Requests coalesced onto this
 * worker while it was queued; no generation it could observe proves their
 * writes are in an earlier snapshot, so it never counts itself covered.
 *
 * It appends one JSON line with the outcome to
 * `.cleo/logs/session-end-snapshot.log` (never stdout: this process has no
 * reader, and CLEO keeps stdout for LAFS envelopes).
 *
 * argv: `<projectRoot> <markerToken>`
 *
 * @task T12508
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';
import { SNAPSHOT_LOCK_WAIT_RETRIES } from '../store/snapshot-gate.js';
import { releaseSessionEndWorkerMarker, snapshotAfterSessionEnd } from './session-end-snapshot.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  process.stderr.write('session-end-snapshot worker: missing <projectRoot> argument\n');
  process.exit(2);
}
const markerToken = process.argv[3] ?? '';

const result = await snapshotAfterSessionEnd(projectRoot, {
  lockWaitRetries: SNAPSHOT_LOCK_WAIT_RETRIES,
  alwaysSnapshot: true,
  onLockAcquired: () => releaseSessionEndWorkerMarker(projectRoot, markerToken),
});
// Also on lock-timeout or failure: never leave the marker to block others.
releaseSessionEndWorkerMarker(projectRoot, markerToken);

try {
  const logsDir = join(getCleoDir(projectRoot), 'logs');
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(
    join(logsDir, 'session-end-snapshot.log'),
    `${JSON.stringify({
      event: 'session-end-snapshot',
      at: new Date().toISOString(),
      pid: process.pid,
      projectRoot,
      result,
    })}\n`,
  );
} catch {
  // Logging is best-effort; the snapshot outcome is already on disk.
}
// Store handles keep the event loop alive; the work is done.
process.exit(0);
