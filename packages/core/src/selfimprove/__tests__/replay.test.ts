/**
 * Unit tests for self-improvement scenario replay (T11889-B).
 *
 * PURE — no DB. The {@link ReplayDispatch} port is MOCKED; no real dispatcher is
 * constructed. Asserts envelope capture order, param threading, and the
 * read-only mutate guard.
 *
 * @epic T11889
 * @task T11912
 */

import type { DispatchResponse } from '@cleocode/contracts/gateway';
import { describe, expect, it, vi } from 'vitest';
import { MutateInFallbackError, type ReplayDispatch, replayScenario } from '../replay.js';
import type { Scenario } from '../scenario.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** Build a minimal valid {@link DispatchResponse} for a mocked op. */
function fakeEnvelope(operation: string): DispatchResponse {
  return {
    meta: {
      gateway: 'query',
      domain: 'tasks',
      operation,
      timestamp: new Date().toISOString(),
      duration_ms: 7,
      source: 'rpc',
      requestId: `req-${operation}`,
    },
    success: true,
    data: { operation },
  };
}

const queryScenario: Scenario = {
  name: 'two-query',
  description: 'two read-only ops',
  ops: [
    { gateway: 'query', domain: 'tasks', operation: 'find', params: { query: 'x' } },
    { gateway: 'query', domain: 'tasks', operation: 'show', params: { id: 'T1' } },
  ],
};

describe('replayScenario — capture (mocked dispatch)', () => {
  it('captures one envelope per op, in order', async () => {
    const calls: { gateway: string; domain: string; operation: string }[] = [];
    const dispatch: ReplayDispatch = vi.fn(async (op) => {
      calls.push({ gateway: op.gateway, domain: op.domain, operation: op.operation });
      return fakeEnvelope(op.operation);
    });

    const envelopes = await replayScenario(queryScenario, dispatch);

    expect(envelopes).toHaveLength(2);
    expect(calls.map((c) => c.operation)).toEqual(['find', 'show']);
    expect(envelopes.every((e) => e.success)).toBe(true);
  });

  it('threads op params into the dispatch port', async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const dispatch: ReplayDispatch = vi.fn(async (op) => {
      seen.push(op.params);
      return fakeEnvelope(op.operation);
    });

    await replayScenario(queryScenario, dispatch);

    expect(seen[0]).toEqual({ query: 'x' });
    expect(seen[1]).toEqual({ id: 'T1' });
  });
});

describe('replayScenario — read-only mutate guard', () => {
  const mutateScenario: Scenario = {
    name: 'has-mutate',
    description: 'contains a mutate op',
    ops: [
      { gateway: 'query', domain: 'tasks', operation: 'find' },
      { gateway: 'mutate', domain: 'tasks', operation: 'add', params: { title: 'x' } },
    ],
  };

  it('hard-rejects a mutate op in fallback mode (no allowMutate)', async () => {
    const dispatch: ReplayDispatch = vi.fn(async (op) => fakeEnvelope(op.operation));

    await expect(replayScenario(mutateScenario, dispatch)).rejects.toBeInstanceOf(
      MutateInFallbackError,
    );
    await expect(replayScenario(mutateScenario, dispatch)).rejects.toMatchObject({
      code: 'E_SELFIMPROVE_MUTATE_IN_FALLBACK',
      opCoord: 'tasks.add',
    });
  });

  it('does NOT dispatch the mutate op (rejects before the costed call)', async () => {
    const dispatch = vi.fn(async (op: { operation: string }) => fakeEnvelope(op.operation));

    await expect(
      replayScenario(mutateScenario, dispatch as unknown as ReplayDispatch),
    ).rejects.toBeInstanceOf(MutateInFallbackError);

    // Only the leading query op may have dispatched; the mutate op must not.
    const dispatchedOps = dispatch.mock.calls.map((c) => c[0].operation);
    expect(dispatchedOps).not.toContain('add');
  });

  it('permits a mutate op when allowMutate is explicitly set (VM path)', async () => {
    const dispatch: ReplayDispatch = vi.fn(async (op) => fakeEnvelope(op.operation));

    const envelopes = await replayScenario(mutateScenario, dispatch, { allowMutate: true });
    expect(envelopes).toHaveLength(2);
  });
});
