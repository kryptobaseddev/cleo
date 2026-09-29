/**
 * `cleo decide` operations: status probe for every state, model resolution on
 * config, and the debug ask — all with a stubbed `fetch` (no network), and the
 * key asserted absent from every returned value.
 *
 * @task T12491
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAYAHOST_BASE_URL, LAYAHOST_DEFAULT_MODEL } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDecideDefaultsForTest } from '../client.js';
import { loadDecideConnection, saveDecideCredentials } from '../credentials.js';
import {
  askDecideDebug,
  clearDecideConfig,
  configureDecide,
  probeDecideProvider,
} from '../operations.js';

// T12492: the default Jev transport is `decideFetch` (node:http, releases every
// handle on abort), not the global `fetch`. These tests drive the default
// provider through a stubbed global `fetch`, so route the transport through it.
vi.mock('../transport.js', () => ({
  decideFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

const KEY = 'sk-test-OPSSECRET-4321';
const URL = 'https://decide.test';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env['CLEO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'cleo-decide-ops-'));
  process.env['CLEO_HOME'] = home;
  _resetCleoPlatformPathsCache();
  _resetDecideDefaultsForTest();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = previousHome;
  _resetCleoPlatformPathsCache();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

const modelsBody = { models: [{ name: 'first-listed' }, { name: 'second' }] };

function expectNoKey(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(KEY);
  expect(JSON.stringify(value)).not.toContain('OPSSECRET');
}

describe('probeDecideProvider', () => {
  it('reports unconfigured without touching the network', async () => {
    const fetchStub = vi.fn();
    const result = await probeDecideProvider({ fetch: fetchStub });
    expect(result.state).toBe('unconfigured');
    expect(result.modelsEndpoint).toBe('skipped');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('reports reachable with the listed models, GETting /v1/models with the bearer key', async () => {
    await saveDecideCredentials({ baseUrl: `${URL}/`, apiKey: KEY });
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => Response.json(modelsBody));
    const result = await probeDecideProvider({ fetch: fetchStub });
    expect(result).toMatchObject({
      state: 'reachable',
      modelsEndpoint: 'ok',
      models: ['first-listed', 'second'],
      keyPreview: '…4321',
    });
    expect(result.detail).toMatch(/requires a model/);
    // T12664: the probe also detects capabilities (/v1/usage, /v1/templates) first.
    const [u, init] = fetchStub.mock.calls.find(([url]) => url === `${URL}/v1/models`) ?? [];
    expect(u).toBe(`${URL}/v1/models`);
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`);
    expectNoKey(result);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'unreachable'],
    [404, 'unreachable'],
  ] as const)('HTTP %i → %s', async (status, state) => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'm' });
    const fetchStub = vi.fn(async () => new Response('{}', { status }));
    const result = await probeDecideProvider({ fetch: fetchStub });
    expect(result).toMatchObject({ state, modelsEndpoint: 'failed', httpStatus: status });
    expectNoKey(result);
  });

  it('network failure and timeout → unreachable', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'm' });
    const refused = await probeDecideProvider({
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    expect(refused.state).toBe('unreachable');

    const hanging = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const timedOut = await probeDecideProvider({ fetch: hanging, timeoutMs: 20 });
    expect(timedOut.state).toBe('unreachable');
    expectNoKey([refused, timedOut]);
  });

  it('a 2xx with an unexpected body is reachable but flags the models endpoint', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'm' });
    const result = await probeDecideProvider({ fetch: vi.fn(async () => Response.json({ x: 1 })) });
    expect(result).toMatchObject({ state: 'reachable', modelsEndpoint: 'failed' });
  });
});

describe('configureDecide', () => {
  it('stores an explicit model over the listing, then probes the saved settings (T12713)', async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => Response.json(modelsBody));
    const result = await configureDecide({
      baseUrl: URL,
      apiKey: KEY,
      model: 'pinned',
      fetch: fetchStub,
    });
    expect(result).toMatchObject({
      configured: true,
      provider: 'jev',
      model: 'pinned',
      modelSource: 'flag',
      providerState: 'reachable',
    });
    expect(loadDecideConnection()?.model).toBe('pinned');
    expect(fetchStub.mock.calls.some(([u]) => u === `${URL}/v1/models`)).toBe(true);
    expectNoKey(result);
  });

  it('resolves an omitted model from the provider listing (first listed)', async () => {
    const result = await configureDecide({
      baseUrl: URL,
      apiKey: KEY,
      fetch: vi.fn(async () => Response.json(modelsBody)),
    });
    expect(result).toMatchObject({ model: 'first-listed', modelSource: 'provider-listing' });
    expect(loadDecideConnection()?.model).toBe('first-listed');
    expectNoKey(result);
  });

  it('stores without a model and warns when the listing is unavailable', async () => {
    const result = await configureDecide({
      baseUrl: URL,
      apiKey: KEY,
      fetch: vi.fn(async () => new Response('{}', { status: 401 })),
    });
    expect(result).toMatchObject({ configured: true, modelSource: 'none' });
    expect(result.model).toBeUndefined();
    expect(result.warning).toMatch(/unauthorized/);
    expectNoKey(result);
  });

  it('keeps the stored key and model when only some settings change', async () => {
    await configureDecide({ baseUrl: URL, apiKey: KEY, model: 'kept' });
    const result = await configureDecide({ baseUrl: URL, fetch: vi.fn() });
    expect(result).toMatchObject({ model: 'kept', modelSource: 'stored', keyPreview: '…4321' });
    expect(loadDecideConnection()?.connection().apiKey).toBe(KEY);
  });

  it('clear reports what was removed', async () => {
    await configureDecide({ baseUrl: URL, apiKey: KEY, model: 'm' });
    const cleared = await clearDecideConfig();
    expect(cleared).toMatchObject({ cleared: true, configured: false });
    expectNoKey(cleared);
  });
});

describe('configureDecide — provider presets (T12713)', () => {
  it('defaults to layahost: preset URL and model, only the key supplied', async () => {
    const fetchStub = vi.fn(async (_u: string, _i: RequestInit) => Response.json(modelsBody));
    const result = await configureDecide({ apiKey: KEY, fetch: fetchStub });
    expect(result).toMatchObject({
      configured: true,
      provider: 'layahost',
      baseUrl: LAYAHOST_BASE_URL,
      model: LAYAHOST_DEFAULT_MODEL,
      modelSource: 'preset',
    });
    expect(fetchStub.mock.calls.some(([u]) => u === `${LAYAHOST_BASE_URL}/v1/models`)).toBe(true);
    expectNoKey(result);
  });

  it('--url overrides the layahost preset URL; the preset model still applies', async () => {
    const result = await configureDecide({
      provider: 'layahost',
      baseUrl: URL,
      apiKey: KEY,
      fetch: vi.fn(async () => Response.json(modelsBody)),
    });
    expect(result).toMatchObject({ provider: 'layahost', baseUrl: URL, model: 'laya-auto' });
  });

  it('infers jev from a non-layahost URL and layahost from the layahost host', async () => {
    const jev = await configureDecide({
      baseUrl: URL,
      apiKey: KEY,
      fetch: vi.fn(async () => Response.json(modelsBody)),
    });
    expect(jev).toMatchObject({ provider: 'jev', model: 'first-listed' });
    const laya = await configureDecide({
      baseUrl: `${LAYAHOST_BASE_URL}/`,
      apiKey: KEY,
      fetch: vi.fn(async () => Response.json(modelsBody)),
    });
    expect(laya).toMatchObject({ provider: 'layahost', model: 'laya-auto' });
  });

  it('rejects jev without a URL with a clear error, storing and sending nothing', async () => {
    const fetchStub = vi.fn();
    await expect(
      configureDecide({ provider: 'jev', apiKey: KEY, fetch: fetchStub }),
    ).rejects.toThrow(/jev provider needs a base URL: pass --url/);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(loadDecideConnection()).toBeNull();
  });

  it('regression: layahost always stores a model, so a request is never sent without one (422)', async () => {
    // The listing is down at config time: before T12713 no model was stored and
    // every decision went out without one, answered 422 and fell back silently.
    const result = await configureDecide({
      apiKey: KEY,
      fetch: vi.fn(async () => new Response('{}', { status: 503 })),
    });
    expect(result).toMatchObject({ model: 'laya-auto', modelSource: 'preset' });
    expect(result.warning).toBeUndefined();

    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if (typeof body['model'] !== 'string') {
          return Response.json(
            { error: { type: 'invalid_request', message: 'model is required' } },
            { status: 422 },
          );
        }
        return Response.json({ answers: { answer: { type: 'noul', noul: 0.9, confidence: 0.8 } } });
      }),
    );
    const asked = await askDecideDebug({ state: 's', question: 'q', projectRoot: home });
    expect(bodies[0]?.['model']).toBe('laya-auto');
    expect(asked.source).toBe('provider');
  });

  it('re-detects capabilities on save even when the cached read is fresh', async () => {
    const minimal = vi.fn(async (u: string) =>
      u.endsWith('/v1/models') ? Response.json(modelsBody) : new Response('{}', { status: 404 }),
    );
    const first = await configureDecide({ apiKey: KEY, fetch: minimal });
    expect(first.capabilities?.usage).toBeUndefined();

    const extended = vi.fn(async (u: string) =>
      u.includes('/v1/usage')
        ? Response.json({ balance: { micros: 5_000_000 } })
        : u.endsWith('/v1/models')
          ? Response.json(modelsBody)
          : new Response('{}', { status: 404 }),
    );
    const second = await configureDecide({ apiKey: KEY, fetch: extended });
    expect(second.capabilities).toMatchObject({ usage: true, batch: { maxRequests: 64 } });
    expect(extended.mock.calls.some(([u]) => u.startsWith(`${LAYAHOST_BASE_URL}/v1/usage`))).toBe(
      true,
    );
  });
});

describe('askDecideDebug', () => {
  it('returns the provider answer with source, latency, cost and no key', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'm' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          answers: { answer: { type: 'noul', noul: 0.91, confidence: 0.8 } },
          meta: { request_id: 'req_1', cost_usd: 0.0002 },
        }),
      ),
    );
    const result = await askDecideDebug({
      state: 'deploy failed',
      question: 'Retry helps',
      projectRoot: home,
    });
    expect(result).toMatchObject({
      answer: { type: 'noul', value: true, probability: 0.91 },
      source: 'provider',
      costUsd: 0.0002,
      requestId: 'req_1',
      model: 'm',
    });
    expect(typeof result.latencyMs).toBe('number');
    expectNoKey(result);
  });

  it('reports the fallback reason when unconfigured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network forbidden');
      }),
    );
    const result = await askDecideDebug({ state: 's', question: 'q', projectRoot: home });
    expect(result).toMatchObject({ source: 'fallback', fallbackReason: 'unconfigured' });
  });
});

describe('hardening', () => {
  it('a host change without a fresh key is refused and never sends the stored key', async () => {
    await configureDecide({ baseUrl: URL, apiKey: KEY, model: 'm' });
    const fetchStub = vi.fn(async () => Response.json(modelsBody));
    await expect(
      configureDecide({ baseUrl: 'https://other-host.example', fetch: fetchStub }),
    ).rejects.toThrow(/fresh key/);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(loadDecideConnection()?.baseUrl).toBe(URL);

    // Same host, new path: the stored key may be kept.
    const samePath = await configureDecide({ baseUrl: `${URL}/api`, fetch: fetchStub });
    expect(samePath.keyPreview).toBe('…4321');

    // New host with a fresh key is fine.
    const moved = await configureDecide({
      baseUrl: 'https://other-host.example',
      apiKey: 'sk-new-host-key-0000',
      fetch: fetchStub,
    });
    expect(moved).toMatchObject({ baseUrl: 'https://other-host.example', keyPreview: '…0000' });
    const [, init] = (fetchStub.mock.calls.at(-1) ?? []) as unknown as [string, RequestInit];
    expect(JSON.stringify(init.headers)).not.toContain(KEY);
  });

  it('refuses a remote plain-http URL but accepts loopback http', async () => {
    await expect(
      configureDecide({ baseUrl: 'http://provider.example', apiKey: KEY, model: 'm' }),
    ).rejects.toThrow(/https/);
    const local = await configureDecide({
      baseUrl: 'http://127.0.0.1:47811',
      apiKey: KEY,
      model: 'm',
    });
    expect(local.configured).toBe(true);
  });

  it('skips listed model names carrying escape sequences; never stores or prints them', async () => {
    const hostile = 'evil\u001b[2J\u001b]0;pwned\u0007';
    const fetchStub = vi.fn(async () =>
      Response.json({ models: [{ name: hostile }, { name: 42 }, { name: 'safe-model' }] }),
    );
    const result = await configureDecide({ baseUrl: URL, apiKey: KEY, fetch: fetchStub });
    expect(result).toMatchObject({ model: 'safe-model', modelSource: 'provider-listing' });
    const probe = await probeDecideProvider({ fetch: fetchStub });
    expect(probe.models).toEqual(['safe-model']);
    expect(JSON.stringify([result, probe])).not.toContain('\u001b');
  });

  it('only escape-sequence names → nothing stored, warning shown', async () => {
    const fetchStub = vi.fn(async () => Response.json({ models: [{ name: 'x\u001b[31m' }] }));
    const result = await configureDecide({ baseUrl: URL, apiKey: KEY, fetch: fetchStub });
    expect(result.modelSource).toBe('none');
    expect(result.model).toBeUndefined();
  });

  it('caps the listing length and fails soft on an oversized body', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'm' });
    const many = { models: Array.from({ length: 2_000 }, (_, i) => ({ name: `m${i}` })) };
    const long = await probeDecideProvider({ fetch: vi.fn(async () => Response.json(many)) });
    expect(long.state).toBe('reachable');
    expect(long.models).toHaveLength(500);

    const huge = JSON.stringify({ models: [{ name: 'a', description: 'x'.repeat(300 * 1024) }] });
    const oversized = await probeDecideProvider({
      fetch: vi.fn(
        async () => new Response(huge, { headers: { 'content-type': 'application/json' } }),
      ),
    });
    expect(oversized).toMatchObject({ state: 'reachable', modelsEndpoint: 'failed' });
    expect(oversized.detail).toMatch(/size limit/);

    const declared = await probeDecideProvider({
      fetch: vi.fn(
        async () => new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } }),
      ),
    });
    expect(declared.modelsEndpoint).toBe('failed');
  });
});
