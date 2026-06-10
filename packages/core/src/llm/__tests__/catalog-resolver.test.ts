/**
 * T11737 — `resolveCatalogEntry()` table-first read chokepoint with the disk-cache
 * + shipped-seed fallback chain (offline-first degrade).
 *
 * Every test uses a TEMP-DIR global cleo.db + a temp cache dir — never `.cleo/*.db`
 * and NO network.
 *
 * @task T11737
 * @epic T11694
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CuratedCatalog } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CleoGlobalDb } from '../../store/dual-scope-db.js';
import { _resetDualScopeDbCache } from '../../store/dual-scope-db.js';
import {
  _resetCatalogResolverCache,
  openCatalogAtPath,
  resolveCatalogEntry,
} from '../catalog-resolver.js';
import { seedModelsCatalog } from '../catalog-seeder.js';

let testRoot: string;
let cacheDir: string;

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `catalog-resolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  cacheDir = join(testRoot, 'cache');
  mkdirSync(testRoot, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  _resetCatalogResolverCache();
});

afterEach(() => {
  _resetDualScopeDbCache();
  _resetCatalogResolverCache();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** A fixture catalog with two anthropic models of differing release_date. */
function fixture(newId: string, newDate: string): CuratedCatalog {
  return {
    version: '1.0.0',
    lastUpdated: '2026-06-09',
    providers: {
      anthropic: { id: 'anthropic', endpoint: 'https://api.anthropic.com', authTypes: ['api_key'] },
    },
    models: {
      anthropic: {
        'claude-old': {
          id: 'claude-old',
          name: 'Old',
          family: 'claude',
          attachment: false,
          reasoning: false,
          temperature: true,
          interleaved: false,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          cost: {},
          limit: { context: 200000, output: 64000 },
          status: 'stable',
          release_date: '2024-01-01',
          provider: { npm: '@anthropic-ai/sdk', api: 'anthropic_messages' },
        },
        [newId]: {
          id: newId,
          name: 'New',
          family: 'claude',
          attachment: true,
          reasoning: true,
          temperature: true,
          interleaved: true,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          cost: {},
          limit: { context: 200000, output: 64000 },
          status: 'stable',
          release_date: newDate,
          provider: { npm: '@anthropic-ai/sdk', api: 'anthropic_messages' },
        },
      },
    },
  };
}

async function openDb(): Promise<CleoGlobalDb> {
  return openCatalogAtPath(join(testRoot, 'cleo.db'));
}

/** Write a models.dev-shaped disk-cache snapshot into the temp cache dir. */
function writeDiskCache(modelId: string, releaseDate: string): void {
  const snapshot = {
    anthropic: {
      id: 'anthropic',
      models: {
        [modelId]: { id: modelId, release_date: releaseDate, limit: { context: 200000 } },
      },
    },
  };
  writeFileSync(join(cacheDir, `${Date.now()}-models.json`), JSON.stringify(snapshot), 'utf-8');
}

describe('resolveCatalogEntry (T11737) — table-first chokepoint', () => {
  it('TABLE-FIRST: returns the newest-release_date row from the seeded table', async () => {
    const db = await openDb();
    await seedModelsCatalog({ db, catalog: fixture('claude-table-new', '2026-05-01') });
    // Even with a disk cache present, the TABLE wins.
    writeDiskCache('claude-cache-new', '2026-12-01');

    const entry = await resolveCatalogEntry('anthropic', { db, cacheDir });
    expect(entry?.source).toBe('table');
    expect(entry?.id).toBe('claude-table-new');
    expect(entry?.releaseDate).toBe('2026-05-01');
  }, 30_000);

  it('DISK FALLBACK: empty table → resolves the newest entry from the disk cache mirror', async () => {
    const db = await openDb(); // migrated, but NOT seeded → table empty.
    writeDiskCache('claude-cache-new', '2026-03-01');

    const entry = await resolveCatalogEntry('anthropic', { db, cacheDir });
    expect(entry?.source).toBe('disk-cache');
    expect(entry?.id).toBe('claude-cache-new');
    expect(entry?.releaseDate).toBe('2026-03-01');
  }, 30_000);

  it('SEED FLOOR: empty table + empty cache → resolves from the shipped seed', async () => {
    const db = await openDb(); // empty table, empty cacheDir.
    const entry = await resolveCatalogEntry('anthropic', { db, cacheDir });
    expect(entry?.source).toBe('shipped-seed');
    // The shipped curated-catalog.json carries dated anthropic models.
    expect(entry?.id.length).toBeGreaterThan(0);
    expect(entry?.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 30_000);

  it('returns null for a provider absent from every surface', async () => {
    const db = await openDb();
    const entry = await resolveCatalogEntry('no-such-provider', { db, cacheDir });
    expect(entry).toBeNull();
  }, 30_000);
});
