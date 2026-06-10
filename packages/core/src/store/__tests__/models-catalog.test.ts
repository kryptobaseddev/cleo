/**
 * T11733 — `models_catalog` catalog SSoT table on the GLOBAL cleo.db.
 *
 * Proves the AC: opening the consolidated global `cleo.db` (which applies the
 * `drizzle-cleo-global` migration set, including the new
 * `…_t11733-models-catalog` forward migration) materialises the `models_catalog`
 * table, that a row inserts + selects cleanly (capabilities round-trip), that the
 * migration is idempotent (re-open is a no-op, table still present), and that the
 * `(provider_id, models_dev_id)` unique index + status CHECK + date GLOB hold.
 *
 * Every test runs against a TEMP-DIR cleo.db — never `.cleo/*.db`.
 *
 * @task T11733
 * @epic T11694
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';

let testRoot: string;

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `models-catalog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/** Open + migrate an isolated temp GLOBAL cleo.db; return its native handle. */
async function openGlobalTemp(): Promise<DatabaseSync> {
  const dbPath = join(testRoot, 'cleo.db');
  const handle = await openDualScopeDbAtPath('global', dbPath);
  return (handle.db as unknown as { $client: DatabaseSync }).$client;
}

describe('models_catalog (catalog SSoT) — global cleo.db migration', () => {
  it('migration materialises the `models_catalog` table', async () => {
    const db = await openGlobalTemp();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='models_catalog'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('models_catalog');
  }, 30_000);

  it('inserts and selects a model row round-trip (capability fields)', async () => {
    const db = await openGlobalTemp();
    db.prepare(
      `INSERT INTO models_catalog
         (id, provider_id, name, family, attachment, reasoning, temperature, interleaved,
          tool_call, modalities, cost, context_limit, output_limit, status, release_date,
          models_dev_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'claude-haiku-4-5',
      'anthropic',
      'Claude Haiku 4.5',
      'claude',
      1,
      1,
      1,
      1,
      1,
      '{"input":["text","image"],"output":["text"]}',
      '{"input":1,"output":5}',
      200000,
      64000,
      'stable',
      '2025-10-01',
      'claude-haiku-4-5',
      'seed',
    );

    const got = db
      .prepare(
        `SELECT id, provider_id, name, family, attachment, reasoning, tool_call,
                modalities, cost, context_limit, status, release_date, models_dev_id, source
           FROM models_catalog WHERE id = ?`,
      )
      .get('claude-haiku-4-5') as Record<string, unknown> | undefined;

    expect(got).toBeDefined();
    expect(got?.provider_id).toBe('anthropic');
    expect(got?.family).toBe('claude');
    expect(got?.attachment).toBe(1);
    expect(got?.reasoning).toBe(1);
    expect(got?.tool_call).toBe(1);
    expect(got?.context_limit).toBe(200000);
    expect(got?.status).toBe('stable');
    expect(got?.release_date).toBe('2025-10-01');
    expect(got?.source).toBe('seed');
    // JSON blobs round-trip exactly.
    expect(JSON.parse(got?.modalities as string)).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
    expect(JSON.parse(got?.cost as string)).toEqual({ input: 1, output: 5 });
  }, 30_000);

  it('applies column defaults (temperature=1, status=stable, source=seed, seeded_at)', async () => {
    const db = await openGlobalTemp();
    db.prepare(
      `INSERT INTO models_catalog (id, provider_id, name, family, release_date, models_dev_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'openai', 'M1', 'gpt', '2025-01-01', 'm1');
    const got = db
      .prepare(
        `SELECT attachment, reasoning, temperature, interleaved, tool_call,
                status, source, seeded_at, modalities, cost
           FROM models_catalog WHERE id = 'm1'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(got?.attachment).toBe(0);
    expect(got?.temperature).toBe(1);
    expect(got?.status).toBe('stable');
    expect(got?.source).toBe('seed');
    expect(got?.modalities).toBe('{"input":["text"],"output":["text"]}');
    expect(got?.cost).toBe('{}');
    expect(got?.seeded_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  }, 30_000);

  it('the `(provider_id, models_dev_id)` unique index forbids a duplicate within a provider', async () => {
    const db = await openGlobalTemp();
    db.prepare(
      `INSERT INTO models_catalog (id, provider_id, name, family, release_date, models_dev_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('a', 'anthropic', 'A', 'claude', '2025-01-01', 'dup');
    expect(() =>
      db
        .prepare(
          `INSERT INTO models_catalog (id, provider_id, name, family, release_date, models_dev_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('b', 'anthropic', 'B', 'claude', '2025-02-01', 'dup'),
    ).toThrow();
    // Same models_dev_id under a DIFFERENT provider is allowed.
    expect(() =>
      db
        .prepare(
          `INSERT INTO models_catalog (id, provider_id, name, family, release_date, models_dev_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('c', 'openai', 'C', 'gpt', '2025-02-01', 'dup'),
    ).not.toThrow();
  }, 30_000);

  it('the `status` CHECK rejects an out-of-enum value; the date GLOB rejects a bad date', async () => {
    const db = await openGlobalTemp();
    expect(() =>
      db
        .prepare(
          `INSERT INTO models_catalog (id, provider_id, name, family, release_date, models_dev_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('x', 'anthropic', 'X', 'claude', '2025-01-01', 'x', 'zombie'),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO models_catalog (id, provider_id, name, family, release_date, models_dev_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('y', 'anthropic', 'Y', 'claude', 'not-a-date', 'y'),
    ).toThrow();
  }, 30_000);

  it('migration is idempotent — re-opening the same DB is a no-op and the table persists', async () => {
    const dbPath = join(testRoot, 'cleo.db');
    const h1 = await openDualScopeDbAtPath('global', dbPath);
    (h1.db as unknown as { $client: DatabaseSync }).$client
      .prepare(
        `INSERT INTO models_catalog (id, provider_id, name, family, release_date, models_dev_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('persist', 'anthropic', 'P', 'claude', '2025-01-01', 'persist');

    // Re-open (drops the cache first so a fresh migrate pass runs against the same file).
    _resetDualScopeDbCache();
    const h2 = await openDualScopeDbAtPath('global', dbPath);
    const db2 = (h2.db as unknown as { $client: DatabaseSync }).$client;
    const tbl = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='models_catalog'")
      .get() as { name: string } | undefined;
    expect(tbl?.name).toBe('models_catalog');
    // The row written before re-open is still there (no destructive re-create).
    const row = db2.prepare('SELECT id FROM models_catalog WHERE id = ?').get('persist') as
      | { id: string }
      | undefined;
    expect(row?.id).toBe('persist');
  }, 30_000);
});
