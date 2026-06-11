/**
 * Deriver Queue — Queue Manager
 *
 * Implements claim/complete/fail/stale-recovery operations for the
 * deriver_queue table using SQLite WAL with BEGIN IMMEDIATE for safe
 * concurrent single-node access.
 *
 * Claim pattern (analogous to PostgreSQL FOR UPDATE SKIP LOCKED):
 *   BEGIN IMMEDIATE
 *   SELECT ... WHERE status='pending' ORDER BY priority DESC, created_at ASC LIMIT 1
 *   UPDATE ... SET status='in_progress', claimed_at=now, claimed_by=workerId
 *   COMMIT
 *
 * SQLite serializes WAL writes via the WAL journal, so two concurrent
 * callers with BEGIN IMMEDIATE will take turns safely.
 *
 * @task T1145
 * @epic T1145
 */

import type { DatabaseSync } from 'node:sqlite';
import { getBrainNativeDb } from '../store/memory-sqlite.js';

// ============================================================================
// Constants
// ============================================================================

/** Max stale claim age in minutes before item is re-queued. */
export const STALE_CLAIM_MINUTES = 30;

/** Max retry count before item is moved to 'failed' permanently. */
export const MAX_RETRY_COUNT = 5;

/**
 * Base exponential-backoff delay in seconds for a re-queued item (T10405).
 *
 * A failed/recovered item's next claim is gated until
 * `now + BACKOFF_BASE_SECONDS * 2^(retryCount - 1)`, capped at
 * {@link BACKOFF_MAX_SECONDS}. With base 30s the schedule is
 * 30s → 60s → 120s → 240s (then capped), so a transiently-failing item
 * backs off geometrically instead of hot-looping the worker.
 */
export const BACKOFF_BASE_SECONDS = 30;

/** Maximum exponential-backoff delay in seconds (cap for {@link computeBackoffSeconds}). */
export const BACKOFF_MAX_SECONDS = 30 * 60;

/** SQLite busy error string (returned when BEGIN IMMEDIATE cannot acquire lock). */
const SQLITE_BUSY_STR = 'database is locked';

// ============================================================================
// Types
// ============================================================================

/** Options for {@link claimNextItem}. */
export interface ClaimOptions {
  /**
   * Worker identifier. Used to track which process claimed the item.
   * Defaults to `worker-<pid>-<timestamp>`.
   */
  workerId?: string;
  /** Inject a DatabaseSync for testing. */
  db?: DatabaseSync | null;
}

/** A claimed queue item. */
export interface ClaimedItem {
  id: string;
  itemType: string;
  itemId: string;
  priority: number;
  retryCount: number;
}

/** Options for {@link completeItem} and {@link failItem}. */
export interface CompleteOptions {
  /** Inject a DatabaseSync for testing. */
  db?: DatabaseSync | null;
}

/** Result of a stale-claim recovery sweep. */
export interface StaleRecoveryResult {
  /** Number of items re-queued from in_progress to pending. */
  requeued: number;
  /** Number of items permanently failed due to max retries. */
  failed: number;
}

// ============================================================================
// Internal row types
// ============================================================================

interface RawClaimRow {
  id: string;
  item_type: string;
  item_id: string;
  priority: number;
  retry_count: number;
}

