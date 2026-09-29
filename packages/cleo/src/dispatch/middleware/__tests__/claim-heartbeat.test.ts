/**
 * The claim heartbeat renews a bound session's leases after its successful
 * mutations, and never on reads, failures or unbound calls (T12502).
 *
 * @task T12502
 */

import { describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse } from '../../types.js';
import { createClaimHeartbeat } from '../claim-heartbeat.js';

function request(gateway: DispatchRequest['gateway'], sessionId?: string): DispatchRequest {
  return {
    gateway,
    domain: 'tasks',
    operation: 'update',
    params: {},
    source: 'cli',
    requestId: 'req-1',
    ...(sessionId ? { sessionId } : {}),
  };
}

function response(success: boolean): DispatchResponse {
  return {
    meta: {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'update',
      timestamp: '2026-09-29T00:00:00.000Z',
      duration_ms: 1,
      source: 'cli',
      requestId: 'req-1',
    },
    success,
    data: {},
  };
}

describe('createClaimHeartbeat (T12502)', () => {
  it('renews after a successful mutation by a bound session', async () => {
    const renew = vi.fn(async () => undefined);
    const res = await createClaimHeartbeat(renew)(request('mutate', 'ses-a'), async () =>
      response(true),
    );
    expect(res.success).toBe(true);
    expect(renew).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses-a' }), 'ses-a');
  });

  it('does not renew on reads, failures or unbound calls', async () => {
    const renew = vi.fn(async () => undefined);
    const heartbeat = createClaimHeartbeat(renew);
    await heartbeat(request('query', 'ses-a'), async () => response(true));
    await heartbeat(request('mutate', 'ses-a'), async () => response(false));
    await heartbeat(request('mutate'), async () => response(true));
    expect(renew).not.toHaveBeenCalled();
  });

  it('a failing renewal never fails the command', async () => {
    const renew = vi.fn(async () => {
      throw new Error('store locked');
    });
    const res = await createClaimHeartbeat(renew)(request('mutate', 'ses-a'), async () =>
      response(true),
    );
    expect(res.success).toBe(true);
  });
});
