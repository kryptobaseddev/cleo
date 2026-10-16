/**
 * T13716 — the download gate against the REAL `@huggingface/transformers`.
 *
 * transformers.js 4.0.1 fetches config and tokenizer metadata from the hub
 * even under `local_files_only`, so a mocked pipeline cannot prove the gate.
 * This drives the real library with an empty cache and a stubbed fetch layer
 * (`globalThis.fetch` and `env.fetch`, which the library binds at import).
 * With default config there must be zero fetches; after the opt-in the same
 * stub must see the hub request, which proves the probe is not vacuous.
 *
 * @task T13716
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '@huggingface/transformers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ allowModelDownload: undefined as boolean | undefined }));

vi.mock('../../config.js', () => ({
  loadConfig: async () => ({
    brain: {
      embedding: {
        enabled: true,
        provider: 'local',
        ...(state.allowModelDownload === undefined
          ? {}
          : { allowModelDownload: state.allowModelDownload }),
      },
    },
  }),
}));

const saved = {
  cacheDir: env.cacheDir,
  localModelPath: env.localModelPath,
  allowRemoteModels: env.allowRemoteModels,
  fetch: env.fetch,
  globalFetch: globalThis.fetch,
};
let dir = '';
const fetched: string[] = [];

beforeEach(async () => {
  state.allowModelDownload = undefined;
  fetched.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'cleo-t13716-'));
  env.cacheDir = join(dir, 'cache');
  env.localModelPath = join(dir, 'models');
  const stub = async (input: string | URL | Request): Promise<Response> => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error('network disabled in test');
  };
  env.fetch = stub;
  globalThis.fetch = stub;
  const { __resetLocalEmbeddingStateForTests } = await import('../embedding-local.js');
  __resetLocalEmbeddingStateForTests();
});

afterEach(() => {
  env.cacheDir = saved.cacheDir;
  env.localModelPath = saved.localModelPath;
  env.allowRemoteModels = saved.allowRemoteModels;
  env.fetch = saved.fetch;
  globalThis.fetch = saved.globalFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe('real transformers.js download gate (T13716)', () => {
  it('default config, empty cache: zero fetch calls', async () => {
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    await expect(new LocalEmbeddingProvider().embed('hello')).rejects.toThrow();
    expect(fetched).toEqual([]);
    expect(env.allowRemoteModels).toBe(false);
  });

  it('explicit opt-in: the hub is fetched', async () => {
    state.allowModelDownload = true;
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    await expect(new LocalEmbeddingProvider().embed('hello')).rejects.toThrow();
    expect(fetched.some((url) => url.includes('huggingface.co'))).toBe(true);
  });
});
