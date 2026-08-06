/**
 * A live local daemon is its own provisioning evidence (T12082).
 *
 * `isProvisioned` is synchronous, so it could not probe; it settled for
 * "`OLLAMA_HOST` is set OR the store has an entry". Liveness was then probed
 * only for providers already in the provisioned set — circular, so an
 * undeclared daemon could never be admitted no matter how healthy it was.
 *
 * The cost was total rather than marginal: with every cloud credential
 * expired, all five roles resolved to `no-provisioned-provider` — no
 * consolidation, no extraction, no hygiene, no dream cycle — while Ollama
 * answered on loopback in 24 ms with two models loaded.
 *
 * @task T12082
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileOllamaModel } from '../cross-provider-selector.js';
import {
  _resetLocalInferenceCacheForTests,
  detectLocalInference,
} from '../local-inference-probe.js';

describe('local daemon admission (T12082)', () => {
  beforeEach(() => {
    vi.stubEnv('CLEO_DISABLE_LOCAL_INFERENCE', '');
    _resetLocalInferenceCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetLocalInferenceCacheForTests();
  });

  it('detects an undeclared daemon — no OLLAMA_HOST, no store entry', async () => {
    vi.stubEnv('OLLAMA_HOST', '');
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      if (String(input) !== 'http://127.0.0.1:11434/api/tags') throw new Error('refused');
      return {
        ok: true,
        json: async () => ({ models: [{ name: 'qwen2.5-coder:3b' }] }),
      } as Response;
    }) as typeof fetch);

    const local = await detectLocalInference();

    // This is the input the selector uses to admit ollama as provisioned.
    expect(local?.name).toBe('ollama');
    expect(local?.models).toEqual(['qwen2.5-coder:3b']);
  });
});

describe('reconcileOllamaModel (T12082)', () => {
  it('keeps the RAM-preferred model when it is installed', () => {
    expect(reconcileOllamaModel('gemma4:e4b', ['gemma4:e4b', 'qwen2:0.5b'])).toBe('gemma4:e4b');
  });

  it('drops to the same family when the exact tag is not pulled', () => {
    // 62 GB of RAM scores into the e4b tier; only e2b is on disk.
    expect(reconcileOllamaModel('gemma4:e4b', ['qwen2:0.5b', 'gemma4:e2b'])).toBe('gemma4:e2b');
  });

  it('falls back to the first installed model rather than a guaranteed 404', () => {
    // The old behaviour named a model the daemon does not hold. That surfaces
    // as "local inference is broken", not "that tag is not installed" — the
    // wrong diagnosis, and an expensive one.
    expect(reconcileOllamaModel('gemma4:e4b', ['qwen2.5-coder:3b', 'qwen2:0.5b'])).toBe(
      'qwen2.5-coder:3b',
    );
  });

  it('leaves the preference alone when the installed set is UNKNOWN', () => {
    // An empty list means "could not ask the daemon", not "nothing is
    // installed" — overriding on that basis would be guessing.
    expect(reconcileOllamaModel('gemma4:e4b', [])).toBe('gemma4:e4b');
  });

  it('matches family by tag prefix, not by substring', () => {
    // 'gemma4' must not match 'gemma40:x' or 'notgemma4:x'.
    expect(reconcileOllamaModel('gemma4:e4b', ['gemma40:x', 'notgemma4:y'])).toBe('gemma40:x');
    expect(reconcileOllamaModel('gemma4:e4b', ['notgemma4:y', 'gemma4:e2b'])).toBe('gemma4:e2b');
  });

  it('handles a preference with no tag separator', () => {
    expect(reconcileOllamaModel('llama3', ['llama3:8b'])).toBe('llama3:8b');
  });
});
