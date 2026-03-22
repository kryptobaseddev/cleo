/**
 * Tests for the shared general-purpose retry utility.
 *
 * @module lib/__tests__/retry.test
 */

import { describe, expect, it, vi } from 'vitest';
import { computeDelay, withRetry } from '../retry.js';

// ============================================================================
// computeDelay
// ============================================================================

describe('computeDelay', () => {
  it('returns baseDelayMs on first retry attempt', () => {
    expect(computeDelay(1, 2_000, 30_000)).toBe(2_000);
  });

  it('doubles the delay on each subsequent attempt', () => {
    expect(computeDelay(2, 2_000, 30_000)).toBe(4_000);
    expect(computeDelay(3, 2_000, 30_000)).toBe(8_000);
    expect(computeDelay(4, 2_000, 30_000)).toBe(16_000);
  });

  it('caps delay at maxDelayMs', () => {
    expect(computeDelay(5, 2_000, 30_000)).toBe(30_000); // 32000 → capped
    expect(computeDelay(10, 2_000, 30_000)).toBe(30_000); // way over → capped
  });

  it('produces the task-spec schedule with defaults (0 ms / 2000 ms / 4000 ms)', () => {
    // Attempt 1 succeeds → no delay called.
    // Delay before attempt 2 = computeDelay(1, 2000, 30000) = 2000
    expect(computeDelay(1, 2_000, 30_000)).toBe(2_000);
    // Delay before attempt 3 = computeDelay(2, 2000, 30000) = 4000
    expect(computeDelay(2, 2_000, 30_000)).toBe(4_000);
  });

  it('handles baseDelayMs=0 gracefully', () => {
    expect(computeDelay(1, 0, 30_000)).toBe(0);
    expect(computeDelay(2, 0, 30_000)).toBe(0);
  });
});

// ============================================================================
// withRetry — success paths
// ============================================================================

describe('withRetry — success', () => {
  it('returns the value on first attempt', async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it('returns the value when fn succeeds after failures', async () => {
    vi.useFakeTimers();
    let calls = 0;

    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      { baseDelayMs: 100, maxDelayMs: 1_000 },
    );

    // Advance past both retry waits
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(calls).toBe(3);

    vi.useRealTimers();
  });
});

// ============================================================================
// withRetry — failure paths
// ============================================================================

describe('withRetry — failure', () => {
  it('throws after exhausting all attempts', async () => {
    vi.useFakeTimers();
    let calls = 0;

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection warnings.
    const promise = withRetry(
      async () => {
        calls++;
        throw new Error('always fails');
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    );
    const settled = promise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await vi.runAllTimersAsync();

    const result = await settled;
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: unknown }).error).toBeInstanceOf(Error);
    expect(calls).toBe(3);

    vi.useRealTimers();
  });

  it('attaches retry context to the thrown error', async () => {
    vi.useFakeTimers();

    // Attach rejection handler BEFORE advancing timers.
    const promise = withRetry(
      async () => {
        throw new Error('kaboom');
      },
      { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 500 },
    );
    const settled = promise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await vi.runAllTimersAsync();

    const result = await settled;
    expect(result.ok).toBe(false);
    const err = (result as { ok: false; error: unknown }).error as Error & {
      attempts?: number;
      totalDelayMs?: number;
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.attempts).toBe(2);
    expect(err.totalDelayMs).toBeGreaterThanOrEqual(0);

    vi.useRealTimers();
  });

  it('makes exactly 1 attempt when maxAttempts is 1', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('nope');
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });
});

// ============================================================================
// withRetry — retryableErrors filter
// ============================================================================

describe('withRetry — retryableErrors', () => {
  it('retries when error matches a RegExp', async () => {
    vi.useFakeTimers();
    let calls = 0;

    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNREFUSED connection failed');
        return 'connected';
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        retryableErrors: [/ECONNREFUSED/],
      },
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('connected');
    expect(calls).toBe(3);

    vi.useRealTimers();
  });

  it('does not retry when error does NOT match any pattern', async () => {
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('Permission denied');
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          retryableErrors: [/ECONNREFUSED/],
        },
      ),
    ).rejects.toThrow('Permission denied');

    expect(calls).toBe(1);
  });

  it('retries when error matches a predicate function', async () => {
    vi.useFakeTimers();
    let calls = 0;

    const isRateLimit = (err: unknown) =>
      err instanceof Error && err.message.includes('rate limit');

    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('rate limit exceeded');
        return 'done';
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        retryableErrors: [isRateLimit],
      },
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('done');
    expect(calls).toBe(2);

    vi.useRealTimers();
  });

  it('retries when any predicate in the list matches', async () => {
    vi.useFakeTimers();
    let calls = 0;

    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('503 Service Unavailable');
        return 'up';
      },
      {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        retryableErrors: [/ECONNREFUSED/, /503/],
      },
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('up');
    expect(calls).toBe(2);

    vi.useRealTimers();
  });

  it('treats all errors as retryable when retryableErrors is omitted', async () => {
    vi.useFakeTimers();
    let calls = 0;

    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('whatever obscure error');
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(calls).toBe(2);

    vi.useRealTimers();
  });
});

// ============================================================================
// withRetry — default schedule (0 ms / 2000 ms / 4000 ms)
// ============================================================================

describe('withRetry — default schedule', () => {
  it('uses the task-spec defaults: 3 attempts, 2000/4000 ms delays', async () => {
    // Verify delay schedule using computeDelay directly — no timer mocking needed.
    // Attempt 1 fails → wait computeDelay(1, 2000, 30000) = 2000 ms
    expect(computeDelay(1, 2_000, 30_000)).toBe(2_000);
    // Attempt 2 fails → wait computeDelay(2, 2000, 30000) = 4000 ms
    expect(computeDelay(2, 2_000, 30_000)).toBe(4_000);

    // Verify that withRetry makes exactly 3 attempts with default options.
    vi.useFakeTimers();
    let calls = 0;

    // Attach rejection handler before timer advancement.
    const promise = withRetry(async () => {
      calls++;
      throw new Error('fail');
    });
    const settled = promise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result.ok).toBe(false);
    expect(calls).toBe(3);

    vi.useRealTimers();
  });
});
