/**
 * Tests for the WarningCollector + AsyncLocalStorage carrier (T9768 / T9763 W0).
 *
 * Covers:
 *   - push / drain basics
 *   - drain returns `undefined` when no warnings pushed
 *   - pushIfMissing deduplicates by code, leaves push untouched
 *   - withWarningCollector binds via AsyncLocalStorage
 *   - pushWarning no-ops outside a withWarningCollector scope
 *   - Concurrent withWarningCollector contexts remain isolated
 *
 * @epic T9763
 * @task T9768
 */

import { describe, expect, it } from 'vitest';
import {
  getCurrentWarningCollector,
  pushWarning,
  WarningCollector,
  withWarningCollector,
} from '../envelope.js';
import type { Warning } from '../types.js';

describe('WarningCollector', () => {
  it('push appends warnings in insertion order', () => {
    const collector = new WarningCollector();
    const a: Warning = { code: 'W_FIRST', message: 'first' };
    const b: Warning = { code: 'W_SECOND', message: 'second' };

    collector.push(a);
    collector.push(b);

    expect(collector.size()).toBe(2);
    expect(collector.drain()).toEqual([a, b]);
  });

  it('drain returns undefined when no warnings have been pushed', () => {
    const collector = new WarningCollector();
    expect(collector.size()).toBe(0);
    expect(collector.drain()).toBeUndefined();
  });

  it('drain returns a fresh snapshot — mutating the returned array does not affect the collector', () => {
    const collector = new WarningCollector();
    collector.push({ code: 'W_X', message: 'x' });

    const snapshot = collector.drain();
    expect(snapshot).toBeDefined();
    snapshot?.push({ code: 'W_Y', message: 'y' });

    expect(collector.size()).toBe(1);
  });

  it('drain is idempotent — calling twice returns the same warnings', () => {
    const collector = new WarningCollector();
    collector.push({ code: 'W_KEEP', message: 'keep' });

    const first = collector.drain();
    const second = collector.drain();

    expect(first).toEqual(second);
    expect(collector.size()).toBe(1);
  });

  it('pushIfMissing adds the first time and deduplicates by code thereafter', () => {
    const collector = new WarningCollector();
    let factoryCalls = 0;
    const factory = (): Warning => {
      factoryCalls++;
      return { code: 'W_DEDUP', message: `call ${factoryCalls}` };
    };

    expect(collector.pushIfMissing('W_DEDUP', factory)).toBe(true);
    expect(collector.pushIfMissing('W_DEDUP', factory)).toBe(false);
    expect(collector.pushIfMissing('W_DEDUP', factory)).toBe(false);

    expect(factoryCalls).toBe(1);
    expect(collector.drain()).toEqual([{ code: 'W_DEDUP', message: 'call 1' }]);
  });

  it('pushIfMissing dedup state is independent of push', () => {
    // push() does not consume a "seen" slot — pushIfMissing with the same code
    // should still fire once after a regular push.
    const collector = new WarningCollector();
    collector.push({ code: 'W_SHARED', message: 'from push' });

    const fired = collector.pushIfMissing('W_SHARED', () => ({
      code: 'W_SHARED',
      message: 'from pushIfMissing',
    }));

    expect(fired).toBe(true);
    expect(collector.drain()).toEqual([
      { code: 'W_SHARED', message: 'from push' },
      { code: 'W_SHARED', message: 'from pushIfMissing' },
    ]);
  });
});

describe('pushWarning (ALS carrier)', () => {
  it('pushWarning routes to the active collector', () => {
    const collector = new WarningCollector();
    withWarningCollector(collector, () => {
      pushWarning({ code: 'W_INSIDE', message: 'inside scope' });
    });

    expect(collector.drain()).toEqual([{ code: 'W_INSIDE', message: 'inside scope' }]);
  });

  it('pushWarning is a silent no-op outside any withWarningCollector scope', () => {
    // Sanity: no ALS context bound, no collector available.
    expect(getCurrentWarningCollector()).toBeUndefined();
    // Should not throw, should not record anywhere observable.
    expect(() => pushWarning({ code: 'W_LOST', message: 'no scope' })).not.toThrow();
  });

  it('getCurrentWarningCollector returns the active collector inside scope', () => {
    const collector = new WarningCollector();
    let observed: WarningCollector | undefined;
    withWarningCollector(collector, () => {
      observed = getCurrentWarningCollector();
    });
    expect(observed).toBe(collector);
    // And is unbound again afterwards.
    expect(getCurrentWarningCollector()).toBeUndefined();
  });

  it('async work inside withWarningCollector continues to see the collector', async () => {
    const collector = new WarningCollector();
    await withWarningCollector(collector, async () => {
      // Defer past a microtask boundary to make sure ALS survives `await`.
      await Promise.resolve();
      pushWarning({ code: 'W_ASYNC', message: 'after await' });
    });

    expect(collector.drain()).toEqual([{ code: 'W_ASYNC', message: 'after await' }]);
  });

  it('concurrent withWarningCollector scopes remain isolated', async () => {
    const collectorA = new WarningCollector();
    const collectorB = new WarningCollector();

    async function workA(): Promise<void> {
      await withWarningCollector(collectorA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pushWarning({ code: 'W_A', message: 'from A' });
      });
    }

    async function workB(): Promise<void> {
      await withWarningCollector(collectorB, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        pushWarning({ code: 'W_B', message: 'from B' });
      });
    }

    await Promise.all([workA(), workB()]);

    expect(collectorA.drain()).toEqual([{ code: 'W_A', message: 'from A' }]);
    expect(collectorB.drain()).toEqual([{ code: 'W_B', message: 'from B' }]);
  });

  it('warnings carry severity and context when supplied', () => {
    const collector = new WarningCollector();
    withWarningCollector(collector, () => {
      pushWarning({
        code: 'W_BRIDGE_WRITE_FAILED',
        message: 'memory bridge unavailable',
        severity: 'warn',
        context: { file: 'memory-bridge.md', retry: 2 },
      });
    });

    expect(collector.drain()).toEqual([
      {
        code: 'W_BRIDGE_WRITE_FAILED',
        message: 'memory bridge unavailable',
        severity: 'warn',
        context: { file: 'memory-bridge.md', retry: 2 },
      },
    ]);
  });
});
