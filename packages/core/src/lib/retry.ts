/**
 * General-purpose retry utility with exponential backoff.
 *
 * This module provides a shared, dependency-free retry primitive for use
 * anywhere in the CLEO core. Unlike the agent-specific retry in
 * `agents/retry.ts`, this utility has no database coupling and is safe to
 * import from any layer.
 *
 * Default schedule (3 attempts, task T040 spec):
 * - Attempt 1: immediate (0 ms delay before retry)
 * - Attempt 2: 2 000 ms delay before retry
 * - Attempt 3: 4 000 ms delay before retry
 * - After attempt 3: throw last error
 *
 * @module lib/retry
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A predicate or pattern used to decide whether an error is retryable.
 *
 * - `RegExp` — matched against `error.message` (or `String(error)`)
 * - `(error: unknown) => boolean` — arbitrary predicate function
 */
export type RetryablePredicate = RegExp | ((error: unknown) => boolean);

/**
 * Options that control retry behavior for {@link withRetry}.
 */
export interface RetryOptions {
  /**
   * Maximum total number of attempts (initial + retries).
   *
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Delay before the second attempt in milliseconds.
   * Each subsequent delay is `baseDelayMs * 2^(attempt - 1)`.
   *
   * @default 2000
   */
  baseDelayMs?: number;

  /**
   * Upper bound on computed delay in milliseconds.
   * Prevents unbounded growth with many retries.
   *
   * @default 30000
   */
  maxDelayMs?: number;

  /**
   * Explicit list of patterns or predicates that identify retryable errors.
   *
   * When provided, ONLY errors matching at least one entry are retried.
   * Errors that match none of the entries cause immediate failure.
   *
   * When omitted, all errors are treated as retryable (up to `maxAttempts`).
   */
  retryableErrors?: ReadonlyArray<RetryablePredicate>;
}

/**
 * Metadata attached to errors thrown after all retry attempts are exhausted.
 *
 * The last error from the final attempt is augmented with these fields so
 * callers can distinguish a retry-exhausted failure from a first-attempt one.
 */
export interface RetryContext {
  /** Total number of attempts made (always equal to `maxAttempts`). */
  attempts: number;
  /** Cumulative delay applied across all retry waits in milliseconds. */
  totalDelayMs: number;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Execute an async function with automatic retry and exponential backoff.
 *
 * @remarks
 * The function is called up to `maxAttempts` times. After the first failure,
 * the utility waits `baseDelayMs` milliseconds, then retries. Each subsequent
 * wait doubles: `baseDelayMs * 2^(attempt - 1)`, capped at `maxDelayMs`.
 *
 * If `retryableErrors` is supplied, only errors matching at least one entry
 * are retried; other errors cause immediate re-throw.
 *
 * On final failure the original error is re-thrown. Use {@link RetryContext}
 * fields (attached to the error) to inspect retry metadata.
 *
 * @example
 * ```ts
 * // Basic usage — 3 attempts with 0 ms / 2 000 ms / 4 000 ms delays
 * const data = await withRetry(() => fetchFromApi());
 *
 * // Custom retry window — only on network errors
 * const result = await withRetry(
 *   () => db.query(sql),
 *   {
 *     maxAttempts: 5,
 *     baseDelayMs: 500,
 *     retryableErrors: [/SQLITE_BUSY/, /database is locked/i],
 *   },
 * );
 * ```
 *
 * @typeParam T - The resolved type of the async function
 * @param fn - Async factory that is called on each attempt.
 * @param options - Optional retry configuration.
 * @returns Resolved value of `fn` on success.
 * @throws The last error thrown by `fn`, augmented with {@link RetryContext}
 *   fields (`attempts`, `totalDelayMs`).
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 2_000;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const retryableErrors = options?.retryableErrors;

  let lastError: unknown;
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt) break;

      // If a filter list is provided, only retry matching errors.
      if (retryableErrors !== undefined && !isRetryable(err, retryableErrors)) break;

      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs);
      totalDelayMs += delay;
      await sleep(delay);
    }
  }

  // Augment last error with retry context before re-throwing.
  const context: RetryContext = { attempts: maxAttempts, totalDelayMs };
  augmentError(lastError, context);
  throw lastError;
}

// ============================================================================
// Delay helpers (exported for unit testing)
// ============================================================================

/**
 * Compute the wait time before the next attempt.
 *
 * @remarks
 * Formula: `min(baseDelayMs * 2^(attempt - 1), maxDelayMs)`.
 * On the first retry (`attempt === 1`) the delay is `baseDelayMs * 1 = baseDelayMs`.
 *
 * @example
 * ```ts
 * computeDelay(1, 2000, 30000); // 2000
 * computeDelay(2, 2000, 30000); // 4000
 * computeDelay(3, 2000, 30000); // 8000
 * ```
 *
 * @param attempt - The 1-based attempt number that just failed.
 * @param baseDelayMs - Base delay in milliseconds.
 * @param maxDelayMs - Maximum allowed delay in milliseconds.
 * @returns Delay in milliseconds before the next attempt.
 */
export function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, maxDelayMs);
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Test whether an error matches at least one retryable predicate.
 *
 * @param err - The caught error.
 * @param predicates - List of `RegExp` or predicate functions.
 * @returns `true` if the error is retryable.
 */
function isRetryable(err: unknown, predicates: ReadonlyArray<RetryablePredicate>): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return predicates.some((predicate) => {
    if (predicate instanceof RegExp) return predicate.test(message);
    return predicate(err);
  });
}

/**
 * Attach `RetryContext` fields to an error value in-place when possible.
 * Falls back gracefully for non-Error thrown values.
 *
 * @param err - The value to augment.
 * @param context - Retry metadata to attach.
 */
function augmentError(err: unknown, context: RetryContext): void {
  if (err instanceof Error) {
    const mutableErr = err as Error & Partial<RetryContext>;
    mutableErr.attempts = context.attempts;
    mutableErr.totalDelayMs = context.totalDelayMs;
  }
}

/**
 * Promisified `setTimeout` for testability.
 *
 * @param ms - Duration in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
