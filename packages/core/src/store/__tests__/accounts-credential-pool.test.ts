/**
 * T11709 — `accounts` LLM-credential-pool table round-trip on the GLOBAL cleo.db.
 *
 * Proves the AC: opening the consolidated global `cleo.db` (which applies the
 * `drizzle-cleo-global` migration set, including the new
 * `…_t11709-accounts-credential-pool` forward migration) materialises the
 * `accounts` table, that a row inserts + selects cleanly (round-trip), and that
 * the raw-SQL partial unique index enforces AT MOST ONE active account per
 * provider (`is_active = 1`) while the `(provider, label)` unique index forbids a
 * duplicate label within a provider.
 *
 * Every test runs against a TEMP-DIR cleo.db — never `.cleo/*.db`.
 *
 * @task T11709
 * @epic T10410
 * @saga T10409
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
    `accounts-pool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('accounts (LLM credential pool) — global cleo.db migration', () => {
  it('migration materialises the `accounts` table', async () => {
    const db = await openGlobalTemp();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('accounts');
  }, 30_000);

  it('inserts and selects a credential row round-trip', async () => {
    const db = await openGlobalTemp();

    db.prepare(
      `INSERT INTO accounts
         (provider, label, auth_type, secret_enc, priority, source, status, request_count, metadata, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('anthropic', 'work-key', 'api-key', 'CIPHERTEXT', 10, 'env', 'ok', 0, '{}', 1);

    const got = db
      .prepare(
        `SELECT provider, label, auth_type, secret_enc, priority, source, status,
                request_count, metadata, is_active
           FROM accounts WHERE provider = ? AND label = ?`,
      )
      .get('anthropic', 'work-key') as
      | {
          provider: string;
          label: string;
          auth_type: string;
          secret_enc: string;
          priority: number;
          source: string;
          status: string;
          request_count: number;
          metadata: string;
          is_active: number;
        }
      | undefined;

    expect(got).toBeDefined();
    expect(got?.provider).toBe('anthropic');
    expect(got?.label).toBe('work-key');
    expect(got?.auth_type).toBe('api-key');
    expect(got?.secret_enc).toBe('CIPHERTEXT');
    expect(got?.priority).toBe(10);
    expect(got?.source).toBe('env');
    expect(got?.status).toBe('ok');
    expect(got?.request_count).toBe(0);
    expect(got?.metadata).toBe('{}');
    expect(got?.is_active).toBe(1);
  }, 30_000);

  it('applies column defaults (status=ok, priority=0, request_count=0, metadata={}, is_active=0, timestamps)', async () => {
    const db = await openGlobalTemp();
    db.prepare('INSERT INTO accounts (provider, label, auth_type) VALUES (?, ?, ?)').run(
      'openai',
      'default-row',
      'api-key',
    );
    const got = db
      .prepare(
        `SELECT status, priority, request_count, metadata, is_active, created_at, updated_at
           FROM accounts WHERE provider = 'openai' AND label = 'default-row'`,
      )
      .get() as
      | {
          status: string;
          priority: number;
          request_count: number;
          metadata: string;
          is_active: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    expect(got?.status).toBe('ok');
    expect(got?.priority).toBe(0);
    expect(got?.request_count).toBe(0);
    expect(got?.metadata).toBe('{}');
    expect(got?.is_active).toBe(0);
    // datetime('now') default → ISO-8601-ish 'YYYY-MM-DD HH:MM:SS'.
    expect(got?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(got?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  }, 30_000);

  it('the `(provider, label)` unique index forbids a duplicate label within a provider', async () => {
    const db = await openGlobalTemp();
    db.prepare('INSERT INTO accounts (provider, label, auth_type) VALUES (?, ?, ?)').run(
      'anthropic',
      'dup',
      'api-key',
    );
    expect(() =>
      db
        .prepare('INSERT INTO accounts (provider, label, auth_type) VALUES (?, ?, ?)')
        .run('anthropic', 'dup', 'oauth'),
    ).toThrow();
    // Same label under a DIFFERENT provider is allowed.
    expect(() =>
      db
        .prepare('INSERT INTO accounts (provider, label, auth_type) VALUES (?, ?, ?)')
        .run('openai', 'dup', 'api-key'),
    ).not.toThrow();
  }, 30_000);

  it('the raw partial unique index allows AT MOST ONE active account per provider', async () => {
    const db = await openGlobalTemp();
    // The partial unique index must exist (drizzle cannot emit it — raw SQL).
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_accounts_active_provider'",
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('ux_accounts_active_provider');

    // First active account for the provider is fine.
    db.prepare(
      'INSERT INTO accounts (provider, label, auth_type, is_active) VALUES (?, ?, ?, 1)',
    ).run('anthropic', 'primary', 'api-key');
    // A SECOND active account for the SAME provider violates the partial unique index.
    expect(() =>
      db
        .prepare('INSERT INTO accounts (provider, label, auth_type, is_active) VALUES (?, ?, ?, 1)')
        .run('anthropic', 'secondary', 'api-key'),
    ).toThrow();
    // An INACTIVE second account for the same provider is allowed (WHERE is_active = 1
    // excludes is_active = 0 rows from the unique constraint).
    expect(() =>
      db
        .prepare('INSERT INTO accounts (provider, label, auth_type, is_active) VALUES (?, ?, ?, 0)')
        .run('anthropic', 'standby', 'api-key'),
    ).not.toThrow();
    // A DIFFERENT provider may also have its own single active account.
    expect(() =>
      db
        .prepare('INSERT INTO accounts (provider, label, auth_type, is_active) VALUES (?, ?, ?, 1)')
        .run('openai', 'primary', 'api-key'),
    ).not.toThrow();
  }, 30_000);

  it('the `status` CHECK rejects an out-of-enum value', async () => {
    const db = await openGlobalTemp();
    expect(() =>
      db
        .prepare('INSERT INTO accounts (provider, label, auth_type, status) VALUES (?, ?, ?, ?)')
        .run('anthropic', 'bad-status', 'api-key', 'zombie'),
    ).toThrow();
    // The three legal statuses all insert cleanly.
    for (const status of ['ok', 'exhausted', 'dead'] as const) {
      expect(() =>
        db
          .prepare('INSERT INTO accounts (provider, label, auth_type, status) VALUES (?, ?, ?, ?)')
          .run('anthropic', `s-${status}`, 'api-key', status),
      ).not.toThrow();
    }
  }, 30_000);
});
