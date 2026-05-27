/**
 * Tests for retry logic, exponential backoff, and self-healing recovery.
 *
 * @module agents/__tests__/retry.test
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAgent, updateAgentStatus } from '../registry.js';
import {
  calculateDelay,
  createRetryPolicy,
  DEFAULT_RETRY_POLICY,
  recoverCrashedAgents,
  shouldRetry,
  withRetry,
} from '../retry.js';

// ==========================================================================
// Retry Policy
// ==========================================================================

describe('Retry Policy', () => {
  describe('createRetryPolicy', () => {
    it('returns default policy when no overrides', () => {
      const policy = createRetryPolicy();
      expect(policy.maxRetries).toBe(3);
      expect(policy.baseDelayMs).toBe(1_000);
      expect(policy.maxDelayMs).toBe(30_000);
      expect(policy.backoffMultiplier).toBe(2);
      expect(policy.jitter).toBe(true);
      expect(policy.retryOnUnknown).toBe(true);
    });

    it('merges partial overrides with defaults', () => {
      const policy = createRetryPolicy({ maxRetries: 5, baseDelayMs: 500 });
      expect(policy.maxRetries).toBe(5);
      expect(policy.baseDelayMs).toBe(500);
      expect(policy.maxDelayMs).toBe(30_000); // unchanged default
    });

    it('DEFAULT_RETRY_POLICY is frozen', () => {
      expect(Object.isFrozen(DEFAULT_RETRY_POLICY)).toBe(true);
    });
  });

  describe('calculateDelay', () => {
    it('applies exponential backoff', () => {
      const policy = createRetryPolicy({ jitter: false, baseDelayMs: 100, backoffMultiplier: 2 });

      expect(calculateDelay(0, policy)).toBe(100); // 100 * 2^0
      expect(calculateDelay(1, policy)).toBe(200); // 100 * 2^1
      expect(calculateDelay(2, policy)).toBe(400); // 100 * 2^2
      expect(calculateDelay(3, policy)).toBe(800); // 100 * 2^3
    });

    it('caps at maxDelay', () => {
      const policy = createRetryPolicy({
        jitter: false,
        baseDelayMs: 100,
        maxDelayMs: 500,
        backoffMultiplier: 10,
      });

      expect(calculateDelay(0, policy)).toBe(100);
      expect(calculateDelay(1, policy)).toBe(500); // capped
      expect(calculateDelay(2, policy)).toBe(500); // capped
    });

    it('adds jitter when enabled', () => {
      const policy = createRetryPolicy({
        jitter: true,
        baseDelayMs: 1000,
        backoffMultiplier: 1,
      });

      // With jitter, delay should be >= base but <= base * 1.25
      const delays = Array.from({ length: 20 }, () => calculateDelay(0, policy));
      const allInRange = delays.every((d) => d >= 1000 && d <= 1250);
      expect(allInRange).toBe(true);

      // With 20 samples, at least some should differ (jitter is random)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });
  });

  describe('shouldRetry', () => {
    it('allows retry for retriable errors within limit', () => {
      const policy = createRetryPolicy({ maxRetries: 3 });
      expect(shouldRetry(new Error('ECONNREFUSED'), 0, policy)).toBe(true);
      expect(shouldRetry(new Error('timeout'), 1, policy)).toBe(true);
      expect(shouldRetry(new Error('503 Service Unavailable'), 2, policy)).toBe(true);
    });

    it('denies retry when attempt exceeds maxRetries', () => {
      const policy = createRetryPolicy({ maxRetries: 3 });
      expect(shouldRetry(new Error('ECONNREFUSED'), 3, policy)).toBe(false);
      expect(shouldRetry(new Error('ECONNREFUSED'), 4, policy)).toBe(false);
    });

    it('denies retry for permanent errors', () => {
      const policy = createRetryPolicy({ maxRetries: 10 });
      expect(shouldRetry(new Error('Permission denied'), 0, policy)).toBe(false);
      expect(shouldRetry(new Error('401 Unauthorized'), 0, policy)).toBe(false);
    });

    it('respects retryOnUnknown policy', () => {
      const retryUnknown = createRetryPolicy({ retryOnUnknown: true });
      const noRetryUnknown = createRetryPolicy({ retryOnUnknown: false });

      const unknownError = new Error('Something weird');
      expect(shouldRetry(unknownError, 0, retryUnknown)).toBe(true);
      expect(shouldRetry(unknownError, 0, noRetryUnknown)).toBe(false);
    });
  });
});

// ==========================================================================
// withRetry wrapper
// ==========================================================================

describe('withRetry', () => {
  it('succeeds on first attempt', async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      return 'success';
    });

    expect(result.success).toBe(true);
    expect(result.value).toBe('success');
    expect(result.attempts).toBe(1);
    expect(callCount).toBe(1);
  });

  it('retries on retriable error and eventually succeeds', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        if (callCount < 3) throw new Error('ECONNREFUSED');
        return 'recovered';
      },
      { baseDelayMs: 1, maxDelayMs: 5, jitter: false },
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe('recovered');
    expect(result.attempts).toBe(3);
    expect(callCount).toBe(3);
  });

  it('fails immediately on permanent error', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        throw new Error('Permission denied');
      },
      { baseDelayMs: 1, jitter: false },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Permission denied');
    expect(result.attempts).toBe(1);
    expect(callCount).toBe(1);
  });

  it('exhausts retries and fails', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        throw new Error('ECONNREFUSED');
      },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitter: false },
    );

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(callCount).toBe(3);
  });

  it('tracks total delay time', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        if (callCount <= 2) throw new Error('timeout');
        return 'ok';
      },
      { baseDelayMs: 10, backoffMultiplier: 1, jitter: false },
    );

    expect(result.success).toBe(true);
    expect(result.totalDelayMs).toBeGreaterThanOrEqual(20); // 10 + 10
  });

  it('uses custom retry policy', async () => {
    let callCount = 0;
    const result = await withRetry(
      async () => {
        callCount++;
        throw new Error('rate limit');
      },
      { maxRetries: 1, baseDelayMs: 1, jitter: false },
    );

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2); // 1 initial + 1 retry
    expect(callCount).toBe(2);
  });
});

// ==========================================================================
// Self-Healing Recovery
// ==========================================================================

describe('recoverCrashedAgents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-recover-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('recovers crashed agents with retriable errors', async () => {
    const agent = await registerAgent({ agentType: 'executor' }, tempDir);
    await updateAgentStatus(agent.id, { status: 'crashed', error: 'ECONNREFUSED' }, tempDir);

    const results = await recoverCrashedAgents(30_000, tempDir);

    expect(results.length).toBe(1);
    expect(results[0]!.recovered).toBe(true);
    expect(results[0]!.action).toBe('restarted');
  });

  it('abandons agents with permanent errors', async () => {
    const agent = await registerAgent({ agentType: 'executor' }, tempDir);
    await updateAgentStatus(agent.id, { status: 'crashed', error: 'Permission denied' }, tempDir);

    const results = await recoverCrashedAgents(30_000, tempDir);

    expect(results.length).toBe(1);
    expect(results[0]!.recovered).toBe(false);
    expect(results[0]!.action).toBe('abandoned');
  });

  it('abandons agents exceeding error threshold', async () => {
    const agent = await registerAgent({ agentType: 'executor' }, tempDir);

    // Simulate 5+ errors
    for (let i = 0; i < 5; i++) {
      await updateAgentStatus(agent.id, { status: 'error', error: `Error ${i}` }, tempDir);
    }
    await updateAgentStatus(agent.id, { status: 'crashed' }, tempDir);

    const results = await recoverCrashedAgents(30_000, tempDir);

    expect(results.length).toBe(1);
    expect(results[0]!.recovered).toBe(false);
    expect(results[0]!.action).toBe('abandoned');
    expect(results[0]!.reason).toContain('exceeds threshold');
  });

  it('returns empty results when no crashed agents', async () => {
    await registerAgent({ agentType: 'executor' }, tempDir);

    const results = await recoverCrashedAgents(60_000, tempDir);
    expect(results.length).toBe(0);
  });
});
