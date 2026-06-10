/**
 * T11734 — `seedModelsCatalog` populates `models_catalog` from the shipped offline
 * seed, idempotently, with version-skip semantics.
 *
 * Every test seeds a TEMP-DIR global cleo.db — never `.cleo/*.db` and NO network.
 *
 * @task T11734
 * @epic T11694
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CuratedCatalog } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CleoGlobalDb } from '../../store/dual-scope-db.js';
import { _resetDualScopeDbCache } from '../../store/dual-scope-db.js';
import {
  flattenCatalogToRows,
  loadAndValidateSeed,
  openSeederAtPath,
  seedModelsCatalog,
} from '../catalog-seeder.js';

let testRoot: string;

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `catalog-seed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  _resetDualScopeDbCache();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** A minimal two-row fixture catalog (anthropic, differing dates). */
function fixture(version: string): CuratedCatalog {
  return {
    version,
    lastUpdated: '2026-06-09',
    providers: {
      anthropic: { id: 'anthropic', endpoint: 'https://api.anthropic.com', authTypes: ['api_key'] },
    },
    models: {
      anthropic: {
        'claude-old': {
          id: 'claude-old',
          name: 'Claude Old',
          family: 'claude',
          attachment: true,
          reasoning: true,
          temperature: true,
          interleaved: false,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          cost: { input: 1, output: 5 },
          limit: { context: 200000, output: 64000 },
          status: 'stable',
          release_date: '2025-01-01',
          provider: { npm: '@anthropic-ai/sdk', api: 'anthropic_messages' },
        },
        'claude-new': {
          id: 'claude-new',
          name: 'Claude New',
          family: 'claude',
          attachment: true,
          reasoning: true,
          temperature: true,
          interleaved: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          cost: { input: 3, output: 15 },
          limit: { context: 200000, output: 64000 },
          status: 'stable',
          release_date: '2026-02-01',
          provider: { npm: '@anthropic-ai/sdk', api: 'anthropic_messages' },
        },
      },
    },
  };
}

async function open(): Promise<{ db: CleoGlobalDb; native: DatabaseSync }> {
  const db = await openSeederAtPath(join(testRoot, 'cleo.db'));
  const native = (db as unknown as { $client: DatabaseSync }).$client;
  return { db, native };
}

function rowCount(native: DatabaseSync): number {
  const r = native.prepare('SELECT COUNT(*) AS c FROM models_catalog').get() as { c: number };
  return r.c;
}

describe('seedModelsCatalog (T11734)', () => {
  it('seeds the fixture rows into models_catalog and round-trips capability fields', async () => {
    const { db, native } = await open();
    const result = await seedModelsCatalog({ db, catalog: fixture('1.0.0') });

    expect(result.seeded).toBe(true);
    expect(result.reason).toBe('seeded');
    expect(result.rowCount).toBe(2);
    expect(rowCount(native)).toBe(2);

    const newRow = native
      .prepare(
        'SELECT provider_id, family, interleaved, modalities, context_limit, release_date FROM models_catalog WHERE id = ?',
      )
      .get('claude-new') as Record<string, unknown>;
    expect(newRow.provider_id).toBe('anthropic');
    expect(newRow.family).toBe('claude');
    expect(newRow.interleaved).toBe(1);
    expect(newRow.context_limit).toBe(200000);
    expect(newRow.release_date).toBe('2026-02-01');
    expect(JSON.parse(newRow.modalities as string)).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
  }, 30_000);

  it('is idempotent — running twice with the same version yields the same row count and no duplicates', async () => {
    const { db, native } = await open();
    await seedModelsCatalog({ db, catalog: fixture('1.0.0') });
    const first = rowCount(native);

    const second = await seedModelsCatalog({ db, catalog: fixture('1.0.0') });
    expect(second.seeded).toBe(false);
    expect(second.reason).toBe('version-skip');
    expect(rowCount(native)).toBe(first);
  }, 30_000);

  it('upsert (not insert-fail) on a NEWER version re-seeds without duplicating rows', async () => {
    const { db, native } = await open();
    await seedModelsCatalog({ db, catalog: fixture('1.0.0') });
    const before = rowCount(native);

    const upgraded = await seedModelsCatalog({ db, catalog: fixture('1.1.0') });
    expect(upgraded.seeded).toBe(true);
    expect(upgraded.reason).toBe('reseeded-newer');
    // Same natural keys → upsert, NOT duplicate.
    expect(rowCount(native)).toBe(before);
  }, 30_000);

  it('the shipped seed loads + validates against the contract schema (offline)', () => {
    const seed = loadAndValidateSeed();
    expect(seed.version).toMatch(/^\d+\.\d+\.\d+$/);
    const rows = flattenCatalogToRows(seed);
    expect(rows.length).toBeGreaterThan(0);
    // Every flattened row carries a valid ISO release date and a provider id.
    for (const r of rows) {
      expect(r.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.providerId.length).toBeGreaterThan(0);
    }
  });
});
