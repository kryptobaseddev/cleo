/**
 * Type-shape contract test for the envelope-wide `meta.suggestedNext`
 * field promoted in T9920 (Saga T9855 / E8.1).
 *
 * `CliMeta.suggestedNext` is the canonical LLM-next-action hint
 * surfaced on every CLI envelope. This test asserts the type allows
 * the optional `ReadonlyArray<string>` shape and never widens to
 * `string | null` or to nested objects (which would re-introduce the
 * pre-T9920 nexus-internal-only structured form at the envelope tier).
 *
 * The runtime `attachSuggestedNext` helper lives in
 * `packages/core/src/dispatch/suggested-next.ts` and is exercised by
 * `packages/core/src/dispatch/__tests__/suggested-next.test.ts` —
 * contracts cannot import core without breaking the layering contract.
 *
 * @epic T9919
 * @task T9920
 * @saga T9855
 */

import type { CliEnvelope, CliMeta } from '@cleocode/lafs';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('CliMeta.suggestedNext type shape (T9920)', () => {
  it('allows ReadonlyArray<string>', () => {
    const meta: CliMeta = {
      operation: 'tasks.show',
      requestId: '00000000-0000-0000-0000-000000000000',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
      suggestedNext: ['cleo focus T1234', 'cleo verify T1234'],
    };
    expect(meta.suggestedNext).toEqual(['cleo focus T1234', 'cleo verify T1234']);
  });

  it('is optional — omitting it leaves a valid CliMeta', () => {
    const meta: CliMeta = {
      operation: 'tasks.list',
      requestId: '00000000-0000-0000-0000-000000000001',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
    };
    expect(meta.suggestedNext).toBeUndefined();
  });

  it('accepts an empty array (explicit "no follow-up suggested")', () => {
    const meta: CliMeta = {
      operation: 'tasks.show',
      requestId: '00000000-0000-0000-0000-000000000002',
      duration_ms: 0,
      timestamp: '2026-05-24T00:00:00.000Z',
      suggestedNext: [],
    };
    expect(meta.suggestedNext).toEqual([]);
    expect(Array.isArray(meta.suggestedNext)).toBe(true);
  });

  it('typechecks as ReadonlyArray<string> — never `null`, never nested objects', () => {
    expectTypeOf<CliMeta['suggestedNext']>().toEqualTypeOf<ReadonlyArray<string> | undefined>();
  });

  it('flows through CliEnvelope<T>.meta verbatim', () => {
    const envelope: CliEnvelope<{ taskId: string }> = {
      success: true,
      data: { taskId: 'T1234' },
      meta: {
        operation: 'tasks.show',
        requestId: '00000000-0000-0000-0000-000000000003',
        duration_ms: 1,
        timestamp: '2026-05-24T00:00:00.000Z',
        suggestedNext: ['cleo focus T1234'],
      },
    };
    expect(envelope.meta.suggestedNext).toEqual(['cleo focus T1234']);
  });
});
