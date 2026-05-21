/**
 * Unit tests for the SQLITE_BUSY application-level retry primitive.
 *
 * Companion to {@link parallel-task-update.test.ts} which exercises the
 * helper against a real SQLite database. This file focuses on the
 * pure behaviour of {@link withWriteRetry} and the {@link isSqliteBusy}
 * predicate.
 *
 * @bug gh-391
 * @task T9839
 */

import { describe, expect, it, vi } from 'vitest';
import { isSqliteBusy, withWriteRetry } from '../with-retry.js';

describe('isSqliteBusy', () => {
  it('detects SQLITE_BUSY error message', () => {
    expect(isSqliteBusy(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
  });

  it('detects lowercase sqlite_busy', () => {
    expect(isSqliteBusy(new Error('sqlite_busy'))).toBe(true);
  });

  it('detects "database is locked" variant', () => {
    expect(isSqliteBusy(new Error('database is locked'))).toBe(true);
  });

  it('detects mixed-case SQLITE_BUSY embedded in larger message', () => {
    expect(isSqliteBusy(new Error('Error: SQLITE_BUSY - another process holds lock'))).toBe(true);
  });

  it('detects errors with .code = SQLITE_BUSY when message includes the literal', () => {
    // The current detector is message-based; this case documents the
    // contract that a properly-shaped engine error still matches.
    const err = new Error('SQLITE_BUSY: write blocked');
    (err as Error & { code?: string }).code = 'SQLITE_BUSY';
    expect(isSqliteBusy(err)).toBe(true);
  });

  it('rejects non-Error values', () => {
    expect(isSqliteBusy('SQLITE_BUSY')).toBe(false);
    expect(isSqliteBusy(null)).toBe(false);
    expect(isSqliteBusy(undefined)).toBe(false);
    expect(isSqliteBusy(42)).toBe(false);
    expect(isSqliteBusy({})).toBe(false);
  });

  it('rejects other SQLite errors', () => {
    expect(isSqliteBusy(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'))).toBe(false);
    expect(isSqliteBusy(new Error('SQLITE_ERROR: no such table'))).toBe(false);
    expect(isSqliteBusy(new Error('SQLITE_READONLY: attempt to write'))).toBe(false);
  });

  it('rejects generic errors', () => {
    expect(isSqliteBusy(new Error('something went wrong'))).toBe(false);
    expect(isSqliteBusy(new Error(''))).toBe(false);
  });
});

describe('withWriteRetry', () => {
  it('succeeds on attempt 1 if fn resolves immediately', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withWriteRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times after SQLITE_BUSY, then succeeds on 4th attempt', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 4) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return 'success';
    });
    const result = await withWriteRetry(fn, { baseDelayMs: 1, jitterMs: 0 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('throws E_WRITE_CONTENTION after exhausting attempts', async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    await expect(withWriteRetry(fn, { baseDelayMs: 1, jitterMs: 0 })).rejects.toMatchObject({
      code: 'E_WRITE_CONTENTION',
    });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('contention error preserves the last underlying error as .cause', async () => {
    const underlying = new Error('SQLITE_BUSY: still locked');
    const fn = vi.fn().mockImplementation(() => {
      throw underlying;
    });
    try {
      await withWriteRetry(fn, { baseDelayMs: 1, jitterMs: 0 });
      throw new Error('should have thrown');
    } catch (err) {
      const typed = err as Error & { code?: string; cause?: unknown };
      expect(typed.code).toBe('E_WRITE_CONTENTION');
      expect(typed.cause).toBe(underlying);
      expect(typed.message).toContain('after 4 attempts');
    }
  });

  it('propagates non-BUSY errors immediately without retry', async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed');
    });
    await expect(withWriteRetry(fn)).rejects.toThrow('SQLITE_CONSTRAINT');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a plain TypeError thrown by the callback', async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new TypeError('boom');
    });
    await expect(withWriteRetry(fn)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry callback with (attempt, delayMs, err)', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const fn = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls < 3) {
        throw new Error('SQLITE_BUSY: locked');
      }
      return 'done';
    });
    const result = await withWriteRetry(fn, { baseDelayMs: 1, jitterMs: 0, onRetry });
    expect(result).toBe('done');
    expect(onRetry).toHaveBeenCalledTimes(2);
    const [attempt1, delay1, err1] = onRetry.mock.calls[0] as [number, number, unknown];
    const [attempt2, delay2, err2] = onRetry.mock.calls[1] as [number, number, unknown];
    expect(attempt1).toBe(1);
    expect(attempt2).toBe(2);
    expect(delay1).toBeGreaterThanOrEqual(0);
    expect(delay2).toBeGreaterThanOrEqual(0);
    expect(err1).toBeInstanceOf(Error);
    expect(err2).toBeInstanceOf(Error);
  });

  it('backoff sequence respects baseDelayMs × 2^(attempt-1) within jitter bounds', async () => {
    const observed: number[] = [];
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('SQLITE_BUSY: locked');
    });
    try {
      await withWriteRetry(fn, {
        baseDelayMs: 100,
        jitterMs: 50,
        onRetry: (_attempt, delay) => observed.push(delay),
      });
    } catch {
      // expected E_WRITE_CONTENTION
    }
    // 4 attempts → 3 retries → 3 delays. Bases: 100, 200, 400. Jitter ±50.
    expect(observed).toHaveLength(3);
    expect(observed[0]).toBeGreaterThanOrEqual(50);
    expect(observed[0]).toBeLessThanOrEqual(150);
    expect(observed[1]).toBeGreaterThanOrEqual(150);
    expect(observed[1]).toBeLessThanOrEqual(250);
    expect(observed[2]).toBeGreaterThanOrEqual(350);
    expect(observed[2]).toBeLessThanOrEqual(450);
  });

  it('maxAttempts=1 disables retry entirely', async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('SQLITE_BUSY: locked');
    });
    await expect(withWriteRetry(fn, { maxAttempts: 1, baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'E_WRITE_CONTENTION',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('coerces maxAttempts < 1 to 1', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withWriteRetry(fn, { maxAttempts: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns synchronous results without unnecessary await', async () => {
    const fn = vi.fn().mockReturnValue(42);
    const result = await withWriteRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
