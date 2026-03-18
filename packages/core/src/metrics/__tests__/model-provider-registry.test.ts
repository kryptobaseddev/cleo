import { describe, expect, it } from 'vitest';
import { resolveProviderFromModelIndex } from '../model-provider-registry.js';

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
