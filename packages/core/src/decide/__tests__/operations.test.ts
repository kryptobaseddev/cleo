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
    const [u, init] = fetchStub.mock.calls[0] ?? [];
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
  it('stores an explicit model without probing', async () => {
    const fetchStub = vi.fn();
    const result = await configureDecide({
      baseUrl: URL,
      apiKey: KEY,
      model: 'pinned',
      fetch: fetchStub,
    });
    expect(result).toMatchObject({ configured: true, model: 'pinned', modelSource: 'flag' });
    expect(fetchStub).not.toHaveBeenCalled();
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
