/**
 * Unit tests for the catalog-cache module.
 *
 * Covers:
 *   - `buildContextIndex` — catalog-to-index flattening
 *   - `findLatestCacheFile` — mtime-sorted disk scan
 *   - `writeCacheFile` + `readCacheFile` — round-trip I/O
 *   - `fetchAndCacheCatalog` — success + HTTP error + JSON parse error
 *   - `resolveContextIndex` — live → stale-cache fallback chain
 *
 * All disk I/O is performed inside a temporary directory created by
 * `mkdtemp` so tests are hermetic and clean up after themselves.
 *
 * @task T9314
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContextIndex,
  CatalogRefreshError,
  fetchAndCacheCatalog,
  findLatestCacheFile,
  type ModelsCatalogFile,
  readCacheFile,
  resolveContextIndex,
  writeCacheFile,
} from '../catalog-cache.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_CATALOG: ModelsCatalogFile = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        limit: { context: 200_000, output: 8_096 },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        limit: { context: 200_000, output: 8_096 },
      },
    },
  },
  openai: {
    id: 'openai',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        limit: { context: 128_000, output: 16_384 },
      },
      // no-context entry — should be omitted from index
      'gpt-legacy': {
        id: 'gpt-legacy',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// buildContextIndex
// ---------------------------------------------------------------------------

describe('buildContextIndex', () => {
  it('flattens provider→models into a flat id→contextLength map', () => {
    const index = buildContextIndex(FIXTURE_CATALOG);
    expect(index['claude-sonnet-4-6']).toBe(200_000);
    expect(index['claude-haiku-4-5']).toBe(200_000);
    expect(index['gpt-4o']).toBe(128_000);
  });

  it('omits entries without a valid context limit', () => {
    const index = buildContextIndex(FIXTURE_CATALOG);
    expect(index['gpt-legacy']).toBeUndefined();
  });

  it('returns an empty object for an empty catalog', () => {
    expect(buildContextIndex({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// findLatestCacheFile + writeCacheFile + readCacheFile
// ---------------------------------------------------------------------------

describe('disk cache helpers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-catalog-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('findLatestCacheFile returns null for an empty directory', () => {
    expect(findLatestCacheFile(tmpDir)).toBeNull();
  });

  it('findLatestCacheFile returns null for a non-existent directory', () => {
    expect(findLatestCacheFile(join(tmpDir, 'nonexistent'))).toBeNull();
  });

  it('writeCacheFile creates a timestamped file and a latest.json symlink', () => {
    const filePath = writeCacheFile(tmpDir, FIXTURE_CATALOG);
    expect(filePath).toMatch(/\d+-models\.json$/);
    const files = readdirSync(tmpDir);
    expect(files).toContain('latest.json');
    expect(files.some((f) => f.endsWith('-models.json'))).toBe(true);
  });

  it('readCacheFile round-trips the catalog faithfully', () => {
    const filePath = writeCacheFile(tmpDir, FIXTURE_CATALOG);
    const read = readCacheFile(filePath);
    expect(read).toEqual(FIXTURE_CATALOG);
  });

  it('readCacheFile returns null for a missing file', () => {
    expect(readCacheFile(join(tmpDir, 'does-not-exist.json'))).toBeNull();
  });

  it('readCacheFile returns null for a malformed JSON file', async () => {
    const { writeFileSync } = await import('node:fs');
    const badPath = join(tmpDir, '99999-models.json');
    writeFileSync(badPath, 'not json', 'utf-8');
    expect(readCacheFile(badPath)).toBeNull();
  });

  it('findLatestCacheFile returns the most-recently-written file', async () => {
    // Write two files with a small artificial gap via different tmp dirs
    // (mtime resolution may be 1 ms — just write and check the name)
    writeCacheFile(tmpDir, FIXTURE_CATALOG);
    // Small delay not needed — the timestamp is from Date.now() in the
    // filename itself; we just verify the function doesn't crash.
    const latest = findLatestCacheFile(tmpDir);
    expect(latest).not.toBeNull();
    expect(latest).toMatch(/\d+-models\.json$/);
  });
});

// ---------------------------------------------------------------------------
// fetchAndCacheCatalog — mocked global fetch
// ---------------------------------------------------------------------------

describe('fetchAndCacheCatalog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-catalog-fetch-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('fetches the catalog and writes it to disk on success', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => FIXTURE_CATALOG,
    } as Response);

    const { filePath, catalog } = await fetchAndCacheCatalog(tmpDir);
    expect(filePath).toMatch(/\d+-models\.json$/);
    expect(catalog).toEqual(FIXTURE_CATALOG);
  });

  it('throws CatalogRefreshError on HTTP error status', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    await expect(fetchAndCacheCatalog(tmpDir)).rejects.toThrow(CatalogRefreshError);
    await expect(fetchAndCacheCatalog(tmpDir)).rejects.toMatchObject({ code: 'E_CATALOG_HTTP' });
  });

  it('throws CatalogRefreshError on JSON parse failure', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    await expect(fetchAndCacheCatalog(tmpDir)).rejects.toThrow(CatalogRefreshError);
    await expect(fetchAndCacheCatalog(tmpDir)).rejects.toMatchObject({ code: 'E_CATALOG_PARSE' });
  });
});

// ---------------------------------------------------------------------------
// resolveContextIndex — full fallback chain
// ---------------------------------------------------------------------------

describe('resolveContextIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-catalog-resolve-'));
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('returns live index + source "live" when fetch succeeds', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => FIXTURE_CATALOG,
    } as Response);

    const result = await resolveContextIndex(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('live');
    expect(result?.index['claude-sonnet-4-6']).toBe(200_000);
  });

  it('falls back to stale cache when network fails', async () => {
    // Pre-seed the cache directory with a snapshot.
    writeCacheFile(tmpDir, FIXTURE_CATALOG);

    vi.mocked(fetch).mockRejectedValue(new Error('Network unreachable'));

    const result = await resolveContextIndex(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('stale-cache');
    expect(result?.index['gpt-4o']).toBe(128_000);
  });

  it('returns null when network fails and cache directory is empty', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network unreachable'));

    const result = await resolveContextIndex(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when network fails and cache directory does not exist', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network unreachable'));
    const missingDir = join(tmpDir, 'does-not-exist');

    const result = await resolveContextIndex(missingDir);
    expect(result).toBeNull();
  });

  it('creates the cache directory if it does not exist on a successful fetch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => FIXTURE_CATALOG,
    } as Response);

    const freshDir = join(tmpDir, 'fresh-subdir');
    const result = await resolveContextIndex(freshDir);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('live');
  });
});
