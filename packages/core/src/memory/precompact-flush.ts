/**
 * Pre-compact Flush — capture in-flight session observations before context compaction.
 *
 * When Claude Code's context window approaches the compaction threshold, this
 * module flushes any pending diary-type observations captured during the current
 * session to `brain_observations` so that no context is lost across the
 * compaction boundary.
 *
 * It also runs `PRAGMA wal_checkpoint(TRUNCATE)` on brain.db to ensure all
 * WAL frames are flushed to the main database file before compaction occurs.
 *
 * Design constraints:
 * - Must complete in < 5 s (30-second hook timeout window).
 * - Must be a graceful no-op when no pending observations are present.
 * - Must be idempotent: a second call after a successful flush does nothing.
 *
 * @module precompact-flush
 * @task T1004
 * @epic T1000
 */

import { getCurrentSessionId } from '../sessions/context-alert.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pending observation captured in process memory awaiting flush. */
export interface PendingObservation {
  /** Observation text / content. */
  text: string;
  /** Optional human-readable title. */
  title?: string;
  /** Observation type. Falls back to 'discovery' if 'diary' is not yet in schema. */
  type?: string;
  /** Session ID that originated this observation. */
  sessionId?: string;
}

/** Result returned by {@link precompactFlush}. */
export interface PrecompactFlushResult {
  /** Number of observations persisted to brain_observations. */
  flushed: number;
  /** Whether the WAL checkpoint was executed. */
  walCheckpointed: boolean;
  /** Any non-fatal error messages encountered (flush is best-effort). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// In-process pending queue
// ---------------------------------------------------------------------------

/**
 * Module-level pending observation queue.
 *
 * Observations registered via {@link enqueuePendingObservation} are held here
 * until {@link precompactFlush} drains them. The queue is cleared after a
 * successful flush to guarantee idempotency.
 */
const _pendingQueue: PendingObservation[] = [];

/**
 * Register an observation that should be flushed at the next pre-compact hook.
 *
 * Call this function whenever an agent captures context that has not yet been
 * persisted to brain.db (e.g. work-in-progress notes, mid-task decisions).
 *
 * @param obs - The observation to queue for flush.
 */
export function enqueuePendingObservation(obs: PendingObservation): void {
  _pendingQueue.push(obs);
}

/**
 * Return a snapshot of the current pending queue (for testing / inspection).
 * Does not mutate the queue.
 *
 * @returns Readonly copy of the pending observations.
 */
export function getPendingObservations(): readonly PendingObservation[] {
  return [..._pendingQueue];
}

/**
 * Clear the pending observation queue.
 * Called internally after a successful flush, and exposed for testing.
 */
export function clearPendingObservations(): void {
  _pendingQueue.length = 0;
}

// ---------------------------------------------------------------------------
// Main flush function
// ---------------------------------------------------------------------------

/**
 * Flush all pending in-flight observations to brain.db and checkpoint the WAL.
 *
 * Steps performed:
 * 1. Collect all observations from the in-process pending queue.
 * 2. Persist each observation via `observeBrain` with `sourceType='agent'`.
 * 3. Run `PRAGMA wal_checkpoint(TRUNCATE)` on brain.db.
 * 4. Clear the pending queue so a second call is a no-op.
 *
 * Returns `{flushed: 0, walCheckpointed: false, errors: []}` when there are
 * no pending observations and brain.db has not yet been initialised in this
 * process (lazy DB init guard).
 *
 * Never throws — all errors are captured in the `errors` array so that hook
 * failures do not interrupt Claude Code's compaction sequence.
 *
 * @param projectRoot - Absolute path to the project root directory.
 *                      Defaults to `process.cwd()`.
 * @returns Flush result summary.
 */
export async function precompactFlush(projectRoot?: string): Promise<PrecompactFlushResult> {
  const result: PrecompactFlushResult = {
    flushed: 0,
    walCheckpointed: false,
    errors: [],
  };

  const root = projectRoot ?? process.cwd();

  // Snapshot the queue and clear it immediately to prevent double-flush if
  // this function is called concurrently (belt-and-suspenders; the hook
  // runner is single-threaded in practice).
  const pending = [..._pendingQueue];
  clearPendingObservations();

  // Step 1 — Flush pending observations to brain_observations.
  if (pending.length > 0) {
    try {
      const { observeBrain } = await import('./brain-retrieval.js');
      const sessionId = getCurrentSessionId(root) ?? undefined;

      for (const obs of pending) {
        try {
          // Use 'discovery' as a safe fallback type; 'diary' is added by T1005.
          const obsType = obs.type ?? 'discovery';
          const safeType = (
            [
              'discovery',
              'change',
              'feature',
              'bugfix',
              'decision',
              'refactor',
              'diary',
            ] as string[]
          ).includes(obsType)
            ? (obsType as Parameters<typeof observeBrain>[1]['type'])
            : ('discovery' as const);

          await observeBrain(root, {
            text: obs.text,
            title: obs.title,
            type: safeType,
            sourceSessionId: obs.sessionId ?? sessionId,
            sourceType: 'agent',
          });
          result.flushed++;
        } catch (obsErr) {
          result.errors.push(
            `Failed to flush observation "${obs.title ?? obs.text.slice(0, 60)}": ${
              obsErr instanceof Error ? obsErr.message : String(obsErr)
            }`,
          );
          // Do NOT re-enqueue — best-effort semantics to avoid infinite loops.
        }
      }
    } catch (importErr) {
      result.errors.push(
        `Failed to import brain-retrieval: ${
          importErr instanceof Error ? importErr.message : String(importErr)
        }`,
      );
    }
  }

  // Step 2 — WAL checkpoint.
  try {
    const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();
    if (nativeDb) {
      nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      result.walCheckpointed = true;
    }
    // If nativeDb is null the brain DB was never opened in this process —
    // skip silently (no data to checkpoint).
  } catch (walErr) {
    result.errors.push(
      `WAL checkpoint failed: ${walErr instanceof Error ? walErr.message : String(walErr)}`,
    );
  }

  return result;
}
