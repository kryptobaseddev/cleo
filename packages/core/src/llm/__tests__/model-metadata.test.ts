/**
 * Unit tests for `getModelContextLength` / `getModelMetadata`.
 *
 * Covers all resolution tiers:
 *   - Tier 1: live catalog from catalog-cache (mocked)
 *   - Tier 1: stale-cache fallback from catalog-cache (mocked)
 *   - Tier 2: curated exact match
 *   - Tier 3: curated alias (date / version suffix stripped)
 *   - Tier 4: default fallback
 *
 * @task T9264
 * @task T9314
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3 + Phase 5)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock catalog-cache before importing model-metadata
// ---------------------------------------------------------------------------

const mockResolveContextIndex = vi.fn();

vi.mock('../catalog-cache.js', () => ({
  resolveContextIndex: (...args: unknown[]) => mockResolveContextIndex(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  _resetCatalogIndexCache,
  DEFAULT_CONTEXT_LENGTH,
  getModelContextLength,
  getModelMetadata,
} from '../model-metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Force the module-level catalog index cache to clear between tests. */
function resetCache(): void {
  _resetCatalogIndexCache();
  mockResolveContextIndex.mockReset();
}

// ---------------------------------------------------------------------------
// Tests — Tier 1: live catalog
// ---------------------------------------------------------------------------

describe('getModelMetadata — Tier 1: live catalog', () => {
  beforeEach(resetCache);
  afterEach(resetCache);

  it('returns source "live-catalog" when catalog index has an exact match', async () => {
    mockResolveContextIndex.mockResolvedValue({
      index: { 'test-model-live': 512_000 },
      source: 'live',
    });
    const meta = await getModelMetadata('test-model-live');
    expect(meta.source).toBe('live-catalog');
    expect(meta.contextLength).toBe(512_000);
    expect(meta.livePending).toBeUndefined();
  });

  it('returns source "stale-catalog" when catalog source is stale-cache', async () => {
    mockResolveContextIndex.mockResolvedValue({
      index: { 'test-model-stale': 300_000 },
      source: 'stale-cache',
    });
    const meta = await getModelMetadata('test-model-stale');
    expect(meta.source).toBe('stale-catalog');
    expect(meta.contextLength).toBe(300_000);
  });

  it('falls through to curated tier when model not in catalog index', async () => {
    mockResolveContextIndex.mockResolvedValue({
      index: { 'other-model': 128_000 },
      source: 'live',
    });
    // claude-haiku-4-5-20251001 is in the bundled curated table
    const meta = await getModelMetadata('claude-haiku-4-5-20251001');
    expect(meta.source).toBe('curated');
    expect(meta.contextLength).toBe(200_000);
  });

  it('falls through to default when catalog returns null', async () => {
    mockResolveContextIndex.mockResolvedValue(null);
    const meta = await getModelMetadata('unknown-model-no-catalog');
    expect(meta.source).toBe('default');
    expect(meta.contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it('catalog index result is cached in-process (resolveContextIndex called once)', async () => {
    mockResolveContextIndex.mockResolvedValue({
      index: { 'cached-model': 100_000 },
      source: 'live',
    });
    await getModelMetadata('cached-model');
    await getModelMetadata('cached-model');
    expect(mockResolveContextIndex).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — Tier 2 / 3 / 4: bundled curated table (catalog returns null)
// ---------------------------------------------------------------------------

describe('getModelContextLength — curated tiers', () => {
  beforeEach(() => {
    resetCache();
    // Disable Tier 1 so curated tiers are exercised.
    mockResolveContextIndex.mockResolvedValue(null);
  });
  afterEach(resetCache);

  it('returns 200000 for claude-haiku-4-5-20251001 (exact curated match)', async () => {
    await expect(getModelContextLength('claude-haiku-4-5-20251001')).resolves.toBe(200_000);
  });

  it('returns 128000 for gpt-4o (exact curated match)', async () => {
    await expect(getModelContextLength('gpt-4o')).resolves.toBe(128_000);
  });

  it('returns 200000 for claude-sonnet-4-6 (exact curated match, no date suffix)', async () => {
    await expect(getModelContextLength('claude-sonnet-4-6')).resolves.toBe(200_000);
  });

  it('returns 200000 for claude-sonnet-4-6-20260101 (alias: date suffix stripped)', async () => {
    // claude-sonnet-4-6-20260101 strips to claude-sonnet-4-6 which is in the curated table
    await expect(getModelContextLength('claude-sonnet-4-6-20260101')).resolves.toBe(200_000);
  });

  it('returns DEFAULT_CONTEXT_LENGTH for an unknown model', async () => {
    await expect(getModelContextLength('unknown-model-xyz')).resolves.toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it('DEFAULT_CONTEXT_LENGTH is 256000', () => {
    expect(DEFAULT_CONTEXT_LENGTH).toBe(256_000);
  });
});

describe('getModelMetadata — curated tiers', () => {
  beforeEach(() => {
    resetCache();
    mockResolveContextIndex.mockResolvedValue(null);
  });
  afterEach(resetCache);

  it('returns source "curated" for an exact curated match', async () => {
    const meta = await getModelMetadata('claude-haiku-4-5-20251001');
    expect(meta.source).toBe('curated');
    expect(meta.contextLength).toBe(200_000);
  });

  it('returns source "curated-alias" for a date-stripped alias', async () => {
    // claude-sonnet-4-6-20300101 → strip -20300101 → claude-sonnet-4-6 (IS in table)
    const meta = await getModelMetadata('claude-sonnet-4-6-20300101');
    expect(meta.source).toBe('curated-alias');
    expect(meta.contextLength).toBe(200_000);
  });

  it('returns source "default" and DEFAULT_CONTEXT_LENGTH for unknown model', async () => {
    const meta = await getModelMetadata('unknown-model-xyz');
    expect(meta.source).toBe('default');
    expect(meta.contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it('curated result no longer sets livePending (Tier 1 now implemented)', async () => {
    const meta = await getModelMetadata('gpt-4o');
    expect(meta.livePending).toBeUndefined();
  });
});
