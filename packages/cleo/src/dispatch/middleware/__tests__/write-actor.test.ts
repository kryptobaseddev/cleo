/**
 * Write-actor middleware (T13229): a mutate operation's writes record its
 * command and session; a query records nothing.
 *
 * @task T13229
 */

import { currentWriteActorJson } from '@cleocode/core/store/sync/write-actor';
import { describe, expect, it } from 'vitest';
import type { DispatchRequest, DispatchResponse } from '../../types.js';
import { createWriteActor } from '../write-actor.js';

function request(gateway: DispatchRequest['gateway'], sessionId?: string): DispatchRequest {
  return {
    gateway,
    domain: 'tasks',
    operation: 'restore',
    params: {},
    source: 'cli',
    requestId: 'req-1',
    ...(sessionId ? { sessionId } : {}),
  };
}

const response: DispatchResponse = {
  meta: {
    gateway: 'mutate',
    domain: 'tasks',
    operation: 'restore',
    timestamp: '2026-10-05T00:00:00.000Z',
    duration_ms: 1,
    source: 'cli',
    requestId: 'req-1',
  },
  success: true,
  data: {},
};

describe('createWriteActor (T13229)', () => {
  it('a mutate operation runs with its command and session as the write actor', async () => {
    let seen: string | null = 'unset';
    await createWriteActor()(request('mutate', 'ses-1'), async () => {
      await Promise.resolve();
      seen = currentWriteActorJson();
      return response;
    });
    expect(seen).toBe('{"op":"tasks.restore","session":"ses-1"}');
    expect(currentWriteActorJson()).toBeNull();
  });

  it('a query records no actor', async () => {
    let seen: string | null = 'unset';
    await createWriteActor()(request('query'), async () => {
      seen = currentWriteActorJson();
      return response;
    });
    expect(seen).toBeNull();
  });
});
