/**
 * Detached worker for the session-end SQLite snapshot.
 *
 * Spawned by `requestSessionEndSnapshot` (`session-end-snapshot.ts`) as a
 * detached, unref'd process, so the command that ended the session returns
 * without waiting for a VACUUM. Takes the snapshot through the gate's
 * `required` mode with the generation the parent observed, waiting up to the
 * full pre-destructive bound for the lock (nobody is waiting on this process).
 *
 * As soon as it holds the gate lock — before it claims a generation — it drops
 * the per-project "worker pending" marker, so a later session end spawns the
 * next worker instead of coalescing onto a snapshot that no longer covers it.
 *
 * It appends one JSON line with the outcome to
 * `.cleo/logs/session-end-snapshot.log` (never stdout: this process has no
 * reader, and CLEO keeps stdout for LAFS envelopes).
 *
 * argv: `<projectRoot> <seenGeneration | ""> <markerToken>`
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
const rawGeneration = process.argv[3] ?? '';
const markerToken = process.argv[4] ?? '';
const parsed = rawGeneration === '' ? Number.NaN : Number(rawGeneration);
const seenGeneration = Number.isSafeInteger(parsed) ? parsed : undefined;

const result = await snapshotAfterSessionEnd(projectRoot, {
  lockWaitRetries: SNAPSHOT_LOCK_WAIT_RETRIES,
  onLockAcquired: () => releaseSessionEndWorkerMarker(projectRoot, markerToken),
  ...(seenGeneration !== undefined && { seenGeneration }),
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
      seenGeneration: seenGeneration ?? null,
      result,
    })}\n`,
  );
} catch {
  // Logging is best-effort; the snapshot outcome is already on disk.
}
// Store handles keep the event loop alive; the work is done.
process.exit(0);
