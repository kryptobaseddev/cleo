/**
 * SignalDock is retired: no conduit code path calls a SignalDock host (T13169).
 *
 * Every assertion that a call was refused also asserts that the global
 * `fetch` (or `EventSource`) was never invoked, so a refusal that still
 * touched the network fails here.
 *
 * @task T13169
 */

import type { AgentCredential, AgentRegistryAPI } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conduitFetch,
  E_SIGNALDOCK_RETIRED,
  isRetiredCloudUrl,
  retiredCloudHost,
  SignalDockRetiredError,
} from '../cloud-endpoint.js';
import { ConduitClient } from '../conduit-client.js';
import { createConduit, resolveTransport } from '../factory.js';
import { HttpTransport } from '../http-transport.js';
import { LocalTransport } from '../local-transport.js';
import { SseTransport } from '../sse-transport.js';

const RETIRED = 'https://api.signaldock.io';
const OTHER = 'https://relay.example.test';

function credential(apiBaseUrl: string, sseEndpoint?: string): AgentCredential {
  return {
    agentId: 'agent-1',
    displayName: 'Agent One',
    apiKey: 'sk_test_key',
    apiBaseUrl,
    privacyTier: 'public',
    capabilities: [],
    skills: [],
    transportType: 'http',
    transportConfig: sseEndpoint ? { sseEndpoint } : {},
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

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('retiredCloudHost', () => {
  it.each([
    ['https://api.signaldock.io', 'api.signaldock.io'],
    ['https://signaldock.io/claim/x', 'signaldock.io'],
    ['https://SSE.SignalDock.IO/sse', 'sse.signaldock.io'],
    ['http://api.signaldock.io', 'api.signaldock.io'],
    ['https://api.signaldock.io./agents', 'api.signaldock.io'],
    ['https://user:pw@api.signaldock.io:8443/a', 'api.signaldock.io'],
    ['wss://ws.signaldock.io/stream', 'ws.signaldock.io'],
  ])('%s is retired', (url, host) => {
    expect(retiredCloudHost(url)).toBe(host);
    expect(isRetiredCloudUrl(url)).toBe(true);
  });

  it.each([
    'https://api.signaldock.invalid',
    'https://notsignaldock.io',
    'https://signaldock.io.example.test',
    'https://relay.example.test',
    'local',
    '',
    'not a url',
  ])('%s is not retired', (url) => {
    expect(retiredCloudHost(url)).toBeNull();
    expect(isRetiredCloudUrl(url)).toBe(false);
  });

  it('treats a missing URL as not retired', () => {
    expect(retiredCloudHost(null)).toBeNull();
    expect(retiredCloudHost(undefined)).toBeNull();
  });
});

describe('conduitFetch', () => {
  it('refuses a SignalDock host without calling fetch', async () => {
    const call = conduitFetch(`${RETIRED}/agents/a/status`, { method: 'PUT' });
    await expect(call).rejects.toThrow(SignalDockRetiredError);
    await expect(call).rejects.toMatchObject({
      code: E_SIGNALDOCK_RETIRED,
      host: 'api.signaldock.io',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes any other URL straight to fetch', async () => {
    const init = { method: 'POST', body: '{}' };
    await conduitFetch(`${OTHER}/messages`, init);
    expect(fetchSpy).toHaveBeenCalledWith(`${OTHER}/messages`, init);
  });
});

describe('transports refuse a SignalDock endpoint at connect', () => {
  it('HttpTransport', async () => {
    const transport = new HttpTransport();
    await expect(
      transport.connect({ agentId: 'a', apiKey: 'k', apiBaseUrl: RETIRED }),
    ).rejects.toThrow(SignalDockRetiredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SseTransport, by base URL or by SSE endpoint', async () => {
    const eventSourceSpy = vi.fn();
    vi.stubGlobal('EventSource', eventSourceSpy);
    await expect(
      new SseTransport().connect({ agentId: 'a', apiKey: 'k', apiBaseUrl: RETIRED }),
    ).rejects.toThrow(SignalDockRetiredError);
    await expect(
      new SseTransport().connect({
        agentId: 'a',
        apiKey: 'k',
        apiBaseUrl: OTHER,
        sseEndpoint: 'https://sse.signaldock.io/sse',
      }),
    ).rejects.toThrow(SignalDockRetiredError);
    expect(eventSourceSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('factory and client', () => {
  beforeEach(() => {
    vi.spyOn(LocalTransport, 'isAvailable').mockReturnValue(false);
  });

  it('never picks SSE for a SignalDock agent, and createConduit fails clearly', async () => {
    const cred = credential(RETIRED, 'https://sse.signaldock.io/sse');
    expect(resolveTransport(cred)).toBeInstanceOf(HttpTransport);
    await expect(createConduit(registry(cred))).rejects.toMatchObject({
      code: E_SIGNALDOCK_RETIRED,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still picks SSE for any other cloud agent', () => {
    expect(resolveTransport(credential(OTHER, `${OTHER}/sse`))).toBeInstanceOf(SseTransport);
  });

  it('ConduitClient.isOnline reports a SignalDock agent offline without calling it', async () => {
    const client = new ConduitClient(new HttpTransport(), credential(RETIRED));
    await expect(client.isOnline('agent-2')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
