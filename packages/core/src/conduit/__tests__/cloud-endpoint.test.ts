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
import { agents as legacyAgents } from '../../store/schema/agent-registry-schema.js';
import { agentRegistryAgents } from '../../store/schema/cleo-global/agent-registry.js';
import { tasksAgentCredentials } from '../../store/schema/cleo-project/provenance-orphans.js';
import {
  conduitFetch,
  E_SIGNALDOCK_RETIRED,
  installRetiredHostFetchGuard,
  isRetiredCloudUrl,
  MAX_CONDUIT_REDIRECTS,
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

  it('passes any other URL to fetch, following redirects itself', async () => {
    const init = { method: 'POST', body: '{}' };
    await conduitFetch(`${OTHER}/messages`, init);
    expect(fetchSpy).toHaveBeenCalledWith(`${OTHER}/messages`, { ...init, redirect: 'manual' });
  });
});

describe('conduitFetch redirects', () => {
  const redirect = (status: number, location: string) =>
    new Response(null, { status, headers: { location } });

  it('refuses a redirect to a SignalDock host before following it', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, 'https://api.signaldock.io/messages'));
    await expect(conduitFetch(`${OTHER}/messages`)).rejects.toThrow(SignalDockRetiredError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('checks every hop, including a relative one and a later one', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect(307, '/v2/messages'))
      .mockResolvedValueOnce(redirect(308, 'https://SSE.signaldock.io./x'));
    await expect(conduitFetch(`${OTHER}/messages`)).rejects.toMatchObject({
      code: E_SIGNALDOCK_RETIRED,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(`${OTHER}/v2/messages`);
  });

  it('keeps credentials on the same origin and drops them on another', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect(307, '/same'))
      .mockResolvedValueOnce(redirect(307, 'https://other.example.test/x'));
    await conduitFetch(`${OTHER}/messages`, {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer secret', 'X-Agent-Id': 'a' },
    });
    const headersAt = (i: number) => new Headers(fetchSpy.mock.calls[i]?.[1]?.headers);
    expect(headersAt(1).get('authorization')).toBe('Bearer secret');
    expect(headersAt(2).get('authorization')).toBeNull();
    expect(headersAt(2).get('x-agent-id')).toBe('a');
    expect(fetchSpy.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('turns a POST into a body-less GET on 303', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(303, '/done'));
    await conduitFetch(`${OTHER}/messages`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    const followed = fetchSpy.mock.calls[1]?.[1];
    expect(followed).toMatchObject({ method: 'GET', body: undefined });
    expect(new Headers(followed?.headers).get('content-type')).toBeNull();
  });

  it(`gives up after ${MAX_CONDUIT_REDIRECTS} redirects`, async () => {
    fetchSpy.mockImplementation(async () => redirect(302, '/loop'));
    await expect(conduitFetch(`${OTHER}/messages`)).rejects.toThrow(/more than 5 redirects/);
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_CONDUIT_REDIRECTS + 1);
  });
});

describe('installRetiredHostFetchGuard (the process-wide backstop)', () => {
  it('refuses a SignalDock request made through the global fetch, whatever its input form', async () => {
    installRetiredHostFetchGuard();
    await expect(fetch(`${RETIRED}/health`)).rejects.toThrow(SignalDockRetiredError);
    await expect(fetch(new URL(`${RETIRED}/health`))).rejects.toThrow(SignalDockRetiredError);
    await expect(fetch(new Request(`${RETIRED}/health`))).rejects.toThrow(SignalDockRetiredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes every other request through, and wraps only once', async () => {
    installRetiredHostFetchGuard();
    const wrapped = globalThis.fetch;
    installRetiredHostFetchGuard();
    expect(globalThis.fetch).toBe(wrapped);
    await fetch(`${OTHER}/health`, { method: 'GET' });
    expect(fetchSpy).toHaveBeenCalledWith(`${OTHER}/health`, { method: 'GET' });
  });
});

describe('agent base URL defaults (T13169)', () => {
  it.each([
    ['cleo-global agent registry', agentRegistryAgents.apiBaseUrl],
    ['legacy agent registry', legacyAgents.apiBaseUrl],
    ['project agent credentials', tasksAgentCredentials.apiBaseUrl],
  ])('%s: an ORM insert that omits the column stores local; the SQL default is unchanged', (_n, column) => {
    expect(column.defaultFn?.()).toBe('local');
    expect(column.default).toBe('https://api.signaldock.io');
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
