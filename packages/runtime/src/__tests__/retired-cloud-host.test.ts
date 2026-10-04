/**
 * The runtime services never call a retired SignalDock host (T13169).
 *
 * Agents registered before the retirement still carry
 * `https://api.signaldock.io` as their base URL. The poller's HTTP fallback,
 * the heartbeat and createRuntime must leave the network alone for them.
 *
 * @task T13169
 */

import type {
  AgentCredential,
  AgentRegistryAPI,
  ConduitMessage,
  Transport,
} from '@cleocode/contracts';
import { conduit } from '@cleocode/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../index.js';
import { AgentPoller } from '../services/agent-poller.js';
import { HeartbeatService } from '../services/heartbeat.js';

const RETIRED = 'https://api.signaldock.io';

function credential(): AgentCredential {
  return {
    agentId: 'agent-1',
    displayName: 'Agent One',
    apiKey: 'sk_test_key',
    apiBaseUrl: RETIRED,
    privacyTier: 'public',
    capabilities: [],
    skills: [],
    transportType: 'http',
    transportConfig: {},
    isActive: true,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  };
}

function registry(cred: AgentCredential): AgentRegistryAPI {
  return {
    register: async () => cred,
    get: async () => cred,
    list: async () => [cred],
    update: async () => cred,
    remove: async () => {},
    rotateKey: async () => ({ agentId: cred.agentId, newApiKey: 'unused' }),
    getActive: async () => cred,
    markUsed: async () => {},
  };
}

/** A local-style transport that never touches the network. */
function quietTransport(): Transport {
  return {
    name: 'local',
    connect: async () => {},
    disconnect: async () => {},
    push: async () => ({ messageId: 'm1' }),
    poll: async (): Promise<ConduitMessage[]> => [],
    ack: async () => {},
  };
}

/** Let the immediate fire-and-forget cycle settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runtime services with a SignalDock base URL', () => {
  it('AgentPoller: the HTTP fallback and group polling make no request', async () => {
    const poller = new AgentPoller({
      agentId: 'agent-1',
      apiKey: 'sk_test_key',
      apiBaseUrl: RETIRED,
      pollIntervalMs: 60_000,
      groupConversationIds: ['conv-1'],
    });
    poller.onMessage(() => {});
    poller.start();
    await settle();
    poller.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('HeartbeatService: a beat is refused locally and counted as a failure', async () => {
    const heartbeat = new HeartbeatService({
      agentId: 'agent-1',
      apiKey: 'sk_test_key',
      apiBaseUrl: RETIRED,
      intervalMs: 60_000,
    });
    heartbeat.start();
    await settle();
    heartbeat.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(heartbeat.status().consecutiveFailures).toBe(1);
  });

  it('createRuntime: starts no heartbeat or key rotation, and calls nothing', async () => {
    const runtime = await createRuntime(registry(credential()), {
      transport: quietTransport(),
      pollIntervalMs: 60_000,
    });
    try {
      expect(runtime.heartbeat).toBeNull();
      expect(runtime.keyRotation).toBeNull();
      await settle();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
    }
  });

  it('createRuntime without a conduit store fails clearly instead of polling SignalDock', async () => {
    vi.spyOn(conduit.LocalTransport, 'isAvailable').mockReturnValue(false);
    await expect(createRuntime(registry(credential()))).rejects.toMatchObject({
      code: conduit.E_SIGNALDOCK_RETIRED,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
