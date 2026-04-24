/**
 * Deriver Queue — Status Reads
 *
 * Read-only query functions for inspecting the deriver_queue state.
 * Used by `cleo brain deriver status` CLI and monitoring.
 *
 * @task T1145
 * @epic T1145
 */

import type { DatabaseSync } from 'node:sqlite';
import type { DeriverQueueStatus } from '../store/memory-schema.js';
import { getBrainNativeDb } from '../store/memory-sqlite.js';

// ============================================================================
// Types
// ============================================================================

/** Count of queue items per status bucket. */
export interface DeriverQueueStatusCounts {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  total: number;
}

/** A single deriver queue item row (for display / monitoring). */
export interface DeriverQueueItem {
  id: string;
  itemType: string;
  itemId: string;
  priority: number;
  status: DeriverQueueStatus;
  claimedAt: string | null;
  claimedBy: string | null;
  errorMsg: string | null;
  retryCount: number;
  createdAt: string;
  completedAt: string | null;
}

/** Options for {@link getQueueStatus}. */
export interface GetQueueStatusOptions {
  /** Inject a DatabaseSync for testing. */
  db?: DatabaseSync | null;
}

// ============================================================================
// Internal row types
// ============================================================================

interface StatusCountRow {
  status: string;
  cnt: number;
}

interface RawQueueRow {
  id: string;
  item_type: string;
  item_id: string;
  priority: number;
  status: string;
  claimed_at: string | null;
  claimed_by: string | null;
  error_msg: string | null;
  retry_count: number;
  created_at: string;
  completed_at: string | null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Return counts of deriver queue items per status bucket.
 *
 * @param options - Optional db injection for tests.
 * @returns Status counts (all zeros if queue is empty or DB unavailable).
 *
 * @task T1145
 */
export function getQueueStatus(options: GetQueueStatusOptions = {}): DeriverQueueStatusCounts {
  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();

  const result: DeriverQueueStatusCounts = {
    pending: 0,
    in_progress: 0,
    done: 0,
    failed: 0,
    total: 0,
  };

  if (!nativeDb) {
    return result;
  }

  const rows = nativeDb
    .prepare(`SELECT status, COUNT(*) AS cnt FROM deriver_queue GROUP BY status`)
    .all() as unknown as StatusCountRow[];

  for (const row of rows) {
    const s = row.status as DeriverQueueStatus;
    if (s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed') {
      result[s] = row.cnt;
    }
    result.total += row.cnt;
  }

  return result;
}

/**
 * Return the N most recent deriver queue items for a given status.
 *
 * @param status  - Filter by status (or 'all' for all statuses).
 * @param limit   - Maximum rows to return. Default 20.
 * @param options - Optional db injection for tests.
 * @returns Array of queue items.
 *
 * @task T1145
 */
export function listQueueItems(
  status: DeriverQueueStatus | 'all' = 'all',
  limit = 20,
  options: GetQueueStatusOptions = {},
): DeriverQueueItem[] {
  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();

  if (!nativeDb) {
    return [];
  }

  const rows: RawQueueRow[] =
    status === 'all'
      ? (nativeDb
          .prepare(`SELECT * FROM deriver_queue ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as unknown as RawQueueRow[])
      : (nativeDb
          .prepare(`SELECT * FROM deriver_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
          .all(status, limit) as unknown as RawQueueRow[]);

  return rows.map((r) => ({
    id: r.id,
    itemType: r.item_type,
    itemId: r.item_id,
    priority: r.priority,
    status: r.status as DeriverQueueStatus,
    claimedAt: r.claimed_at,
    claimedBy: r.claimed_by,
    errorMsg: r.error_msg,
    retryCount: r.retry_count,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));
}

/**
 * Check whether the queue has any pending work.
 *
 * @param options - Optional db injection for tests.
 * @returns true if there is at least one pending item.
 *
 * @task T1145
 */
export function hasQueuePending(options: GetQueueStatusOptions = {}): boolean {
  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();
  if (!nativeDb) return false;

  const row = nativeDb
    .prepare(`SELECT COUNT(*) AS cnt FROM deriver_queue WHERE status = 'pending' LIMIT 1`)
    .get() as { cnt: number } | undefined;

  return (row?.cnt ?? 0) > 0;
}
