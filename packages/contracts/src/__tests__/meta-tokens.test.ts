/**
 * Type-shape contract test for the envelope-wide `meta.tokens` field
 * promoted in T9923 (Saga T9855 / E8.4).
 *
 * `CliMeta.tokens` is the first-class structured token-cost annotation
 * attached to every CLI envelope (formerly the underscore-prefixed
 * `meta._tokenEstimate`). The legacy field is retained for ONE release
 * (removeAt v2026.7.0) so existing consumers can migrate without a
 * flag-day.
 *
 * @epic T9919
 * @task T9923
 * @saga T9855
 */

import type { CliEnvelope, CliMeta, CliMetaTokens } from '@cleocode/lafs';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('CliMeta.tokens type shape (T9923)', () => {
  it('accepts the full first-class CliMetaTokens shape', () => {
    const meta: CliMeta = {
      operation: 'tasks.show',
      requestId: '00000000-0000-0000-0000-000000000000',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
      tokens: {
        estimate: 1234,
        model: 'cl100k',
        calculatedAt: '2026-05-24T00:00:00.000Z',
      },
    };
    expect(meta.tokens?.estimate).toBe(1234);
    expect(meta.tokens?.model).toBe('cl100k');
    expect(meta.tokens?.calculatedAt).toBe('2026-05-24T00:00:00.000Z');
  });

  it('requires `estimate` to be a number when `tokens` is present', () => {
    expectTypeOf<NonNullable<CliMeta['tokens']>['estimate']>().toEqualTypeOf<number>();
    expectTypeOf<NonNullable<CliMeta['tokens']>['model']>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<CliMeta['tokens']>['calculatedAt']>().toEqualTypeOf<string>();
  });

  it('is optional — omitting `tokens` leaves a valid CliMeta', () => {
    const meta: CliMeta = {
      operation: 'tasks.list',
      requestId: '00000000-0000-0000-0000-000000000001',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
    };
    expect(meta.tokens).toBeUndefined();
  });

  it('accepts the legacy `_tokenEstimate` field during the deprecation window', () => {
    const meta: CliMeta = {
      operation: 'tasks.show',
      requestId: '00000000-0000-0000-0000-000000000002',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
      _tokenEstimate: { estimate: 999 },
    };
    expect(meta._tokenEstimate?.estimate).toBe(999);
  });

  it('allows BOTH `tokens` and `_tokenEstimate` for backwards-compat dual-write', () => {
    const meta: CliMeta = {
      operation: 'tasks.show',
      requestId: '00000000-0000-0000-0000-000000000003',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
      tokens: {
        estimate: 4321,
        model: 'o200k',
        calculatedAt: '2026-05-24T00:00:00.000Z',
      },
      _tokenEstimate: { estimate: 4321 },
    };
    expect(meta.tokens?.estimate).toBe(meta._tokenEstimate?.estimate);
  });

  it('flows through CliEnvelope<T>.meta verbatim', () => {
    const envelope: CliEnvelope<{ taskId: string }> = {
      success: true,
      data: { taskId: 'T9923' },
      meta: {
        operation: 'tasks.show',
        requestId: '00000000-0000-0000-0000-000000000004',
        duration_ms: 1,
        timestamp: '2026-05-24T00:00:00.000Z',
        tokens: {
          estimate: 512,
          model: 'cl100k',
          calculatedAt: '2026-05-24T00:00:00.000Z',
        },
      },
    };
    expect(envelope.meta.tokens?.estimate).toBe(512);
  });

  it('CliMetaTokens is structurally compatible with manual construction', () => {
    const t: CliMetaTokens = {
      estimate: 100,
      model: 'approx',
      calculatedAt: '2026-05-24T00:00:00.000Z',
    };
    expect(t.estimate).toBe(100);
  });
});
