/**
 * Application-level retry helpers for SQLITE_BUSY contention.
 *
 * SQLite's engine-level `busy_timeout` pragma (set to 5000ms in
 * {@link applyPerfPragmas}) makes a single statement wait up to 5s for a
 * competing writer to release its lock. That alone is NOT enough for
 * highly-parallel CLI invocations of `cleo update <id> --add-labels ...`
 * (gh#391): up to ~50% of writes still fail with `SQLITE_BUSY: database
 * is locked` when ≥10 processes hammer the same database from one shell.
 *
 * This module adds a **second layer** above the pragma — an async retry
 * with capped exponential backoff and jitter that wraps the entire
 * outermost transactional block (BEGIN IMMEDIATE … COMMIT) so contention
 * is absorbed by re-issuing the whole transaction rather than retrying
 * individual statements inside an already-rolled-back transaction.
 *
 * **Layering contract**:
 *
 *  1. `busy_timeout=5000ms` (engine-level, in {@link applyPerfPragmas}) —
 *     handles the *common* case where a competing writer commits within
 *     5 seconds. The statement waits in-place; no application code runs.
 *  2. `withWriteRetry` (this module, app-level) — handles the *uncommon*
 *     case where the engine-level wait expires (or the writer holds a
 *     RESERVED lock during a long transaction). Retries the entire
 *     outermost transaction 4 times with 100/200/400/800ms (± 50ms
 *     jitter) backoff before throwing {@link E_WRITE_CONTENTION}.
 *
 * Total worst-case latency is therefore bounded by
 * `MAX_ATTEMPTS × busy_timeout + sum(backoffs)` ≈ `4 × 5000 + 1500` =
 * `~21.5s`. In practice the first retry usually succeeds because the
 * competing writer has committed by then.
 *
 * **Why a separate module from migration-manager.ts**: the migration
 * runner has its OWN retry loop (synchronous, uses `Atomics.wait`,
 * scoped to `migrate()` calls). This module is the canonical home for
 * the async, transaction-wrapping retry primitive used by routine
 * task-row mutations. `isSqliteBusy` is co-located here so all callers
 * import it from one place; `migration-manager.ts` re-exports for
 * backward compatibility.
 *
 * @bug gh-391 — parallel `cleo update --add-labels` lost ~50% of writes
 *   to SQLITE_BUSY before this primitive was introduced.
 * @task T9839 — SG-GH-TRIAGE-2026-05-21 saga member; see PR for evidence.
 *
 * @example
 * ```ts
 * import { withWriteRetry } from './with-retry.js';
 *
 * await withWriteRetry(async () => {
 *   nativeDb.prepare('BEGIN IMMEDIATE').run();
 *   try {
 *     await db.update(schema.tasks).set({ ... }).where(...).run();
 *     nativeDb.prepare('COMMIT').run();
 *   } catch (err) {
 *     nativeDb.prepare('ROLLBACK').run();
 *     throw err;
 *   }
 * });
 * ```
 */

/** Default number of attempts (1 initial + 3 retries = 4 total). */
const DEFAULT_MAX_ATTEMPTS = 4;

/** Default base delay in milliseconds for exponential backoff (100ms). */
const DEFAULT_BASE_DELAY_MS = 100;

/** Default uniform jitter window in milliseconds (± 50ms). */
const DEFAULT_JITTER_MS = 50;

/**
 * Check if an error indicates SQLite was BUSY (lock held by another
 * connection or process). Matches both `SQLITE_BUSY` literal error
 * codes and the `database is locked` message variant emitted by some
 * driver versions.
 *
 * Canonical home for the BUSY-detection predicate. `migration-manager.ts`
 * re-exports this symbol for backward compatibility with the existing
 * `import { isSqliteBusy } from '../sqlite.js'` chain.
 *
 * @param err - The thrown value to inspect. Non-Error values (string,
 *   null, undefined, number, object literal) always return false.
 * @returns `true` if the error message contains a SQLITE_BUSY indicator.
 *
 * @task T5185 — original implementation; relocated from migration-manager.ts.
 * @bug gh-391
 *
 * @example
 * ```ts
 * try {
 *   db.prepare('BEGIN IMMEDIATE').run();
 * } catch (err) {
 *   if (isSqliteBusy(err)) {
 *     // contention — caller decides whether to retry
 *   } else {
 *     throw err; // genuine failure
 *   }
 * }
 * ```
 */
export function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('sqlite_busy') || msg.includes('database is locked');
}

