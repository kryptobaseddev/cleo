/**
 * Unit tests for envelope normalization + structural diff (T11889-B).
 *
 * PURE — no DB. Asserts volatile-meta stripping, zero regressions on a golden
 * match, N regressions on injected divergence, stable `question_hash`, and the
 * reused LAFS targeted-field extractor.
 *
 * @epic T11889
 * @task T11912
 */

import type { DispatchResponse } from '@cleocode/contracts/gateway';
import { describe, expect, it } from 'vitest';
import {
  computeQuestionHash,
  diffEnvelopes,
  extractTargetedField,
  normalizeEnvelope,
} from '../envelope-diff.js';
import type { GoldenEntry, ScenarioOp } from '../scenario.js';

const ops: ScenarioOp[] = [{ gateway: 'query', domain: 'tasks', operation: 'find' }];

/** A replayed envelope with volatile meta fields populated. */
function replayed(taskId: string): DispatchResponse {
  return {
    meta: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'find',
      timestamp: '2026-06-08T00:00:00.000Z',
      duration_ms: 42,
      source: 'rpc',
      requestId: 'req-abc',
    },
    success: true,
    data: { tasks: [{ id: taskId, title: 'T' }], count: 1 },
  };
}

/** The golden — already normalized (no volatile meta fields). */
function goldenEntry(taskId: string): GoldenEntry {
  return {
    success: true,
    meta: { gateway: 'query', domain: 'tasks', operation: 'find', source: 'rpc' },
    data: { tasks: [{ id: taskId, title: 'T' }], count: 1 },
  };
}

describe('normalizeEnvelope', () => {
  it('strips volatile meta fields (timestamp/requestId/duration_ms)', () => {
    const norm = normalizeEnvelope(replayed('T1'));
    const meta = norm.meta as Record<string, unknown>;
    expect(meta.timestamp).toBeUndefined();
    expect(meta.requestId).toBeUndefined();
    expect(meta.duration_ms).toBeUndefined();
    // Stable fields preserved.
    expect(meta.gateway).toBe('query');
    expect(meta.operation).toBe('find');
  });

  it('does not mutate the input envelope', () => {
    const env = replayed('T1');
    normalizeEnvelope(env);
    expect(env.meta.timestamp).toBe('2026-06-08T00:00:00.000Z');
    expect(env.meta.duration_ms).toBe(42);
  });
});

describe('diffEnvelopes', () => {
  it('reports ZERO regressions when the replay matches the golden', () => {
    const result = diffEnvelopes(ops, [replayed('T1')], [goldenEntry('T1')]);
    expect(result.regressions).toEqual([]);
  });

  it('ignores volatile meta divergence (normalization removes it)', () => {
    // Two replays differ ONLY in volatile fields; both match the same golden.
    const a = replayed('T1');
    const b = replayed('T1');
    b.meta.requestId = 'req-different';
    b.meta.duration_ms = 9999;
    expect(diffEnvelopes(ops, [a], [goldenEntry('T1')]).regressions).toEqual([]);
    expect(diffEnvelopes(ops, [b], [goldenEntry('T1')]).regressions).toEqual([]);
  });

  it('reports a regression on structural (data) divergence', () => {
    const result = diffEnvelopes(ops, [replayed('T2')], [goldenEntry('T1')]);
    expect(result.regressions.length).toBeGreaterThan(0);
    const r = result.regressions[0];
    expect(r?.opCoord).toBe('tasks.find');
    expect(r?.path).toContain('data/tasks/0/id');
    expect(r?.actual).toBe('T2');
    expect(r?.expected).toBe('T1');
  });

  it('reports a count mismatch when replay/golden lengths differ', () => {
    const result = diffEnvelopes(ops, [replayed('T1'), replayed('T1')], [goldenEntry('T1')]);
    expect(result.regressions.some((r) => r.path === 'envelopes/length')).toBe(true);
  });
});

describe('computeQuestionHash', () => {
  it('is stable for the same regression signature', () => {
    const r1 = diffEnvelopes(ops, [replayed('T2')], [goldenEntry('T1')]);
    const r2 = diffEnvelopes(ops, [replayed('T2')], [goldenEntry('T1')]);
    expect(computeQuestionHash(r1)).toBe(computeQuestionHash(r2));
    expect(computeQuestionHash(r1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores actual/expected VALUE noise — same paths ⇒ same hash', () => {
    // T2 vs T1 and T3 vs T1 diverge at the SAME path; signature (op+path) is identical.
    const r2 = diffEnvelopes(ops, [replayed('T2')], [goldenEntry('T1')]);
    const r3 = diffEnvelopes(ops, [replayed('T3')], [goldenEntry('T1')]);
    expect(computeQuestionHash(r2)).toBe(computeQuestionHash(r3));
  });

  it('differs for the no-regression (green) signature', () => {
    const green = diffEnvelopes(ops, [replayed('T1')], [goldenEntry('T1')]);
    const red = diffEnvelopes(ops, [replayed('T2')], [goldenEntry('T1')]);
    expect(computeQuestionHash(green)).not.toBe(computeQuestionHash(red));
  });
});

describe('extractTargetedField (reuses LAFS fieldExtraction)', () => {
  it('extracts a nested field from the normalized data payload', () => {
    const norm = normalizeEnvelope(replayed('T9'));
    // data.tasks[0].id — wrapper-array shape handled by the LAFS extractor.
    expect(extractTargetedField(norm, 'id')).toBe('T9');
    expect(extractTargetedField(norm, 'count')).toBe(1);
  });

  it('returns undefined for an absent field', () => {
    const norm = normalizeEnvelope(replayed('T9'));
    expect(extractTargetedField(norm, 'nonexistent')).toBeUndefined();
  });
});
