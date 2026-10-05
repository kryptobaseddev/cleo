import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetModelsDevCache,
  resolveProviderFromModelIndex,
  resolveProviderFromModelRegistry,
} from '../model-provider-registry.js';

describe('resolveProviderFromModelIndex', () => {
  const index = {
    anthropic: {
      id: 'anthropic',
      models: {
        'claude-3-7-sonnet-latest': { id: 'claude-3-7-sonnet-latest' },
      },
    },
    openai: {
      id: 'openai',
      models: {
        'openai/gpt-5': { id: 'openai/gpt-5' },
      },
    },
    openrouter: {
      id: 'openrouter',
      models: {
        'openai/gpt-5': { id: 'openai/gpt-5' },
      },
    },
  };

  it('uses provider prefix for namespaced model ids', () => {
    expect(resolveProviderFromModelIndex(index, 'openai/gpt-5')).toEqual({
      provider: 'openai',
      source: 'model-prefix',
      candidates: ['openai', 'openrouter'],
    });
  });

  it('uses exact models.dev match for bare ids', () => {
    expect(resolveProviderFromModelIndex(index, 'claude-3-7-sonnet-latest')).toEqual({
      provider: 'anthropic',
      source: 'models.dev-exact',
      candidates: ['anthropic'],
    });
  });

  it('reports ambiguity for suffix-only matches', () => {
    expect(resolveProviderFromModelIndex(index, 'gpt-5')).toEqual({
      source: 'models.dev-suffix',
      candidates: ['openai', 'openrouter'],
    });
  });
});

describe('resolveProviderFromModelRegistry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetModelsDevCache();
  });

  it.each([
    undefined,
    '',
    '   ',
  ])('never fetches the models.dev catalog without a model (%j) (T13126)', async (model) => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveProviderFromModelRegistry(model)).toEqual({ source: 'none' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still looks a bare model up in the catalog', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ anthropic: { models: { 'claude-x': { id: 'claude-x' } } } })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveProviderFromModelRegistry('claude-x')).toMatchObject({
      provider: 'anthropic',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