/**
 * Options for {@link withWriteRetry}.
 */
export interface WithWriteRetryOptions {
  /**
   * Maximum total attempts (including the first call). Default 4.
   * A value of 1 disables retry entirely; values <1 are coerced to 1.
   */
  maxAttempts?: number;
  /**
   * Base backoff delay in milliseconds. Each retry waits
   * `baseDelayMs × 2^(attempt-1)` ± jitter. Default 100.
   */
  baseDelayMs?: number;
  /**
   * Uniform jitter window in milliseconds applied symmetrically around
   * the computed delay (so actual delay ∈ [delay − jitterMs, delay + jitterMs]).
   * Capped so the delay never drops below 0. Default 50.
   */
  jitterMs?: number;
  /**
   * Optional callback invoked AFTER each failed attempt (before the
   * delay actually elapses). Lets callers instrument retry behaviour
   * for tests or telemetry.
   *
   * @param attempt - The 1-indexed attempt number that just failed.
   * @param delayMs - The computed delay (post-jitter) until the next attempt.
   * @param err - The SQLITE_BUSY error that triggered the retry.
   */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Wrap an async (or sync) write function in an application-level
 * SQLITE_BUSY retry loop with capped exponential backoff and jitter.
 *
 * Behaviour:
 *  - If `fn()` resolves normally, returns the result.
 *  - If `fn()` throws and `isSqliteBusy(err)` is true, sleeps for
 *    `baseDelayMs × 2^(attempt-1)` ± jitter and re-runs `fn()`. Repeats
 *    until success or `maxAttempts` exhausted.
 *  - If `fn()` throws a non-BUSY error, propagates IMMEDIATELY without retry.
 *  - When all attempts exhaust on BUSY, throws an Error with `.code =
 *    'E_WRITE_CONTENTION'` and a `.cause` set to the last BUSY error.
 *
 * **CRITICAL**: `fn` MUST own the outermost transaction boundary
 * (BEGIN IMMEDIATE/COMMIT or SAVEPOINT). better-sqlite3 / node:sqlite
 * throws if `BEGIN IMMEDIATE` is executed while a transaction is
 * already open, so nesting `withWriteRetry` calls is a bug. Wrap the
 * OUTERMOST boundary only.
 *
 * @param fn - The function to retry. May be sync or async.
 * @param opts - Optional override of attempt count, base delay, jitter,
 *   or instrumentation callback.
 * @returns The resolved value of `fn`.
 * @throws Error with `.code === 'E_WRITE_CONTENTION'` after exhausting retries.
 * @throws Original error (unwrapped) if it is NOT a SQLITE_BUSY error.
 *
 * @bug gh-391
 * @task T9839
 *
 * @example
 * ```ts
 * await withWriteRetry(() => {
 *   nativeDb.prepare('BEGIN IMMEDIATE').run();
 *   try {
 *     // ... writes ...
 *     nativeDb.prepare('COMMIT').run();
 *   } catch (e) {
 *     nativeDb.prepare('ROLLBACK').run();
 *     throw e;
 *   }
 * }, { maxAttempts: 4, baseDelayMs: 100 });
 * ```
 */
export async function withWriteRetry<T>(
  fn: () => T | Promise<T>,
  opts: WithWriteRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const onRetry = opts.onRetry;

  let lastBusyErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteBusy(err)) {
        // Non-BUSY error → propagate immediately, no retry.
        throw err;
      }
      lastBusyErr = err;
      if (attempt === maxAttempts) break;
      // Compute backoff: base × 2^(attempt-1) with symmetric jitter.
      const baseDelay = baseDelayMs * 2 ** (attempt - 1);
      const jitter = (Math.random() * 2 - 1) * jitterMs;
      const delayMs = Math.max(0, baseDelay + jitter);
      if (onRetry) onRetry(attempt, delayMs, err);
      await sleep(delayMs);
    }
  }

  const contentionErr = new Error(
    `E_WRITE_CONTENTION: SQLITE_BUSY persisted after ${maxAttempts} attempts. ` +
      `Retry the operation after a brief delay. ` +
      `Underlying error: ${
        lastBusyErr instanceof Error ? lastBusyErr.message : String(lastBusyErr)
      }`,
  );
  (contentionErr as Error & { code?: string; cause?: unknown }).code = 'E_WRITE_CONTENTION';
  (contentionErr as Error & { code?: string; cause?: unknown }).cause = lastBusyErr;
  throw contentionErr;
}

/** Small promise-based sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
