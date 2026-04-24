/**
 * Deriver Queue — Enqueue Helpers
 *
 * Provides functions to add derivation work items to the durable deriver_queue
 * table. Uses randomBytes for IDs consistent with other brain module ID patterns.
 *
 * Dedup: if a pending or in_progress item with the same (item_type, item_id)
 * already exists, the enqueue is a no-op (returns the existing ID).
 *
 * @task T1145
 * @epic T1145
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeriverQueueItemType } from '../store/memory-schema.js';
import { getBrainNativeDb } from '../store/memory-sqlite.js';

// ============================================================================
// Types
// ============================================================================

/** Options for {@link enqueueDerivation}. */
export interface EnqueueOptions {
  /**
   * Priority for ordering within the same status bucket.
   * Higher = processed first. Default 0.
   */
  priority?: number;
  /** Inject a DatabaseSync for testing without touching the real brain.db. */
  db?: DatabaseSync | null;
}

/** Result of a successful enqueue operation. */
export interface EnqueueResult {
  /** The queue item ID (new or existing). */
  id: string;
  /** Whether a new item was inserted (false = already existed, dedup skipped). */
  inserted: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate a new deriver queue item ID. */
function generateDeriverQueueId(): string {
  return `dq-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Enqueue a derivation work item.
 *
 * Inserts a new row into `deriver_queue` with `status='pending'`. If an
 * active (pending or in_progress) item with the same `(itemType, itemId)`
 * already exists, the enqueue is silently skipped and the existing ID is
 * returned with `inserted: false`.
 *
 * @param itemType - The type of derivation to perform.
 * @param itemId   - Source item ID (e.g. brain_observations.id).
 * @param options  - Optional priority, db injection for tests.
 * @returns EnqueueResult with the item ID and whether insertion occurred.
 * @throws If the database is unavailable.
 *
 * @task T1145
 */
export function enqueueDerivation(
  itemType: DeriverQueueItemType,
  itemId: string,
  options: EnqueueOptions = {},
): EnqueueResult {
  const { priority = 0, db: injectedDb } = options;
  const nativeDb = injectedDb !== undefined ? injectedDb : getBrainNativeDb();

  if (!nativeDb) {
    throw new Error('[deriver/enqueue] Brain database is not initialized.');
  }

  // Dedup check: is there already an active item for this (type, itemId)?
  const existingRow = nativeDb
    .prepare(
      `SELECT id FROM deriver_queue
       WHERE item_type = ? AND item_id = ? AND status IN ('pending', 'in_progress')
       LIMIT 1`,
    )
    .get(itemType, itemId) as { id: string } | undefined;

  if (existingRow) {
    return { id: existingRow.id, inserted: false };
  }

  const id = generateDeriverQueueId();
  const now = new Date().toISOString();

  nativeDb
    .prepare(
      `INSERT INTO deriver_queue
         (id, item_type, item_id, priority, status, retry_count, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    )
    .run(id, itemType, itemId, priority, now);

  return { id, inserted: true };
}

/**
 * Enqueue multiple observations for inductive synthesis.
 *
 * Convenience wrapper that enqueues each observation ID individually,
 * returning the count of newly inserted items.
 *
 * @param observationIds - Array of brain_observations.id values to derive from.
 * @param options        - Optional priority, db injection for tests.
 * @returns Count of newly inserted queue items (deduped items excluded).
 *
 * @task T1145
 */
export function enqueueObservationBatch(
  observationIds: string[],
  options: EnqueueOptions = {},
): number {
  let insertedCount = 0;
  for (const id of observationIds) {
    const result = enqueueDerivation('observation', id, options);
    if (result.inserted) insertedCount++;
  }
  return insertedCount;
}
