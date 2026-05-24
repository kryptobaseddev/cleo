/**
 * Runtime test for the `attachSuggestedNext` envelope helper
 * promoted in T9920 (Saga T9855 / E8.1).
 *
 * Type-shape assertions for `CliMeta.suggestedNext` itself live in
 * `packages/contracts/src/__tests__/cli-meta-suggested-next.test.ts` —
 * contracts cannot depend on core, so the two concerns are split.
 *
 * @epic T9919
 * @task T9920
 * @saga T9855
 */

import type { CliEnvelope } from '@cleocode/lafs';
import { describe, expect, it } from 'vitest';
import { attachSuggestedNext } from '../suggested-next.js';

function makeEnvelope<T>(data: T): CliEnvelope<T> {
  return {
    success: true,
    data,
    meta: {
      operation: 'tasks.show',
      requestId: '00000000-0000-0000-0000-000000000000',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
    },
  };
}

describe('attachSuggestedNext (T9920)', () => {
  it('produces a meta with a suggestedNext array', () => {
    const envelope = makeEnvelope({ taskId: 'T1234' });
    const enriched = attachSuggestedNext(envelope, [
      'cleo focus T1234',
      'cleo verify T1234 --gate implemented',
    ]);
    expect(enriched.meta.suggestedNext).toEqual([
      'cleo focus T1234',
      'cleo verify T1234 --gate implemented',
    ]);
  });

  it('does not mutate the input envelope', () => {
    const envelope = makeEnvelope({ taskId: 'T1234' });
    const before = envelope.meta.suggestedNext;
    attachSuggestedNext(envelope, ['cleo focus T1234']);
    expect(envelope.meta.suggestedNext).toBe(before);
    expect(envelope.meta.suggestedNext).toBeUndefined();
  });

  it('returns a fresh meta object (referential isolation)', () => {
    const envelope = makeEnvelope({ taskId: 'T1234' });
    const enriched = attachSuggestedNext(envelope, ['cleo focus T1234']);
    expect(enriched.meta).not.toBe(envelope.meta);
    expect(enriched).not.toBe(envelope);
  });

  it('preserves all other meta fields verbatim', () => {
    const envelope: CliEnvelope<{ taskId: string }> = {
      success: true,
      data: { taskId: 'T1234' },
      meta: {
        operation: 'tasks.show',
        requestId: '11111111-1111-1111-1111-111111111111',
        duration_ms: 42,
        timestamp: '2026-05-24T12:34:56.000Z',
        sessionId: 's-abc',
        _nexus: { canonicalCommand: 'cleo nexus query' },
        deprecated: { since: 'v1.0.0' },
      },
    };
    const enriched = attachSuggestedNext(envelope, ['cleo focus T1234']);
    expect(enriched.meta.operation).toBe('tasks.show');
    expect(enriched.meta.requestId).toBe('11111111-1111-1111-1111-111111111111');
    expect(enriched.meta.duration_ms).toBe(42);
    expect(enriched.meta.timestamp).toBe('2026-05-24T12:34:56.000Z');
    expect(enriched.meta.sessionId).toBe('s-abc');
    expect(enriched.meta['_nexus']).toEqual({ canonicalCommand: 'cleo nexus query' });
    expect(enriched.meta['deprecated']).toEqual({ since: 'v1.0.0' });
  });

  it('accepts an empty suggestions array and still produces a valid envelope', () => {
    const envelope = makeEnvelope({ taskId: 'T1234' });
    const enriched = attachSuggestedNext(envelope, []);
    expect(enriched.success).toBe(true);
    expect(enriched.data).toEqual({ taskId: 'T1234' });
    expect(enriched.meta.suggestedNext).toEqual([]);
    expect(Array.isArray(enriched.meta.suggestedNext)).toBe(true);
  });

  it('clones the suggestions array — caller mutation does not leak', () => {
    const envelope = makeEnvelope({ taskId: 'T1234' });
    const suggestions = ['cleo focus T1234'];
    const enriched = attachSuggestedNext(envelope, suggestions);
    suggestions.push('cleo verify T1234');
    expect(enriched.meta.suggestedNext).toEqual(['cleo focus T1234']);
  });

  it('overwrites prior meta.suggestedNext rather than appending', () => {
    const envelope: CliEnvelope<{ taskId: string }> = {
      success: true,
      data: { taskId: 'T1234' },
      meta: {
        operation: 'tasks.show',
        requestId: '00000000-0000-0000-0000-000000000000',
        duration_ms: 0,
        timestamp: '2026-05-24T00:00:00.000Z',
        suggestedNext: ['cleo show T1234'],
      },
    };
    const enriched = attachSuggestedNext(envelope, ['cleo focus T1234']);
    expect(enriched.meta.suggestedNext).toEqual(['cleo focus T1234']);
  });
});
