/**
 * T11703 — `seedProviders` populates the `providers` table from the builtin
 * ProviderDef set, idempotently (re-open is a no-op), without clobbering user rows.
 *
 * Every test seeds a TEMP-DIR global cleo.db — never `.cleo/*.db` and NO network.
 *
 * @task T11703
 * @epic T11667
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderDef } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CleoGlobalDb } from '../../store/dual-scope-db.js';
import { _resetDualScopeDbCache } from '../../store/dual-scope-db.js';
import { builtinProviderDefs } from '../provider-registry/provider-defs.js';
import {
  openProviderSeederAtPath,
  providerDefToRow,
  seedProviders,
} from '../provider-registry/provider-seed.js';

let testRoot: string;

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `provider-seed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

async function open(): Promise<{ db: CleoGlobalDb; native: DatabaseSync }> {
  const db = await openProviderSeederAtPath(join(testRoot, 'cleo.db'));
  const native = (db as unknown as { $client: DatabaseSync }).$client;
  return { db, native };
}

function rowCount(native: DatabaseSync): number {
  const r = native.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number };
  return r.c;
}

describe('seedProviders (T11703)', () => {
  it('seeds the builtin provider set and round-trips the declarative JSON columns', async () => {
    const { db, native } = await open();
    const defs = builtinProviderDefs();
    const result = await seedProviders({ db, defs });

    expect(result.seeded).toBe(true);
    expect(result.rowCount).toBe(defs.length);
    expect(rowCount(native)).toBe(defs.length);

    const anthropic = native
      .prepare('SELECT id, display_name, aliases, endpoint, oauth FROM providers WHERE id = ?')
      .get('anthropic') as Record<string, unknown>;
    expect(anthropic.id).toBe('anthropic');
    expect(JSON.parse(anthropic.aliases as string)).toContain('claude');
    expect(JSON.parse(anthropic.endpoint as string)).toMatchObject({
      transport: 'anthropic-messages',
    });
    expect(JSON.parse(anthropic.oauth as string)).toMatchObject({ mode: 'pkce' });
  }, 30_000);

  it('is idempotent — running twice yields the same row count and no duplicates', async () => {
    const { db, native } = await open();
    const defs = builtinProviderDefs();
    await seedProviders({ db, defs });
    const first = rowCount(native);

    const second = await seedProviders({ db, defs });
    expect(second.seeded).toBe(true);
    expect(rowCount(native)).toBe(first);
  }, 30_000);

  it('re-opening the migrated DB is a no-op (migration IF NOT EXISTS)', async () => {
    {
      const { db, native } = await open();
      await seedProviders({ db, defs: builtinProviderDefs() });
      expect(rowCount(native)).toBeGreaterThan(0);
    }
    _resetDualScopeDbCache();
    // Re-open the SAME on-disk DB — the migration is a no-op, rows persist.
    const { native } = await open();
    expect(rowCount(native)).toBeGreaterThan(0);
  }, 30_000);

  it('does not clobber a user plugin provider row on re-seed (AC5)', async () => {
    const { db, native } = await open();
    // Insert a user plugin provider row (a non-builtin id) directly.
    const pluginRow = providerDefToRow({
      id: 'my-plugin-provider',
      displayName: 'My Plugin Provider',
      aliases: ['mpp'],
      authMethods: ['api_key'],
      endpoint: { transport: 'openai-completions', baseUrl: 'https://plugin.example' },
      modelsDevId: 'my-plugin-provider',
    } satisfies ProviderDef);
    native
      .prepare(
        'INSERT INTO providers (id, display_name, aliases, auth_methods, endpoint, models_dev_id, source) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        pluginRow.id,
        pluginRow.displayName,
        pluginRow.aliases,
        pluginRow.authMethods,
        pluginRow.endpoint,
        pluginRow.modelsDevId,
        'plugin',
      );

    await seedProviders({ db, defs: builtinProviderDefs() });

    const survived = native
      .prepare('SELECT id, source FROM providers WHERE id = ?')
      .get('my-plugin-provider') as Record<string, unknown> | undefined;
    expect(survived).toBeDefined();
    expect(survived?.source).toBe('plugin');
  }, 30_000);
});
