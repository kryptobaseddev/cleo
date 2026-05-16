/**
 * Unit tests for the `cleo llm refresh-catalog` runner.
 *
 * Covers:
 *   - Successful live fetch
 *   - Network failure → stale-cache fallback
 *   - No cache at all → failure envelope
 *
 * All disk I/O uses a temporary directory; the global `fetch` is stubbed
 * so the tests run offline.
 *
 * @task T9314
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLlmRefreshCatalog } from '../llm-refresh-catalog.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_CATALOG = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
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
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkFetch(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response);
}

function makeFailFetch(err = new Error('Network error')): typeof fetch {
  return vi.fn().mockRejectedValue(err);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLlmRefreshCatalog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-refresh-test-'));
    vi.stubGlobal('fetch', makeOkFetch(FIXTURE_CATALOG));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('returns success with live source on successful fetch', async () => {
    const result = await runLlmRefreshCatalog(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.source).toBe('live');
    expect(result.data.providers).toBeGreaterThan(0);
    expect(result.data.models).toBeGreaterThan(0);
    expect(result.data.filePath).toMatch(/\d+-models\.json$/);
  });

  it('counts providers correctly', async () => {
    const result = await runLlmRefreshCatalog(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // FIXTURE_CATALOG has 2 providers
    expect(result.data.providers).toBe(2);
  });

  it('counts models with valid context limits only', async () => {
    const result = await runLlmRefreshCatalog(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // 2 models in fixture both have context limits
    expect(result.data.models).toBe(2);
  });

  it('falls back to stale cache on network failure', async () => {
    // Pre-seed cache with a snapshot
    const ts = Date.now() - 1000;
    const snapshotPath = join(tmpDir, `${ts}-models.json`);
    writeFileSync(snapshotPath, JSON.stringify(FIXTURE_CATALOG), 'utf-8');

    vi.stubGlobal('fetch', makeFailFetch());

    const result = await runLlmRefreshCatalog(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.source).toBe('stale-cache');
    expect(result.data.filePath).toBe(snapshotPath);
  });

  it('returns failure when network fails and no cached snapshot exists', async () => {
    vi.stubGlobal('fetch', makeFailFetch());

    const result = await runLlmRefreshCatalog(tmpDir);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_CATALOG_UNAVAILABLE');
  });
});
