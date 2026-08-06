/**
 * Tests for local-inference detection (T12082).
 *
 * The failure this guards is not a crash — it is a capability that stops
 * silently. On 2026-08-06 the dream cycle reported "no usable LLM client"
 * while an Ollama server with two models loaded answered on loopback in 24 ms.
 * Nothing was broken except that nothing looked.
 *
 * @task T12082
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetLocalInferenceCacheForTests,
  detectLocalInference,
} from '../local-inference-probe.js';

/** An Ollama `/api/tags` payload. */
const OLLAMA_TAGS = {
  models: [{ name: 'qwen2.5-coder:3b' }, { name: 'qwen2:0.5b' }],
};

/** An OpenAI-compatible `/v1/models` payload (LM Studio). */
const OPENAI_MODELS = { data: [{ id: 'local-model' }] };

/**
 * Build a `fetch` stub that answers only the listed URLs.
 *
 * @param routes - map of URL to JSON body; any other URL rejects.
 * @returns the stub.
 */
function fetchStub(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!(url in routes)) throw new Error(`ECONNREFUSED ${url}`);
    return {
      ok: true,
      json: async () => routes[url],
    } as Response;
  }) as typeof fetch;
}

const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags';
const LM_STUDIO_URL = 'http://127.0.0.1:1234/v1/models';

describe('detectLocalInference (T12082)', () => {
  beforeEach(() => {
    // The shared setup pins this ON so host state cannot change unit-test
    // outcomes; this suite is the one that exercises the probe itself.
    vi.stubEnv('CLEO_DISABLE_LOCAL_INFERENCE', '');
    _resetLocalInferenceCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetLocalInferenceCacheForTests();
  });

  it('honours the operator opt-out without probing at all', async () => {
    vi.stubEnv('CLEO_DISABLE_LOCAL_INFERENCE', '1');
    const spy = vi.fn(fetchStub({ [OLLAMA_URL]: OLLAMA_TAGS }));
    vi.stubGlobal('fetch', spy);

    await expect(detectLocalInference()).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('detects Ollama and reports its models in order', async () => {
    vi.stubGlobal('fetch', fetchStub({ [OLLAMA_URL]: OLLAMA_TAGS }));

    const local = await detectLocalInference();

    expect(local).not.toBeNull();
    expect(local?.name).toBe('ollama');
    // Root for native transports, `/v1` for OpenAI-compatible ones. Mixing the
    // two 404s late: the native transport appends `/api/chat`.
    expect(local?.baseUrl).toBe('http://127.0.0.1:11434');
    expect(local?.openAiBaseUrl).toBe('http://127.0.0.1:11434/v1');
    // Order matters: the caller uses models[0] as the completion model.
    expect(local?.models).toEqual(['qwen2.5-coder:3b', 'qwen2:0.5b']);
  });

  it('falls through to LM Studio when Ollama is absent', async () => {
    vi.stubGlobal('fetch', fetchStub({ [LM_STUDIO_URL]: OPENAI_MODELS }));

    const local = await detectLocalInference();

    expect(local?.name).toBe('lm-studio');
    expect(local?.models).toEqual(['local-model']);
  });

  it('prefers Ollama when BOTH answer', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub({ [OLLAMA_URL]: OLLAMA_TAGS, [LM_STUDIO_URL]: OPENAI_MODELS }),
    );

    expect((await detectLocalInference())?.name).toBe('ollama');
  });

  it('returns null when nothing answers — the common case, and not an error', async () => {
    vi.stubGlobal('fetch', fetchStub({}));

    await expect(detectLocalInference()).resolves.toBeNull();
  });

  it('treats a server with ZERO models as absent', async () => {
    // A running Ollama with nothing pulled cannot serve a completion. Reporting
    // it as available would swap "no client" for "client that always errors" —
    // strictly worse, because the second one looks like it should work.
    vi.stubGlobal('fetch', fetchStub({ [OLLAMA_URL]: { models: [] } }));

    await expect(detectLocalInference()).resolves.toBeNull();
  });

  it('ignores a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      (async () => ({ ok: false, json: async () => OLLAMA_TAGS }) as Response) as typeof fetch,
    );

    await expect(detectLocalInference()).resolves.toBeNull();
  });

  it('never throws when the endpoint returns garbage', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        ({
          ok: true,
          json: async () => {
            throw new Error('not JSON');
          },
        }) as unknown as Response) as typeof fetch,
    );

    await expect(detectLocalInference()).resolves.toBeNull();
  });

  it('caches the result — a tick may consult it many times', async () => {
    const spy = vi.fn(fetchStub({ [OLLAMA_URL]: OLLAMA_TAGS }));
    vi.stubGlobal('fetch', spy);

    await detectLocalInference();
    await detectLocalInference();
    await detectLocalInference();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caches the NEGATIVE result too — absence must not cost a probe per call', async () => {
    const spy = vi.fn(fetchStub({}));
    vi.stubGlobal('fetch', spy);

    await detectLocalInference();
    await detectLocalInference();

    // Two endpoints probed once each, not twice each.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-probes when forced', async () => {
    const spy = vi.fn(fetchStub({ [OLLAMA_URL]: OLLAMA_TAGS }));
    vi.stubGlobal('fetch', spy);

    await detectLocalInference();
    await detectLocalInference({ force: true });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reads the Ollama `model` field when `name` is missing', async () => {
    vi.stubGlobal('fetch', fetchStub({ [OLLAMA_URL]: { models: [{ model: 'llama3:8b' }] } }));

    expect((await detectLocalInference())?.models).toEqual(['llama3:8b']);
  });

  it('drops non-string model ids rather than surfacing them', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub({ [OLLAMA_URL]: { models: [{ name: 42 }, { name: 'good:1b' }, null] } }),
    );

    expect((await detectLocalInference())?.models).toEqual(['good:1b']);
  });

  it('passes an abort signal so a black-holed port cannot stall the caller', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      throw new Error('refused');
    }) as typeof fetch);

    await detectLocalInference();

    expect(seen).toHaveLength(2);
    for (const signal of seen) expect(signal).toBeInstanceOf(AbortSignal);
  });
});
