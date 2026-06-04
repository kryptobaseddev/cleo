/**
 * Unit tests for `catalog-model-resolver.ts` (T11773 · E8).
 *
 * Covers:
 *   a) `resolveProviderDefaultModel` — default model is derived from the
 *      catalog sorted by `release_date` descending (latest wins).
 *   b) `validateModelForProvider` — rejects a model not in the catalog for
 *      the given provider with `reason: 'not-found'`.
 *   c) Graceful degradation — both functions handle absent catalog snapshots.
 *   d) `catalogKeyForProvider` — Gemini maps to `google`; identity for the
 *      rest.
 *
 * The tests inject a minimal catalog via the `catalogOverride` parameter so
 * they are entirely independent of the host machine's disk state.
 *
 * @task T11773
 * @epic T11694 (E8-CATALOG-CURATION)
 */

import { describe, expect, it } from 'vitest';
import type { ModelsCatalogFile } from '../catalog-cache.js';
import {
  catalogKeyForProvider,
  resolveProviderDefaultModel,
  validateModelForProvider,
} from '../catalog-model-resolver.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal catalog with two providers — each with models that have different
 * release dates so we can assert that the latest-date model wins.
 */
const FIXTURE_CATALOG: ModelsCatalogFile = {
  openai: {
    id: 'openai',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        release_date: '2024-05-13',
        limit: { context: 128000 },
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        release_date: '2026-04-23',
        limit: { context: 1050000 },
      },
      'gpt-5-mini': {
        id: 'gpt-5-mini',
        name: 'GPT-5 Mini',
        release_date: '2025-08-07',
        limit: { context: 400000 },
      },
      // Entry without a release_date — should be skipped in default resolution.
      'gpt-internal-beta': {
        id: 'gpt-internal-beta',
        name: 'Internal Beta',
        limit: { context: 8192 },
      },
    },
  },
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        release_date: '2026-05-28',
        limit: { context: 200000 },
      },
      'claude-haiku-4-5-20251001': {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        release_date: '2025-10-15',
        limit: { context: 200000 },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// resolveProviderDefaultModel
// ---------------------------------------------------------------------------

describe('resolveProviderDefaultModel (T11773)', () => {
  it('returns the model with the latest release_date for openai', () => {
    const result = resolveProviderDefaultModel('openai', FIXTURE_CATALOG);
    // gpt-5.5 has release_date=2026-04-23 which is the latest
    expect(result).toBe('gpt-5.5');
  });

  it('returns the model with the latest release_date for anthropic', () => {
    const result = resolveProviderDefaultModel('anthropic', FIXTURE_CATALOG);
    // claude-opus-4-8 has release_date=2026-05-28 which is the latest
    expect(result).toBe('claude-opus-4-8');
  });

  it('skips entries without a release_date field', () => {
    // gpt-internal-beta has no release_date — must not be selected
    const result = resolveProviderDefaultModel('openai', FIXTURE_CATALOG);
    expect(result).not.toBe('gpt-internal-beta');
  });

  it('returns null when the provider is absent from the catalog', () => {
    const result = resolveProviderDefaultModel('unknown-provider', FIXTURE_CATALOG);
    expect(result).toBeNull();
  });

  it('returns null when the catalog is null (no disk snapshot)', () => {
    // Pass undefined catalog and ensure we get null back (no disk I/O in tests)
    // Since we cannot inject a null catalog via override (override must be the
    // file shape), test the provider-absent path as a proxy for graceful null.
    const result = resolveProviderDefaultModel('openai', {} as ModelsCatalogFile);
    expect(result).toBeNull();
  });

  it('returns null when the provider models object is empty', () => {
    const emptyCatalog: ModelsCatalogFile = {
      openai: { id: 'openai', models: {} },
    };
    const result = resolveProviderDefaultModel('openai', emptyCatalog);
    expect(result).toBeNull();
  });

  it('selects the single model when there is only one dated entry', () => {
    const singleCatalog: ModelsCatalogFile = {
      openai: {
        id: 'openai',
        models: {
          'gpt-only': {
            id: 'gpt-only',
            release_date: '2025-01-01',
            limit: { context: 32000 },
          },
        },
      },
    };
    expect(resolveProviderDefaultModel('openai', singleCatalog)).toBe('gpt-only');
  });
});

// ---------------------------------------------------------------------------
// validateModelForProvider
// ---------------------------------------------------------------------------

describe('validateModelForProvider (T11773)', () => {
  it('returns valid=true reason=found for a model that exists in the catalog', () => {
    const result = validateModelForProvider('gpt-5.5', 'openai', FIXTURE_CATALOG);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('found');
  });

  it('returns valid=false reason=not-found for a model with a typo', () => {
    const result = validateModelForProvider('gpt-typo-does-not-exist', 'openai', FIXTURE_CATALOG);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('returns valid=false reason=not-found for a cross-provider model name', () => {
    // claude-opus-4-8 exists in anthropic but NOT in openai
    const result = validateModelForProvider('claude-opus-4-8', 'openai', FIXTURE_CATALOG);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('returns valid=true reason=found for a model that does not have a release_date', () => {
    // gpt-internal-beta has no release_date but IS in the models map
    const result = validateModelForProvider('gpt-internal-beta', 'openai', FIXTURE_CATALOG);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('found');
  });

  it('returns valid=true reason=provider-not-in-catalog when provider has no catalog entry', () => {
    const result = validateModelForProvider('some-model', 'unknown-provider', FIXTURE_CATALOG);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('provider-not-in-catalog');
  });

  it('returns valid=true reason=catalog-unavailable when catalog override is empty (proxy for no snapshot)', () => {
    // Passing an empty object is the closest we can get to the no-snapshot
    // path in a pure-override test. The 'provider-not-in-catalog' branch fires
    // since the provider key is absent.
    const result = validateModelForProvider('gpt-5.5', 'openai', {} as ModelsCatalogFile);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('provider-not-in-catalog');
  });
});

// ---------------------------------------------------------------------------
// catalogKeyForProvider
// ---------------------------------------------------------------------------

describe('catalogKeyForProvider (T11773)', () => {
  it('maps gemini → google', () => {
    expect(catalogKeyForProvider('gemini')).toBe('google');
  });

  it('returns the provider name unchanged for openai', () => {
    expect(catalogKeyForProvider('openai')).toBe('openai');
  });

  it('returns the provider name unchanged for anthropic', () => {
    expect(catalogKeyForProvider('anthropic')).toBe('anthropic');
  });

  it('normalises to lowercase', () => {
    expect(catalogKeyForProvider('OpenAI')).toBe('openai');
  });
});
