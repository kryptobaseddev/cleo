/**
 * T11703 — `providers` declarative-provider SSoT table on the GLOBAL cleo.db.
 *
 * Proves the AC: opening the consolidated global `cleo.db` (which applies the
 * `drizzle-cleo-global` migration set, including the new `…_t11703-providers`
 * forward migration) materialises the `providers` table, that a row inserts +
 * selects cleanly (JSON columns round-trip), that the column defaults apply, that
 * the `seeded_at` date GLOB CHECK holds, and that the migration is idempotent
 * (re-open is a no-op, table + rows persist).
 *
 * Every test runs against a TEMP-DIR cleo.db — never `.cleo/*.db`.
 *
 * @task T11703
 * @epic T11667
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
    `providers-table-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('providers (declarative provider SSoT) — global cleo.db migration', () => {
  it('migration materialises the `providers` table', async () => {
    const db = await openGlobalTemp();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('providers');
  }, 30_000);

  it('inserts and selects a provider row round-trip (JSON columns)', async () => {
    const db = await openGlobalTemp();
    db.prepare(
      `INSERT INTO providers
         (id, display_name, aliases, auth_methods, endpoint, alt_endpoints,
          models_dev_id, default_headers, env_vars, oauth, request_quirks, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'openai',
      'OpenAI Codex (ChatGPT)',
      '["codex","chatgpt"]',
      '["api_key","oauth"]',
      '{"transport":"openai-completions","baseUrl":"https://api.openai.com/v1"}',
      '[{"transport":"openai-responses","baseUrl":"https://api.openai.com/v1"}]',
      'openai',
      '{}',
      '[]',
      '{"mode":"pkce","clientId":"app_x","tokenEndpoint":"https://auth.openai.com/oauth/token"}',
      '[]',
      'seed',
    );

    const got = db
      .prepare(
        `SELECT id, display_name, aliases, endpoint, alt_endpoints, oauth, source
           FROM providers WHERE id = ?`,
      )
      .get('openai') as Record<string, unknown> | undefined;

    expect(got).toBeDefined();
    expect(got?.display_name).toBe('OpenAI Codex (ChatGPT)');
    expect(JSON.parse(got?.aliases as string)).toEqual(['codex', 'chatgpt']);
    expect(JSON.parse(got?.endpoint as string)).toMatchObject({ transport: 'openai-completions' });
    expect(JSON.parse(got?.alt_endpoints as string)[0]).toMatchObject({
      transport: 'openai-responses',
    });
    expect(JSON.parse(got?.oauth as string)).toMatchObject({ mode: 'pkce' });
    expect(got?.source).toBe('seed');
  }, 30_000);

  it('applies column defaults (aliases=[], source=seed, seeded_at, oauth NULL)', async () => {
    const db = await openGlobalTemp();
    db.prepare(
      `INSERT INTO providers (id, display_name, endpoint, models_dev_id) VALUES (?, ?, ?, ?)`,
    ).run(
      'ollama',
      'Ollama',
      '{"transport":"aisdk","baseUrl":"http://localhost:11434","aiSdkProvider":"openai-compatible"}',
      'ollama',
    );
    const got = db
      .prepare(
        `SELECT aliases, auth_methods, alt_endpoints, default_headers, env_vars,
                request_quirks, oauth, source, seeded_at
           FROM providers WHERE id = 'ollama'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(got?.aliases).toBe('[]');
    expect(got?.auth_methods).toBe('[]');
    expect(got?.alt_endpoints).toBe('[]');
    expect(got?.default_headers).toBe('{}');
    expect(got?.env_vars).toBe('[]');
    expect(got?.request_quirks).toBe('[]');
    expect(got?.oauth).toBeNull();
    expect(got?.source).toBe('seed');
    expect(got?.seeded_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  }, 30_000);

  it('the `seeded_at` date GLOB CHECK rejects a malformed timestamp', async () => {
    const db = await openGlobalTemp();
    expect(() =>
      db
        .prepare(
          `INSERT INTO providers (id, display_name, endpoint, models_dev_id, seeded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('bad', 'Bad', '{"transport":"openai-completions","baseUrl":"x"}', 'bad', 'not-a-date'),
    ).toThrow();
  }, 30_000);

  it('migration is idempotent — re-opening the same DB is a no-op and the table + row persist', async () => {
    const dbPath = join(testRoot, 'cleo.db');
    const h1 = await openDualScopeDbAtPath('global', dbPath);
    (h1.db as unknown as { $client: DatabaseSync }).$client
      .prepare(
        `INSERT INTO providers (id, display_name, endpoint, models_dev_id) VALUES (?, ?, ?, ?)`,
      )
      .run('persist', 'P', '{"transport":"openai-completions","baseUrl":"x"}', 'persist');

    _resetDualScopeDbCache();
    const h2 = await openDualScopeDbAtPath('global', dbPath);
    const db2 = (h2.db as unknown as { $client: DatabaseSync }).$client;
    const tbl = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'")
      .get() as { name: string } | undefined;
    expect(tbl?.name).toBe('providers');
    const row = db2.prepare('SELECT id FROM providers WHERE id = ?').get('persist') as
      | { id: string }
      | undefined;
    expect(row?.id).toBe('persist');
  }, 30_000);
});
