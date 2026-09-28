/**
 * Detached worker for the session-end SQLite snapshot.
 *
 * Spawned by `requestSessionEndSnapshot` (`session-end-snapshot.ts`) as a
 * detached, unref'd process, so the command that ended the session returns
 * without waiting for a VACUUM. Takes the snapshot through the gate's
 * `required` mode with the generation the parent observed, waiting up to the
 * full pre-destructive bound for the lock (nobody is waiting on this process),
 * and appends one JSON line with the outcome to stdout, which the parent
 * redirected to `.cleo/logs/session-end-snapshot.log`.
 *
 * argv: `<projectRoot> <seenGeneration | "">`
 *
 * @task T12508
 */

import { SNAPSHOT_LOCK_WAIT_RETRIES } from '../store/snapshot-gate.js';
import { snapshotAfterSessionEnd } from './session-end-snapshot.js';

const projectRoot = process.argv[2] ?? process.cwd();
const rawGeneration = process.argv[3] ?? '';
const parsed = rawGeneration === '' ? Number.NaN : Number(rawGeneration);
const seenGeneration = Number.isSafeInteger(parsed) ? parsed : undefined;

const result = await snapshotAfterSessionEnd(projectRoot, {
  lockWaitRetries: SNAPSHOT_LOCK_WAIT_RETRIES,
  ...(seenGeneration !== undefined && { seenGeneration }),
});
process.stdout.write(
  `${JSON.stringify({
    event: 'session-end-snapshot',
    at: new Date().toISOString(),
    pid: process.pid,
    projectRoot,
    seenGeneration: seenGeneration ?? null,
    result,
  })}\n`,
);
// Store handles keep the event loop alive; the work is done.
process.exit(0);
