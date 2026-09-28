/**
 * Token bucket (memory + cross-process file form) and the LRU decision cache.
 *
 * @task T12490
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionOutcome, DecisionRequest } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileTokenBucket, createMemoryTokenBucket } from '../budget.js';
import { createDecisionCache, decisionCacheKey } from '../cache.js';

describe('memory token bucket', () => {
  it('grants up to capacity, refills over time, and never admits more than 600 per minute', async () => {
    let now = 0;
    const bucket = createMemoryTokenBucket({ now: () => now });
    let granted = 0;
    // Hammer the bucket every 10 ms for 3 minutes; count per 60-second window.
    const perWindow: number[] = [0, 0, 0];
    for (now = 0; now < 180_000; now += 10) {
      if ((await bucket.tryAcquire()).granted) {
        granted += 1;
        perWindow[Math.floor(now / 60_000)] = (perWindow[Math.floor(now / 60_000)] ?? 0) + 1;
      }
    }
    for (const count of perWindow) expect(count).toBeLessThanOrEqual(600);
    expect(granted).toBeGreaterThan(1500);
  });

  it('reports exhausted when empty and cooling_down after a penalty', async () => {
    let now = 0;
    const bucket = createMemoryTokenBucket({ capacity: 1, refillPerMinute: 60, now: () => now });
    expect(await bucket.tryAcquire()).toEqual({ granted: true });
    expect(await bucket.tryAcquire()).toEqual({ granted: false, reason: 'exhausted' });
    await bucket.penalize(5_000);
    now = 4_999;
    expect(await bucket.tryAcquire()).toEqual({ granted: false, reason: 'cooling_down' });
    now = 6_000;
    expect(await bucket.tryAcquire()).toEqual({ granted: true });
  });

  it('caps a penalty at 60 s, whatever the provider asked for', async () => {
    let now = 0;
    const bucket = createMemoryTokenBucket({ now: () => now });
    await bucket.penalize(999_999_999_000);
    now = 59_999;
    expect(await bucket.tryAcquire()).toEqual({ granted: false, reason: 'cooling_down' });
    now = 60_001;
    expect((await bucket.tryAcquire()).granted).toBe(true);
  });
});

describe('file token bucket', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-decide-budget-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('shares one budget between independent instances (processes)', async () => {
    const statePath = join(dir, 'decide', 'budget.json');
    const now = (): number => 1_000;
    const a = createFileTokenBucket({ statePath, capacity: 3, refillPerMinute: 0, now });
    const b = createFileTokenBucket({ statePath, capacity: 3, refillPerMinute: 0, now });
    const results = [
      await a.tryAcquire(),
      await b.tryAcquire(),
      await a.tryAcquire(),
      await b.tryAcquire(),
    ];
    expect(results.map((r) => r.granted)).toEqual([true, true, true, false]);
    await a.penalize(60_000);
    const c = createFileTokenBucket({
      statePath,
      capacity: 3,
      refillPerMinute: 600,
      now: () => 2_000,
    });
    expect(await c.tryAcquire()).toEqual({ granted: false, reason: 'cooling_down' });
  });

  it('clamps a persisted cool-down beyond the 60 s cap (written by an uncapped version)', async () => {
    const statePath = join(dir, 'budget.json');
    writeFileSync(
      statePath,
      JSON.stringify({ tokens: 5, updatedAt: 1_000, blockedUntil: 1_000 + 999_999_999_000 }),
    );
    const bucket = createFileTokenBucket({
      statePath,
      capacity: 5,
      refillPerMinute: 0,
      now: () => 1_000 + 60_001,
    });
    expect((await bucket.tryAcquire()).granted).toBe(true);
  });

  it('fails closed on a corrupt state file', async () => {
    const statePath = join(dir, 'budget.json');
    writeFileSync(statePath, '{not json');
    const bucket = createFileTokenBucket({ statePath, capacity: 5, refillPerMinute: 0 });
    expect(await bucket.tryAcquire()).toEqual({ granted: false, reason: 'exhausted' });
  });

  it('reports unavailable instead of throwing when the state path is unusable', async () => {
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    const bucket = createFileTokenBucket({ statePath: join(blocker, 'budget.json') });
    expect(await bucket.tryAcquire()).toEqual({ granted: false, reason: 'unavailable' });
    await expect(bucket.penalize(1)).resolves.toBeUndefined();
  });
});

describe('decision cache', () => {
  const outcome: DecisionOutcome = { answers: {}, source: 'provider', latencyMs: 1 };
  const req: DecisionRequest = {
    state: 's',
    questions: {
      a: { type: 'noul', criteria: 'x' },
      b: { type: 'score', criteria: ['lo', 'hi'] },
    },
  };

  it('keys are insensitive to object key order and sensitive to adapter version and state', () => {
    const reordered: DecisionRequest = {
      state: 's',
      questions: {
        b: { criteria: ['lo', 'hi'], type: 'score' },
        a: { criteria: 'x', type: 'noul' },
      },
    };
    expect(decisionCacheKey('v1', req)).toBe(decisionCacheKey('v1', reordered));
    expect(decisionCacheKey('v1', req)).not.toBe(decisionCacheKey('v2', req));
    expect(decisionCacheKey('v1', req)).not.toBe(decisionCacheKey('v1', { ...req, state: 't' }));
    expect(decisionCacheKey('v1', req)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('evicts the least-recently used entry', () => {
    const cache = createDecisionCache(2);
    cache.set('a', outcome);
    cache.set('b', outcome);
    expect(cache.get('a')).toBe(outcome); // a is now most recent
    cache.set('c', outcome);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(outcome);
    expect(cache.get('c')).toBe(outcome);
    expect(cache.size).toBe(2);
  });
});
