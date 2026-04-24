/**
 * Deriver Queue — Consumer / Batch Worker
 *
 * Implements the `runDeriverBatch()` function — the main entry point for
 * processing pending deriver queue items. Called from the sentient tick
 * (analogous to `checkAndDream`) and from `runBrainMaintenance`.
 *
 * Flow per batch:
 *   1. Run stale-claim recovery (re-queue stuck in_progress items)
 *   2. Claim next pending item
 *   3. Derive output via deriveItem()
 *   4. Mark item done (success) or fail (with retry logic)
 *   5. Repeat up to batchSize items
 *
 * Each item is processed atomically — a crash mid-derivation triggers
 * stale-claim recovery on the next batch run.
 *
 * @task T1145
 * @epic T1145
 */

import type { DatabaseSync } from 'node:sqlite';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import { deriveItem } from './deriver.js';
import { claimNextItem, completeItem, failItem, recoverStaleItems } from './queue-manager.js';

// ============================================================================
// Constants
// ============================================================================

/** Default number of items to process per batch. */
export const DEFAULT_BATCH_SIZE = 5;

// ============================================================================
// Types
// ============================================================================

/** Options for {@link runDeriverBatch}. */
export interface DeriverBatchOptions {
  /**
   * Maximum number of items to process in this batch.
   * Default: {@link DEFAULT_BATCH_SIZE}.
   */
  batchSize?: number;
  /**
   * Worker identifier prefix for claim ownership.
   * Default: `worker-<pid>-<timestamp>`.
   */
  workerId?: string;
  /** Inject a DatabaseSync for testing. */
  db?: DatabaseSync | null;
}

/** Result of a full batch run. */
export interface DeriverBatchResult {
  /** Number of items successfully processed (derived + marked done). */
  processed: number;
  /** Number of items that failed (moved to failed or re-queued with retry). */
  failed: number;
  /** Number of stale items re-queued before the batch started. */
  staleRequeued: number;
  /** Total items attempted (claimed). */
  attempted: number;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Process a batch of pending deriver queue items.
 *
 * Designed to be called from the sentient tick (every 5 min) and from
 * `runBrainMaintenance`. Safe to call even if queue is empty — returns
 * immediately with all-zero counts.
 *
 * @param projectRoot - Absolute path to project root (contains `.cleo/`).
 * @param options     - Batch size, workerId, db injection for tests.
 * @returns Summary counts for monitoring.
 *
 * @task T1145
 */
export async function runDeriverBatch(
  _projectRoot: string,
  options: DeriverBatchOptions = {},
): Promise<DeriverBatchResult> {
  const { batchSize = DEFAULT_BATCH_SIZE, workerId, db: injectedDb } = options;

  // Get the database — use injected or real
  const nativeDb = injectedDb !== undefined ? injectedDb : getBrainNativeDb();

  const result: DeriverBatchResult = {
    processed: 0,
    failed: 0,
    staleRequeued: 0,
    attempted: 0,
  };

  if (!nativeDb) {
    return result;
  }

  // Step 1: stale-claim recovery before claiming new items
  const staleResult = recoverStaleItems({ db: nativeDb });
  result.staleRequeued = staleResult.requeued;

  // Step 2: process up to batchSize items
  for (let i = 0; i < batchSize; i++) {
    const item = claimNextItem({ workerId, db: nativeDb });
    if (!item) break; // queue empty

    result.attempted++;

    try {
      const derivationResult = await deriveItem(item, { db: nativeDb });

      if (derivationResult.produced) {
        completeItem(item.id, { db: nativeDb });
        result.processed++;
      } else {
        // Item didn't produce output — treat as a soft failure (retry or skip)
        const reason = derivationResult.skipReason ?? 'no output produced';
        failItem(item.id, reason, { db: nativeDb });
        result.failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failItem(item.id, `consumer error: ${msg}`, { db: nativeDb });
      result.failed++;
    }
  }

  return result;
}
