/**
 * The session resolver reports an unattributed CLI mutation (T12500).
 *
 * An unbound caller's mutation used to proceed with no session and no word:
 * attribution was dropped and the lifecycle epic-scope guard had nothing to
 * check. The resolver now hands such requests to an `onUnboundMutation` hook,
 * which the CLI uses to warn on stderr (never stdout — ADR-086).
 *
 * @task T12500
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse } from '../../types.js';
import { createSessionResolver } from '../session-resolver.js';

function makeRequest(
  gateway: DispatchRequest['gateway'],
  domain: string,
  source: DispatchRequest['source'] = 'cli',
): DispatchRequest {
  return { gateway, domain, operation: 'op', params: {}, source, requestId: 'req-1' };
}

const ok: DispatchResponse = {
  meta: {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'op',
    timestamp: '2026-09-27T00:00:00.000Z',
    duration_ms: 1,
    source: 'cli',
    requestId: 'req-1',
  },
  success: true,
  data: {},
};

describe('createSessionResolver — unbound mutations (T12500)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('calls the hook for an unbound CLI mutation and still runs it', async () => {
    vi.stubEnv('CLEO_SESSION_ID', undefined);
    const hook = vi.fn(async () => undefined);
    const next = vi.fn(async () => ok);
    const resolver = createSessionResolver(async () => null, hook);

    const res = await resolver(makeRequest('mutate', 'tasks'), next);

    expect(res).toBe(ok);
    expect(next).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledOnce();
  });

  it('does not call the hook for a bound mutation, a query, or the session domain', async () => {
    vi.stubEnv('CLEO_SESSION_ID', undefined);
    const hook = vi.fn(async () => undefined);
    const next = vi.fn(async () => ok);

    await createSessionResolver(async () => 'ses_bound', hook)(
      makeRequest('mutate', 'tasks'),
      next,
    );
    await createSessionResolver(async () => null, hook)(makeRequest('query', 'tasks'), next);
    await createSessionResolver(async () => null, hook)(makeRequest('mutate', 'session'), next);

    expect(hook).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('never fails the command when the hook throws', async () => {
    vi.stubEnv('CLEO_SESSION_ID', undefined);
    const next = vi.fn(async () => ok);
    const resolver = createSessionResolver(
      async () => null,
      async () => {
        throw new Error('boom');
      },
    );
    await expect(resolver(makeRequest('mutate', 'tasks'), next)).resolves.toBe(ok);
  });
});
