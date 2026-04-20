/**
 * Proposal Rate Limiter — Transactional DB-enforced daily cap.
 *
 * Enforces a maximum of N proposals per day per source tag, using a
 * BEGIN IMMEDIATE transaction with COUNT + conditional INSERT pattern.
 *
 * Design rationale (T1008 §3.2):
 * - In-process counters do not survive daemon restart, and two daemon
 *   instances could both allow N/day if enforcement is not in the DB.
 * - The `sentient.lock` advisory lock (daemon.ts) prevents two daemons
 *   from running concurrently, but the transactional count check provides
 *   belt-and-suspenders protection against TOCTOU races.
 * - SQLite partial unique indexes cannot enforce count > 1, so the
 *   BEGIN IMMEDIATE + COUNT + INSERT pattern is used instead.
 *
 * The "day" boundary is determined by SQLite's `date('now')` (UTC).
 * Proposals counted include ALL non-terminal statuses (proposed, pending,
 * active, done) — an accepted proposal still consumes a daily slot.
 *
 * @task T1008
 * @see ADR-054 — Sentient Loop Tier-2
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The meta proposedBy tag written to `tasks.metadata_json` by the Tier-2
 * proposer. This tag is the query key for rate-limit counting.
 */
export const SENTIENT_TIER2_TAG = 'sentient-tier2' as const;

/**
 * Default maximum number of Tier-2 proposals per UTC day.
 * Can be overridden by callers.
 */
export const DEFAULT_DAILY_PROPOSAL_LIMIT = 3;

/**
 * SQL error code string returned when BEGIN IMMEDIATE fails because another
 * write transaction is in progress.
 */
const SQLITE_BUSY_CODE = 'SQLITE_BUSY';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count the number of Tier-2 proposals created today (UTC).
 *
 * Counts tasks where:
 *   - `labels_json` contains `'sentient-tier2'` (the Tier-2 marker label)
 *   - `date(created_at) = date('now')`
 *   - `status IN ('proposed', 'pending', 'active', 'done')` — terminal
 *     states that were proposed today still count toward the daily cap so
 *     that accepted proposals don't free a slot for another proposal.
 *
 * The `LIKE` pattern is intentional: labels_json is a JSON array stored as
 * text, and `'sentient-tier2'` is always a complete JSON string value within
 * that array, making substring matching safe here.
 *
 * @param nativeDb - Open DatabaseSync handle to tasks.db.
 * @returns Number of proposals created today. Returns 0 if DB is null.
 */
export function countTodayProposals(nativeDb: DatabaseSync | null): number {
  if (!nativeDb) return 0;

  const stmt = nativeDb.prepare(`
    SELECT COUNT(*) as cnt
    FROM tasks
    WHERE labels_json LIKE :labelPattern
      AND date(created_at) = date('now')
      AND status IN ('proposed', 'pending', 'active', 'done')
  `);

  const row = stmt.get({ labelPattern: `%${SENTIENT_TIER2_TAG}%` }) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Check whether the daily rate limit has been reached.
 *
 * @param nativeDb - Open DatabaseSync handle to tasks.db.
 * @param limit - Daily cap (defaults to {@link DEFAULT_DAILY_PROPOSAL_LIMIT}).
 * @returns `true` if the limit is reached or exceeded; `false` if capacity remains.
 */
export function isRateLimitExceeded(
  nativeDb: DatabaseSync | null,
  limit = DEFAULT_DAILY_PROPOSAL_LIMIT,
): boolean {
  return countTodayProposals(nativeDb) >= limit;
}

// ---------------------------------------------------------------------------
// Transactional INSERT guard
// ---------------------------------------------------------------------------

/** Result of a transactional insert attempt. */
export interface TransactionalInsertResult {
  /** Whether the INSERT was committed. */
  inserted: boolean;
  /**
   * The count read at the start of the transaction. Used for diagnostics
   * and tests — lets callers verify the guard saw the expected count.
   */
  countBeforeInsert: number;
  /**
   * If `inserted = false` and this is set, the limit was the reason.
   */
  reason?: 'rate-limit' | 'busy';
}

/**
 * Attempt to insert a pre-built task row inside a BEGIN IMMEDIATE transaction
 * with a count check.
 *
 * Steps:
 *   1. BEGIN IMMEDIATE (exclusive write lock on tasks.db)
 *   2. COUNT proposals created today
 *   3. If count >= limit: ROLLBACK, return `{ inserted: false, reason: 'rate-limit' }`
 *   4. Otherwise: INSERT the row, COMMIT, return `{ inserted: true }`
 *
 * On SQLITE_BUSY: ROLLBACK + return `{ inserted: false, reason: 'busy' }`.
 *
 * @param nativeDb - Open DatabaseSync handle to tasks.db.
 * @param insertSql - Parameterized INSERT SQL string.
 * @param insertParams - Named parameters for the INSERT statement.
 * @param limit - Daily cap.
 * @returns Insert result.
 */
export function transactionalInsertProposal(
  nativeDb: DatabaseSync,
  insertSql: string,
  insertParams: Record<string, SQLInputValue>,
  limit = DEFAULT_DAILY_PROPOSAL_LIMIT,
): TransactionalInsertResult {
  try {
    nativeDb.exec('BEGIN IMMEDIATE');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(SQLITE_BUSY_CODE)) {
      return { inserted: false, countBeforeInsert: 0, reason: 'busy' };
    }
    throw err;
  }

  try {
    const countBeforeInsert = countTodayProposals(nativeDb);

    if (countBeforeInsert >= limit) {
      nativeDb.exec('ROLLBACK');
      return { inserted: false, countBeforeInsert, reason: 'rate-limit' };
    }

    const stmt = nativeDb.prepare(insertSql);
    stmt.run(insertParams);

    nativeDb.exec('COMMIT');
    return { inserted: true, countBeforeInsert };
  } catch (err) {
    try {
      nativeDb.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}
