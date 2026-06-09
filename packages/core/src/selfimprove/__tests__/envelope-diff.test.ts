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

/**
 * A LIVE-shaped envelope as the real `Dispatcher` stamps it — carries the
 * per-run session-lineage UUIDs AND the deterministic-but-golden-absent infra
 * meta keys. This is the wiring-time shape the hand-trimmed mock omits; the
 * normalizer + subset compare MUST treat it as a non-regression vs the golden.
 *
 * @param taskId - The task id in the envelope body.
 * @param sid - The (per-run, non-deterministic) session-lineage UUID seed.
 */
function liveEnvelope(taskId: string, sid: string): DispatchResponse {
  return {
    meta: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'find',
      // Volatile timing/trace.
      timestamp: '2026-06-08T00:00:00.000Z',
      duration_ms: 42,
      requestId: `req-${sid}`,
      source: 'rpc',
      // Per-run session lineage (randomUUID() in the real Dispatcher).
      sessionId: `sess-${sid}`,
      originSessionId: `origin-${sid}`,
      executionSessionId: `exec-${sid}`,
      // Deterministic-but-golden-absent infra keys (createGatewayMeta / legacy).
      specVersion: '1.2.3',
      schemaVersion: '2026.2.1',
      transport: 'sdk',
      strict: true,
      mvi: 'minimal',
      contextVersion: 1,
      'x-cleo-transport': 'stdio',
    } as DispatchResponse['meta'],
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

  it('strips the per-run session-lineage UUIDs (sessionId/originSessionId/executionSessionId)', () => {
    const norm = normalizeEnvelope(liveEnvelope('T1', 'aaa'));
    const meta = norm.meta as Record<string, unknown>;
    expect(meta.sessionId).toBeUndefined();
    expect(meta.originSessionId).toBeUndefined();
    expect(meta.executionSessionId).toBeUndefined();
  });

  it('preserves deterministic infra meta keys (not stripped — tolerated by subset compare)', () => {
    const norm = normalizeEnvelope(liveEnvelope('T1', 'aaa'));
    const meta = norm.meta as Record<string, unknown>;
    // The strip set is exactly the volatile fields — nothing semantic/stable.
    expect(meta.specVersion).toBe('1.2.3');
    expect(meta.transport).toBe('sdk');
    expect(meta.gateway).toBe('query');
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

  it('treats a LIVE envelope (lineage UUIDs + infra meta) as NOT a regression', () => {
    // The real Dispatcher stamps non-deterministic *SessionId UUIDs and stable
    // infra meta keys the hand-authored golden never declares. Without the
    // lineage strip + subset meta compare this would be a permanent phantom DHQ.
    const result = diffEnvelopes(ops, [liveEnvelope('T1', 'run-1')], [goldenEntry('T1')]);
    expect(result.regressions).toEqual([]);
  });

  it('two live envelopes with DIFFERENT lineage UUIDs both match the golden', () => {
    const a = diffEnvelopes(ops, [liveEnvelope('T1', 'run-aaa')], [goldenEntry('T1')]);
    const b = diffEnvelopes(ops, [liveEnvelope('T1', 'run-zzz')], [goldenEntry('T1')]);
    expect(a.regressions).toEqual([]);
    expect(b.regressions).toEqual([]);
  });

  it('still flags a real meta divergence on a golden-DECLARED key', () => {
    // Subset compare ignores EXTRA actual keys, but a golden-declared key that
    // diverges IS a regression (the `source` here flips rpc → cli).
    const live = liveEnvelope('T1', 'run-1');
    (live.meta as Record<string, unknown>).source = 'cli';
    const result = diffEnvelopes(ops, [live], [goldenEntry('T1')]);
    expect(result.regressions.some((r) => r.path === 'meta/source')).toBe(true);
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

  it('a clean LIVE replay hashes to the green signature — no permanent phantom DHQ', () => {
    // Regression guard for the wiring-time false positive: a live envelope (per-run
    // UUIDs + infra meta) matching the golden body must hash identically to the
    // trimmed-mock green, NOT to a stable red.
    const liveGreen = diffEnvelopes(ops, [liveEnvelope('T1', 'run-1')], [goldenEntry('T1')]);
    const mockGreen = diffEnvelopes(ops, [replayed('T1')], [goldenEntry('T1')]);
    expect(computeQuestionHash(liveGreen)).toBe(computeQuestionHash(mockGreen));
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
