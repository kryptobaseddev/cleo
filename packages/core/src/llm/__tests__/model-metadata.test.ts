/**
 * Unit tests for `getModelContextLength` / `getModelMetadata`.
 *
 * Covers all resolution tiers:
 *   - Tier 1: disk catalog snapshot from catalog-cache (mocked)
 *   - Tier 2: curated exact match
 *   - Tier 3: curated alias (date / version suffix stripped)
 *   - Tier 4: default fallback
 *
 * The catalog-cache module is mocked so tests run without touching the
 * filesystem or network.
 *
 * @task T9264
 * @task T9314
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3 + Phase 5)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock catalog-cache before importing model-metadata
// ---------------------------------------------------------------------------

const mockLoadDiskCatalogIndex = vi.fn();

vi.mock('../catalog-cache.js', () => ({
  loadDiskCatalogIndex: (...args: unknown[]) => mockLoadDiskCatalogIndex(...args),
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
  mockLoadDiskCatalogIndex.mockReset();
}

// ---------------------------------------------------------------------------
// Tests — Tier 1: disk catalog
// ---------------------------------------------------------------------------

describe('getModelMetadata — Tier 1: disk catalog', () => {
  beforeEach(resetCache);
  afterEach(resetCache);

  it('returns source "disk-catalog" when disk index has an exact match', async () => {
    mockLoadDiskCatalogIndex.mockReturnValue({
      index: { 'test-model-cached': 512_000 },
      source: 'disk-cache',
    });
    const meta = await getModelMetadata('test-model-cached');
    expect(meta.source).toBe('disk-catalog');
    expect(meta.contextLength).toBe(512_000);
    expect(meta.livePending).toBeUndefined();
  });

  it('falls through to curated tier when model not in disk index', async () => {
    mockLoadDiskCatalogIndex.mockReturnValue({
      index: { 'other-model': 128_000 },
      source: 'disk-cache',
    });
    // claude-haiku-4-5-20251001 is in the bundled curated table
    const meta = await getModelMetadata('claude-haiku-4-5-20251001');
    expect(meta.source).toBe('curated');
    expect(meta.contextLength).toBe(200_000);
  });

  it('falls through to default when disk catalog returns null', async () => {
    mockLoadDiskCatalogIndex.mockReturnValue(null);
    const meta = await getModelMetadata('unknown-model-no-catalog');
    expect(meta.source).toBe('default');
    expect(meta.contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it('disk index result is cached in-process (loadDiskCatalogIndex called once)', async () => {
    mockLoadDiskCatalogIndex.mockReturnValue({
      index: { 'cached-model': 100_000 },
      source: 'disk-cache',
    });
    await getModelMetadata('cached-model');
    await getModelMetadata('cached-model');
    expect(mockLoadDiskCatalogIndex).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — Tier 2 / 3 / 4: bundled curated table (disk catalog returns null)
// ---------------------------------------------------------------------------

describe('getModelContextLength — curated tiers', () => {
  beforeEach(() => {
    resetCache();
    // Disable Tier 1 so curated tiers are exercised.
    mockLoadDiskCatalogIndex.mockReturnValue(null);
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
    mockLoadDiskCatalogIndex.mockReturnValue(null);
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

  it('curated result does not set livePending', async () => {
    const meta = await getModelMetadata('gpt-4o');
    expect(meta.livePending).toBeUndefined();
  });
});
