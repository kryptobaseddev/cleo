/**
 * Unit tests for the multi-provider auxiliary fallback chain (T9319).
 *
 * Uses injected mock providers — no network calls.
 *
 * @task T9319
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { NormalizedResponse } from '@cleocode/contracts/llm/normalized-response.js';
import { describe, expect, it } from 'vitest';
import {
  AllProvidersExhaustedError,
  type AuxiliaryFallbackChain,
  type AuxiliaryProvider,
  DEFAULT_AUXILIARY_FALLBACK_CHAIN,
  parseAuxiliaryFallbackChain,
  runAuxiliaryWithFallback,
} from '../auxiliary-fallback.js';
import { PoolExhaustedError } from '../credential-pool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(provider: string): NormalizedResponse {
  return {
    id: `resp-${provider}`,
    model: `model-${provider}`,
    content: `Hello from ${provider}`,
    toolCalls: null,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: {},
  };
}

function makeMessages() {
  return [{ role: 'user' as const, content: 'ping' }];
}

/** Provider that always succeeds. */
function successProvider(provider: string): AuxiliaryProvider {
  return async (_entry, _messages, _opts) => makeResponse(provider);
}

/** Provider that always throws PoolExhaustedError. */
function exhaustedProvider(provider: string): AuxiliaryProvider {
  return async (entry, _messages, _opts) => {
    throw new PoolExhaustedError(entry.provider, 1, Date.now() + 60_000);
  };
}

/** Provider that always throws a generic network error. */
function networkErrorProvider(message: string): AuxiliaryProvider {
  return async (_entry, _messages, _opts) => {
    const err = new Error(message);
    (err as Error & { status?: number }).status = 500;
    throw err;
  };
}

/** Provider that succeeds on the Nth call (0-indexed). */
function succeedOnCallProvider(successCallIndex: number, provider: string): AuxiliaryProvider {
  let callCount = 0;
  return async (entry, _messages, _opts) => {
    const idx = callCount++;
    if (idx === successCallIndex) return makeResponse(provider);
    throw new PoolExhaustedError(entry.provider, 1, Date.now() + 60_000);
  };
}

/** Dispatch provider: each entry in the chain gets its own mock. */
function perProviderDispatch(providerMap: Record<string, AuxiliaryProvider>): AuxiliaryProvider {
  return async (entry, messages, opts) => {
    const mock = providerMap[entry.provider];
    if (!mock) throw new PoolExhaustedError(entry.provider, 0, 0);
    return mock(entry, messages, opts);
  };
}

// ---------------------------------------------------------------------------
// runAuxiliaryWithFallback
// ---------------------------------------------------------------------------

describe('runAuxiliaryWithFallback', () => {
  it('returns response immediately when first provider succeeds', async () => {
    const chain: AuxiliaryFallbackChain = [{ provider: 'anthropic' }, { provider: 'openrouter' }];
    const result = await runAuxiliaryWithFallback(
      chain,
      makeMessages(),
      undefined,
      successProvider('anthropic'),
    );

    expect(result.content).toBe('Hello from anthropic');
    expect(result.meta.fallbackChain).toHaveLength(1);
    expect(result.meta.fallbackChain[0]).toMatchObject({
      provider: 'anthropic',
      outcome: 'success',
    });
  });

  it('falls back to second provider when first pool is exhausted', async () => {
    const chain: AuxiliaryFallbackChain = [{ provider: 'anthropic' }, { provider: 'openrouter' }];
    const provider = perProviderDispatch({
      anthropic: exhaustedProvider('anthropic'),
      openrouter: successProvider('openrouter'),
    });

    const result = await runAuxiliaryWithFallback(chain, makeMessages(), undefined, provider);

    expect(result.content).toBe('Hello from openrouter');
    expect(result.meta.fallbackChain).toHaveLength(2);
    expect(result.meta.fallbackChain[0]).toMatchObject({
      provider: 'anthropic',
      outcome: 'pool_exhausted',
    });
    expect(result.meta.fallbackChain[1]).toMatchObject({
      provider: 'openrouter',
      outcome: 'success',
    });
  });

  it('falls back through two providers to the third', async () => {
    const chain: AuxiliaryFallbackChain = [
      { provider: 'anthropic' },
      { provider: 'openrouter' },
      { provider: 'groq' },
    ];
    const provider = perProviderDispatch({
      anthropic: exhaustedProvider('anthropic'),
      openrouter: exhaustedProvider('openrouter'),
      groq: successProvider('groq'),
    });

    const result = await runAuxiliaryWithFallback(chain, makeMessages(), undefined, provider);

    expect(result.content).toBe('Hello from groq');
    expect(result.meta.fallbackChain).toHaveLength(3);
    expect(result.meta.fallbackChain[2]).toMatchObject({
      provider: 'groq',
      outcome: 'success',
    });
  });

  it('throws AllProvidersExhaustedError when entire chain is exhausted', async () => {
    const chain: AuxiliaryFallbackChain = [
      { provider: 'anthropic' },
      { provider: 'openrouter' },
      { provider: 'groq' },
    ];

    await expect(
      runAuxiliaryWithFallback(chain, makeMessages(), undefined, exhaustedProvider('any')),
    ).rejects.toBeInstanceOf(AllProvidersExhaustedError);
  });

  it('AllProvidersExhaustedError carries all steps', async () => {
    const chain: AuxiliaryFallbackChain = [{ provider: 'anthropic' }, { provider: 'openrouter' }];

    let caught: AllProvidersExhaustedError | null = null;
    try {
      await runAuxiliaryWithFallback(chain, makeMessages(), undefined, exhaustedProvider('any'));
    } catch (err) {
      if (err instanceof AllProvidersExhaustedError) caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.steps).toHaveLength(2);
    expect(caught!.steps.map((s) => s.provider)).toEqual(['anthropic', 'openrouter']);
    expect(caught!.steps.every((s) => s.outcome === 'pool_exhausted')).toBe(true);
    expect(caught!.code).toBe('E_LLM_ALL_PROVIDERS_EXHAUSTED');
  });

  it('also falls back on generic non-pool errors (network/5xx)', async () => {
    const chain: AuxiliaryFallbackChain = [{ provider: 'anthropic' }, { provider: 'openrouter' }];
    const provider = perProviderDispatch({
      anthropic: networkErrorProvider('connection refused'),
      openrouter: successProvider('openrouter'),
    });

    const result = await runAuxiliaryWithFallback(chain, makeMessages(), undefined, provider);

    expect(result.content).toBe('Hello from openrouter');
    expect(result.meta.fallbackChain[0]).toMatchObject({
      provider: 'anthropic',
      outcome: 'error',
      errorMessage: 'connection refused',
    });
  });

  it('throws AllProvidersExhaustedError on empty chain', async () => {
    await expect(
      runAuxiliaryWithFallback([], makeMessages(), undefined, successProvider('x')),
    ).rejects.toBeInstanceOf(AllProvidersExhaustedError);
  });

  it('attaches meta to providerData on the response', async () => {
    const chain: AuxiliaryFallbackChain = [{ provider: 'anthropic' }];
    const result = await runAuxiliaryWithFallback(
      chain,
      makeMessages(),
      undefined,
      successProvider('anthropic'),
    );

    expect(result.providerData).toBeDefined();
    expect(result.providerData!['__fallbackMeta']).toEqual(result.meta);
  });
});