interface StaleRow {
  id: string;
  retry_count: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate a default worker ID from process pid and timestamp. */
function defaultWorkerId(): string {
  return `worker-${process.pid}-${Date.now().toString(36)}`;
}

/** Return ISO 8601 timestamp for N minutes ago. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

/**
 * Compute the exponential-backoff delay (seconds) for a re-queued item (T10405).
 *
 * Returns `BACKOFF_BASE_SECONDS * 2^(attempt - 1)` capped at
 * {@link BACKOFF_MAX_SECONDS}. `attempt` is the *new* retry count (1-based:
 * the first failure backs off by the base delay). An `attempt` of 0 or less is
 * clamped to 1 so the first retry always waits at least the base delay.
 *
 * @param attempt - The new (post-increment) retry count for the item.
 * @returns Backoff delay in seconds, in `[BACKOFF_BASE_SECONDS, BACKOFF_MAX_SECONDS]`.
 *
 * @task T10405
 */
export function computeBackoffSeconds(attempt: number): number {
  const safeAttempt = attempt < 1 ? 1 : attempt;
  const delay = BACKOFF_BASE_SECONDS * 2 ** (safeAttempt - 1);
  return Math.min(delay, BACKOFF_MAX_SECONDS);
}

/** Return ISO 8601 timestamp for N seconds in the future. */
function secondsFromNow(n: number): string {
  return new Date(Date.now() + n * 1000).toISOString();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Claim the next pending item from the deriver queue.
 *
 * Uses BEGIN IMMEDIATE to serialize against concurrent callers in the same
 * process (e.g. test helpers). Returns null if no pending item exists or if
 * the database is busy.
 *
 * @param options - workerId override, db injection for tests.
 * @returns The claimed item, or null if queue is empty / DB busy.
 *
 * @task T1145
 */
export function claimNextItem(options: ClaimOptions = {}): ClaimedItem | null {
  const { workerId = defaultWorkerId(), db: injectedDb } = options;
  const nativeDb = injectedDb !== undefined ? injectedDb : getBrainNativeDb();

  if (!nativeDb) return null;

  // Begin exclusive-like transaction. SQLite WAL + IMMEDIATE is sufficient.
  try {
    nativeDb.exec('BEGIN IMMEDIATE');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(SQLITE_BUSY_STR)) {
      return null; // Another caller holds the lock — skip this tick
    }
    throw err;
  }

  try {
    // T10405: gate on the exponential-backoff window — a re-queued item with a
    // future `next_attempt_at` is skipped until its backoff elapses. Fresh items
    // (next_attempt_at IS NULL) are always eligible.
    const now = new Date().toISOString();
    const row = nativeDb
      .prepare(
        `SELECT id, item_type, item_id, priority, retry_count
         FROM deriver_queue
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
      )
      .get(now) as RawClaimRow | undefined;

    if (!row) {
      nativeDb.exec('ROLLBACK');
      return null;
    }

    nativeDb
      .prepare(
        `UPDATE deriver_queue
         SET status = 'in_progress', claimed_at = ?, claimed_by = ?
         WHERE id = ?`,
      )
      .run(now, workerId, row.id);

    nativeDb.exec('COMMIT');

    return {
      id: row.id,
      itemType: row.item_type,
      itemId: row.item_id,
      priority: row.priority,
      retryCount: row.retry_count,
    };
  } catch (err) {
    try {
      nativeDb.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

/**
 * Mark a claimed item as successfully completed.
 *
 * @param itemId  - The deriver_queue.id to complete.
 * @param options - Optional db injection for tests.
 *
 * @task T1145
 */
export function completeItem(itemId: string, options: CompleteOptions = {}): void {
  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();
  if (!nativeDb) return;

  const now = new Date().toISOString();
  nativeDb
    .prepare(
      `UPDATE deriver_queue
       SET status = 'done', completed_at = ?
       WHERE id = ? AND status = 'in_progress'`,
    )
    .run(now, itemId);
}

/**
 * Mark a claimed item as failed (with optional error message).
 *
 * If `retryCount` is below {@link MAX_RETRY_COUNT}, the item is re-queued
 * to `pending` with `retryCount + 1` and an exponential-backoff
 * `next_attempt_at` (T10405) so it is not re-claimed until the backoff window
 * elapses. Otherwise the item is permanently moved to `failed` (DLQ semantics)
 * and its backoff gate is cleared.
 *
 * @param itemId   - The deriver_queue.id to fail.
 * @param errorMsg - Human-readable error for the error_msg column.
 * @param options  - Optional db injection for tests.
 *
 * @task T1145
 */
export function failItem(itemId: string, errorMsg: string, options: CompleteOptions = {}): void {
  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();
  if (!nativeDb) return;

  // Read current retry count
  const row = nativeDb.prepare(`SELECT retry_count FROM deriver_queue WHERE id = ?`).get(itemId) as
    | { retry_count: number }
    | undefined;

  if (!row) return;

  const nextRetry = (row.retry_count ?? 0) + 1;
  const permanentFail = nextRetry >= MAX_RETRY_COUNT;
  const nextStatus = permanentFail ? 'failed' : 'pending';
  // Re-queued items back off geometrically; permanently-failed items clear the gate.
  const nextAttemptAt = permanentFail ? null : secondsFromNow(computeBackoffSeconds(nextRetry));

  nativeDb
    .prepare(
      `UPDATE deriver_queue
       SET status = ?, retry_count = ?, error_msg = ?,
           claimed_at = NULL, claimed_by = NULL, next_attempt_at = ?
       WHERE id = ? AND status = 'in_progress'`,
    )
    .run(nextStatus, nextRetry, errorMsg, nextAttemptAt, itemId);
}

/**
 * Re-queue stale in_progress items whose `claimed_at` is older than
 * {@link STALE_CLAIM_MINUTES} minutes.
 *
 * Items that have exceeded {@link MAX_RETRY_COUNT} are permanently moved
 * to `failed` instead of being re-queued.
 *
 * Designed to be called from `runBrainMaintenance` as a periodic health check.
 *
 * @param options - Optional db injection for tests.
 * @returns Count of items requeued and count permanently failed.
 *
 * @task T1145
 */
export function recoverStaleItems(options: CompleteOptions = {}): StaleRecoveryResult {
  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();
  const result: StaleRecoveryResult = { requeued: 0, failed: 0 };

  if (!nativeDb) return result;

  const threshold = minutesAgo(STALE_CLAIM_MINUTES);

  const staleRows = nativeDb
    .prepare(
      `SELECT id, retry_count
       FROM deriver_queue
       WHERE status = 'in_progress' AND claimed_at < ?`,
    )
    .all(threshold) as unknown as StaleRow[];

  for (const row of staleRows) {
    const nextRetry = (row.retry_count ?? 0) + 1;
    if (nextRetry >= MAX_RETRY_COUNT) {
      nativeDb
        .prepare(
          `UPDATE deriver_queue
           SET status = 'failed', retry_count = ?, error_msg = 'stale: max retries exceeded',
               claimed_at = NULL, claimed_by = NULL
           WHERE id = ?`,
        )
        .run(nextRetry, row.id);
      result.failed++;
    } else {
      // T10405: re-queued stale items also back off geometrically.
      const nextAttemptAt = secondsFromNow(computeBackoffSeconds(nextRetry));
      nativeDb
        .prepare(
          `UPDATE deriver_queue
           SET status = 'pending', retry_count = ?, error_msg = 'recovered from stale claim',
               claimed_at = NULL, claimed_by = NULL, next_attempt_at = ?
           WHERE id = ?`,
        )
        .run(nextRetry, nextAttemptAt, row.id);
      result.requeued++;
    }
  }

  return result;
}
