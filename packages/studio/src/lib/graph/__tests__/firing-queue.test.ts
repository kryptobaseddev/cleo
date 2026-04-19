/**
 * Unit tests for the synapse firing queue.
 *
 * Covers enqueue + tick + expiry + clear paths. A deterministic clock
 * is injected via the `nowMs` argument.
 *
 * @task T990
 * @wave 1A
 */

import { describe, expect, it } from 'vitest';
import { createFiringQueue, FiringQueue } from '../firing-queue.js';
import { FIRE_DURATION_MS } from '../types.js';

describe('FiringQueue', () => {
  it('is empty on construction', () => {
    const q = new FiringQueue();
    expect(q.size).toBe(0);
    expect(q.tick(0)).toEqual([]);
  });

  it('createFiringQueue returns a working queue with default duration', () => {
    const q = createFiringQueue();
    expect(q.duration).toBe(FIRE_DURATION_MS);
  });

  it('interpolates t from 0 → 1 over the configured duration', () => {
    const q = new FiringQueue(1000);
    const start = 1000;
    q.enqueue({ id: 'f1', edgeId: 'e1', intensity: 1, emittedAt: start });
    expect(q.size).toBe(1);

    const frameA = q.tick(start);
    expect(frameA).toHaveLength(1);
    expect(frameA[0].t).toBeCloseTo(0, 5);

    const frameB = q.tick(start + 500);
    expect(frameB).toHaveLength(1);
    expect(frameB[0].t).toBeCloseTo(0.5, 5);

    const frameC = q.tick(start + 999);
    expect(frameC).toHaveLength(1);
    expect(frameC[0].t).toBeCloseTo(0.999, 5);
  });

  it('drops entries once they exceed the duration', () => {
    const q = new FiringQueue(200);
    q.enqueue({ id: 'f', edgeId: 'e', intensity: 1, emittedAt: 0 });
    expect(q.tick(199)).toHaveLength(1);
    const expired = q.tick(200);
    expect(expired).toHaveLength(0);
    expect(q.size).toBe(0);
  });

  it('supports multiple overlapping fires on the same edge', () => {
    const q = new FiringQueue(1000);
    q.enqueue({ id: 'a', edgeId: 'e1', intensity: 0.5, emittedAt: 0 });
    q.enqueue({ id: 'b', edgeId: 'e1', intensity: 0.8, emittedAt: 400 });
    const frame = q.tick(600);
    expect(frame).toHaveLength(2);
    // First fire is at t=0.6; second is at t=0.2.
    const byId = new Map(frame.map((f) => [f.intensity, f.t]));
    expect(byId.get(0.5)).toBeCloseTo(0.6, 5);
    expect(byId.get(0.8)).toBeCloseTo(0.2, 5);
  });

  it('returns neutral white colour when no edge map supplied', () => {
    const q = new FiringQueue(1000);
    q.enqueue({ id: 'f', edgeId: 'e', intensity: 1, emittedAt: 0 });
    const frame = q.tick(100);
    expect(frame[0].colorRgb).toEqual([1, 1, 1]);
  });

  it('clear() drops every tracked fire immediately', () => {
    const q = new FiringQueue(1000);
    q.enqueue({ id: '1', edgeId: 'e', intensity: 1, emittedAt: 0 });
    q.enqueue({ id: '2', edgeId: 'e', intensity: 1, emittedAt: 0 });
    q.clear();
    expect(q.size).toBe(0);
    expect(q.tick(100)).toEqual([]);
  });

  it('keeps future-emitted events but does not render them yet', () => {
    const q = new FiringQueue(1000);
    q.enqueue({ id: 'future', edgeId: 'e', intensity: 1, emittedAt: 2000 });
    const frame = q.tick(100);
    expect(frame).toHaveLength(0);
    expect(q.size).toBe(1);
  });
});