// ---------------------------------------------------------------------------
// parseAuxiliaryFallbackChain
// ---------------------------------------------------------------------------

describe('parseAuxiliaryFallbackChain', () => {
  it('parses comma-separated providers', () => {
    const chain = parseAuxiliaryFallbackChain('anthropic,openrouter,groq');
    expect(chain).toHaveLength(3);
    expect(chain[0]).toEqual({ provider: 'anthropic' });
    expect(chain[1]).toEqual({ provider: 'openrouter' });
    expect(chain[2]).toEqual({ provider: 'groq' });
  });

  it('parses provider:model syntax', () => {
    const chain = parseAuxiliaryFallbackChain(
      'anthropic:claude-haiku-4-5-20251001,openrouter,groq:llama-3.1-8b',
    );
    expect(chain[0]).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(chain[1]).toEqual({ provider: 'openrouter' });
    expect(chain[2]).toEqual({ provider: 'groq', model: 'llama-3.1-8b' });
  });

  it('trims whitespace around entries', () => {
    const chain = parseAuxiliaryFallbackChain(' anthropic , openrouter , groq ');
    expect(chain.map((e) => e.provider)).toEqual(['anthropic', 'openrouter', 'groq']);
  });

  it('falls back to default chain on empty input', () => {
    const chain = parseAuxiliaryFallbackChain('');
    expect(chain).toEqual(DEFAULT_AUXILIARY_FALLBACK_CHAIN);
  });

  it('falls back to default chain on whitespace-only input', () => {
    const chain = parseAuxiliaryFallbackChain('   ');
    expect(chain).toEqual(DEFAULT_AUXILIARY_FALLBACK_CHAIN);
  });

  it('silently drops empty entries from comma list', () => {
    const chain = parseAuxiliaryFallbackChain('anthropic,,groq');
    expect(chain.map((e) => e.provider)).toEqual(['anthropic', 'groq']);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_AUXILIARY_FALLBACK_CHAIN
// ---------------------------------------------------------------------------

describe('DEFAULT_AUXILIARY_FALLBACK_CHAIN', () => {
  it('has at least 3 providers', () => {
    expect(DEFAULT_AUXILIARY_FALLBACK_CHAIN.length).toBeGreaterThanOrEqual(3);
  });

  it('starts with anthropic', () => {
    expect(DEFAULT_AUXILIARY_FALLBACK_CHAIN[0]?.provider).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// AllProvidersExhaustedError
// ---------------------------------------------------------------------------

describe('AllProvidersExhaustedError', () => {
  it('has stable error code', () => {
    const err = new AllProvidersExhaustedError([]);
    expect(err.code).toBe('E_LLM_ALL_PROVIDERS_EXHAUSTED');
    expect(err.name).toBe('AllProvidersExhaustedError');
  });

  it('includes provider names in message', () => {
    const err = new AllProvidersExhaustedError([
      { provider: 'anthropic', outcome: 'pool_exhausted' },
      { provider: 'groq', outcome: 'error', errorMessage: 'timeout' },
    ]);
    expect(err.message).toContain('anthropic');
    expect(err.message).toContain('groq');
  });
});
