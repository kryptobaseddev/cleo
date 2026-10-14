/**
 * Tests for the multi-credential pool store: the global `accounts` table,
 * with `~/.cleo/llm-credentials.json` as a migrated legacy source
 * (T-LLM-CRED-CENTRALIZATION Phase 2 / T9257; T13715).
 *
 * Filesystem isolation mirrors `credentials-auth-type.test.ts`: a fresh
 * tmpdir backing `XDG_DATA_HOME` and `HOME` per test, env restored in
 * `afterEach`. Tier-integration tests further seed `~/.claude/.credentials.json`
 * inside the same isolated HOME so they exercise the real precedence between
 * the cred-file tier (tier 3) and the legacy claude-creds tier (tier 4).
 *
 * @task T9257
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptGlobal } from '../../crypto/credentials.js';
import { _resetDualScopeDbCache } from '../../store/dual-scope-db.js';
import { __clearGlobalSaltCache } from '../../store/global-salt.js';
import {
  type LlmAccountRow,
  listLlmAccountRowsSync,
  llmAccountSecretId,
} from '../../store/llm-accounts-accessor.js';
import { clearAnthropicKeyCache, resolveCredentials } from '../credentials.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
  credentialsStorePath,
  getCredentialByLabel,
  listCredentials,
  migrateLegacyCredentialsFile,
  pickCredentialForProvider,
  pickCredentialForProviderSync,
  removeCredential,
  type StoredCredential,
} from '../credentials-store.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  // T9403: getCleoHome() honours CLEO_HOME first; save/restore so the
  // global vitest setup's per-fork pin is not destroyed by these tests.
  'CLEO_HOME',
  'HOME',
  'CLEO_DIR',
];

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/**
 * Point XDG_DATA_HOME + HOME at fresh tmp dirs so neither the cred-file
 * tier nor the claude-creds tier picks up developer credentials.
 */
function isolateHomes(): { xdgRoot: string; home: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-credstore-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-credstore-home-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  // T9403: mirror XDG layout under CLEO_HOME so getCleoHome() resolves to
  // the same per-test sandbox.
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
  return { xdgRoot, home };
}

/** The isolated home's `accounts` rows, still encrypted. */
function accountRows(): LlmAccountRow[] {
  return listLlmAccountRowsSync();
}

/** Seed `~/.claude/.credentials.json` under the isolated HOME. */
function seedClaudeOauth(home: string, accessToken: string): void {
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken, expiresAt: Date.now() + 60 * 60_000 },
    }),
    'utf-8',
  );
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  // Each test has its own home, so its own global salt.
  __clearGlobalSaltCache();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

afterEach(() => {
  _resetDualScopeDbCache();
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

// ---------------------------------------------------------------------------
// Missing-file behavior
// ---------------------------------------------------------------------------

describe('missing-file behavior', () => {
  it('listCredentials() returns [] when the file does not exist', async () => {
    isolateHomes();
    expect(existsSync(credentialsStorePath())).toBe(false);
    await expect(listCredentials()).resolves.toEqual([]);
    await expect(listCredentials('anthropic')).resolves.toEqual([]);
  });

  it('getCredentialByLabel() returns null when the file does not exist', async () => {
    isolateHomes();
    await expect(getCredentialByLabel('anthropic', 'personal')).resolves.toBeNull();
  });

  it('removeCredential() returns false when the file does not exist', async () => {
    isolateHomes();
    await expect(removeCredential('anthropic', 'personal')).resolves.toBe(false);
    // Should not have created the file.
    expect(existsSync(credentialsStorePath())).toBe(false);
  });

  it('pickCredentialForProvider() returns null when the file does not exist', async () => {
    isolateHomes();
    await expect(pickCredentialForProvider('anthropic')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addCredential
// ---------------------------------------------------------------------------

describe('addCredential()', () => {
  it('stores the credential encrypted in accounts and writes no plaintext file (T13715)', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'sk-ant-api03-aaa',
    });
    expect(existsSync(credentialsStorePath())).toBe(false);
    const row = accountRows()[0];
    expect(row).toMatchObject({ provider: 'anthropic', label: 'personal', auth_type: 'api-key' });
    expect(row?.secret_enc).not.toContain('sk-ant-api03-aaa');
    expect(
      await decryptGlobal(row?.secret_enc ?? '', llmAccountSecretId('anthropic', 'personal')),
    ).toBe('sk-ant-api03-aaa');
    await expect(getCredentialByLabel('anthropic', 'personal')).resolves.toMatchObject({
      accessToken: 'sk-ant-api03-aaa',
      priority: 0,
    });
  });

  it('upserts on duplicate (provider, label)', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'first-value',
    });
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'second-value',
    });

    const all = await listCredentials('anthropic');
    expect(all).toHaveLength(1);
    expect(all[0]?.accessToken).toBe('second-value');
  });

  it('assigns priority = max(existing) + 10 when not provided', async () => {
    isolateHomes();
    await addCredential({
      provider: 'openai',
      label: 'a',
      authType: 'api_key',
      accessToken: 'k-a',
      priority: 0,
    });
    await addCredential({
      provider: 'openai',
      label: 'b',
      authType: 'api_key',
      accessToken: 'k-b',
      priority: 50,
    });
    const fresh = await addCredential({
      provider: 'openai',
      label: 'c',
      authType: 'api_key',
      accessToken: 'k-c',
    });
    expect(fresh.priority).toBe(60);
  });

  it('preserves explicit priority when provided', async () => {
    isolateHomes();
    const created = await addCredential({
      provider: 'gemini',
      label: 'lab',
      authType: 'api_key',
      accessToken: 'g-key',
      priority: 5,
    });
    expect(created.priority).toBe(5);
  });

  it('stores aws_sdk auth type with empty accessToken', async () => {
    isolateHomes();
    const created = await addCredential({
      provider: 'anthropic',
      label: 'bedrock-prod',
      authType: 'aws_sdk',
      accessToken: '',
      metadata: { region: 'us-east-1' },
    });
    expect(created.authType).toBe('aws_sdk');
    expect(created.accessToken).toBe('');
    expect(created.metadata?.['region']).toBe('us-east-1');
  });
});

// ---------------------------------------------------------------------------
// removeCredential
// ---------------------------------------------------------------------------

describe('removeCredential()', () => {
  it('returns true on hit and removes the entry', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'gone',
      authType: 'api_key',
      accessToken: 'k',
    });
    await expect(removeCredential('anthropic', 'gone')).resolves.toBe(true);
    await expect(listCredentials('anthropic')).resolves.toEqual([]);
  });

  it('returns false when no matching entry exists', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'kept',
      authType: 'api_key',
      accessToken: 'k',
    });
    await expect(removeCredential('anthropic', 'nope')).resolves.toBe(false);
    await expect(listCredentials('anthropic')).resolves.toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getCredentialByLabel
// ---------------------------------------------------------------------------

describe('getCredentialByLabel()', () => {
  it('returns null for a non-existent label', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'real',
      authType: 'api_key',
      accessToken: 'k',
    });
    await expect(getCredentialByLabel('anthropic', 'ghost')).resolves.toBeNull();
  });

  it('returns the entry on exact match', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'real',
      authType: 'api_key',
      accessToken: 'sk-real',
    });
    const got = await getCredentialByLabel('anthropic', 'real');
    expect(got?.accessToken).toBe('sk-real');
  });
});

// ---------------------------------------------------------------------------
// pickCredentialForProvider — strategies + filters
// ---------------------------------------------------------------------------

describe('pickCredentialForProvider()', () => {
  it('returns the lowest-priority entry under priorityWithFallback', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'lo',
      authType: 'api_key',
      accessToken: 'lo',
      priority: 100,
    });
    await addCredential({
      provider: 'anthropic',
      label: 'hi',
      authType: 'api_key',
      accessToken: 'hi',
      priority: 10,
    });
    const picked = await pickCredentialForProvider('anthropic');
    expect(picked?.label).toBe('hi');
  });

  it('filters disabled entries', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'off',
      authType: 'api_key',
      accessToken: 'off',
      priority: 1,
      disabled: true,
    });
    await addCredential({
      provider: 'anthropic',
      label: 'on',
      authType: 'api_key',
      accessToken: 'on',
      priority: 100,
    });
    const picked = await pickCredentialForProvider('anthropic');
    expect(picked?.label).toBe('on');
  });

  it('filters expired entries (expiresAt in the past)', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'stale',
      authType: 'oauth',
      accessToken: 'sk-stale',
      priority: 1,
      expiresAt: Date.now() - 60_000,
    });
    await addCredential({
      provider: 'anthropic',
      label: 'fresh',
      authType: 'oauth',
      accessToken: 'sk-fresh',
      priority: 100,
      expiresAt: Date.now() + 60_000,
    });
    const picked = await pickCredentialForProvider('anthropic');
    expect(picked?.label).toBe('fresh');
  });

  it('treats expiresAt=null as "never expires"', async () => {
    isolateHomes();
    await addCredential({
      provider: 'openai',
      label: 'forever',
      authType: 'api_key',
      accessToken: 'k',
      priority: 1,
      expiresAt: null,
    });
    const picked = await pickCredentialForProvider('openai');
    expect(picked?.label).toBe('forever');
  });

  it('honors preferLabel as an exact-match override', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'team',
      authType: 'api_key',
      accessToken: 'team',
      priority: 1,
    });
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'personal',
      priority: 100,
    });
    const picked = await pickCredentialForProvider('anthropic', { preferLabel: 'personal' });
    expect(picked?.label).toBe('personal');
  });

  it('returns null when preferLabel does not match any eligible entry', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'real',
      authType: 'api_key',
      accessToken: 'k',
    });
    const picked = await pickCredentialForProvider('anthropic', { preferLabel: 'missing' });
    expect(picked).toBeNull();
  });

  it('rotates entries under the roundRobin strategy', async () => {
    isolateHomes();
    await addCredential({
      provider: 'openai',
      label: 'a',
      authType: 'api_key',
      accessToken: 'a',
      priority: 1,
    });
    await addCredential({
      provider: 'openai',
      label: 'b',
      authType: 'api_key',
      accessToken: 'b',
      priority: 2,
    });
    const first = pickCredentialForProviderSync('openai', { strategy: 'roundRobin' });
    const second = pickCredentialForProviderSync('openai', { strategy: 'roundRobin' });
    const third = pickCredentialForProviderSync('openai', { strategy: 'roundRobin' });
    expect([first?.label, second?.label, third?.label]).toEqual(['a', 'b', 'a']);
  });
});

// ---------------------------------------------------------------------------
// Tier-integration with resolveCredentials()
// ---------------------------------------------------------------------------

describe('resolveCredentials() integration — cred-file tier', () => {
  it('returns source=cred-file when an entry exists for the provider', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'sk-ant-api03-fromfile',
      priority: 1,
    });
    clearAnthropicKeyCache();
    const cred = resolveCredentials('anthropic');
    expect(cred.source).toBe('cred-file');
    expect(cred.apiKey).toBe('sk-ant-api03-fromfile');
    expect(cred.authType).toBe('api_key');
  });

  it('cred-file beats claude-creds when both are present', async () => {
    const { home } = isolateHomes();
    seedClaudeOauth(home, 'sk-ant-oat-from-claude');
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'oauth',
      accessToken: 'sk-ant-oat-from-credfile',
      priority: 1,
      expiresAt: Date.now() + 60 * 60_000,
    });
    clearAnthropicKeyCache();
    const cred = resolveCredentials('anthropic');
    expect(cred.source).toBe('cred-file');
    expect(cred.apiKey).toBe('sk-ant-oat-from-credfile');
    // Stored authType 'oauth' narrows to wire 'oauth'.
    expect(cred.authType).toBe('oauth');
  });

  it('env beats cred-file (tier 2 > tier 3)', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'sk-credfile',
      priority: 1,
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-wins';
    clearAnthropicKeyCache();
    const cred = resolveCredentials('anthropic');
    expect(cred.source).toBe('env');
    expect(cred.apiKey).toBe('sk-env-wins');
  });

  it('returns null when cred-file has no eligible entry (T9413 — claude-creds direct read removed)', async () => {
    // T9413 (E-CONFIG-AUTH-UNIFY §5.2 T-E2-6): the sync resolver no longer
    // reads `~/.claude/.credentials.json` directly. With every cred-file
    // entry disabled and no pool-seeded claude-code entry, the resolver
    // returns null. The claude-code seeder (T9410) is the supported path
    // for importing the file into the pool.
    const { home } = isolateHomes();
    seedClaudeOauth(home, 'sk-ant-oat-fallback');
    // Add a disabled cred-file entry — it MUST be skipped.
    await addCredential({
      provider: 'anthropic',
      label: 'broken',
      authType: 'oauth',
      accessToken: 'sk-ant-oat-disabled',
      priority: 1,
      disabled: true,
    });
    clearAnthropicKeyCache();
    const cred = resolveCredentials('anthropic');
    expect(cred.apiKey).toBeNull();
    expect(cred.source).toBeUndefined();
  });

  it('aws_sdk stored auth narrows to api_key on the wire (Phase 2 compat)', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'bedrock',
      authType: 'aws_sdk',
      accessToken: 'sdk-handles-auth',
      priority: 1,
    });
    clearAnthropicKeyCache();
    const cred = resolveCredentials('anthropic');
    expect(cred.source).toBe('cred-file');
    expect(cred.authType).toBe('api_key');
  });
});

// ---------------------------------------------------------------------------
// Concurrent writes
// ---------------------------------------------------------------------------

describe('concurrent writes', () => {
  it('parallel addCredential calls all land', async () => {
    isolateHomes();

    const calls: Array<Promise<StoredCredential>> = [];
    for (let i = 0; i < 5; i++) {
      calls.push(
        addCredential({
          provider: 'openai',
          label: `parallel-${i}`,
          authType: 'api_key',
          accessToken: `sk-${i}`,
        }),
      );
    }
    await Promise.all(calls);

    const labels = (await listCredentials('openai')).map((c) => c.label).sort();
    expect(labels).toEqual(['parallel-0', 'parallel-1', 'parallel-2', 'parallel-3', 'parallel-4']);
  });
});

// ---------------------------------------------------------------------------
// Security: no plaintext at rest (T13715)
// ---------------------------------------------------------------------------

describe('security: no plaintext at rest (T13715)', () => {
  it('neither the secret nor its base64 appears in the store files', async () => {
    isolateHomes();
    const secret = 'sk-ant-T13715-at-rest-needle';
    await addCredential({
      provider: 'anthropic',
      label: 'rest',
      authType: 'oauth',
      accessToken: secret,
      refreshToken: `${secret}-refresh`,
    });
    const db = join(process.env['CLEO_HOME'] ?? '', 'cleo.db');
    const bytes = Buffer.concat(
      [db, `${db}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f)),
    );
    for (const needle of [secret, Buffer.from(secret).toString('base64')]) {
      expect(bytes.includes(needle)).toBe(false);
    }
    await expect(getCredentialByLabel('anthropic', 'rest')).resolves.toMatchObject({
      accessToken: secret,
      refreshToken: `${secret}-refresh`,
    });
  });
});

// ---------------------------------------------------------------------------
// Legacy llm-credentials.json migration (T13715)
// ---------------------------------------------------------------------------

/** Write a legacy plaintext pool file. */
function seedLegacy(credentials: Array<Partial<StoredCredential>>, raw?: string): void {
  writeFileSync(
    credentialsStorePath(),
    raw ?? JSON.stringify({ version: 1, defaultStrategy: 'priorityWithFallback', credentials }),
    { mode: 0o600 },
  );
}

describe('legacy llm-credentials.json migration (T13715)', () => {
  const legacy = [
    {
      provider: 'anthropic',
      label: 'old',
      authType: 'api_key',
      accessToken: 'sk-old',
      priority: 5,
    },
    {
      provider: 'openai',
      label: 'oa',
      authType: 'oauth',
      accessToken: 'tok',
      refreshToken: 'ref',
      priority: 1,
      baseUrl: 'https://example.test',
    },
  ] as const satisfies ReadonlyArray<Partial<StoredCredential>>;

  it('moves every entry into accounts once, then removes the plaintext file', async () => {
    isolateHomes();
    seedLegacy([...legacy]);
    // Before any async call, the sync resolver already serves the legacy entry.
    expect(pickCredentialForProviderSync('anthropic')?.accessToken).toBe('sk-old');

    await expect(migrateLegacyCredentialsFile()).resolves.toBe(2);
    expect(existsSync(credentialsStorePath())).toBe(false);
    expect(accountRows().map((r) => `${r.provider}:${r.label}`)).toEqual([
      'anthropic:old',
      'openai:oa',
    ]);
    for (const r of accountRows()) expect(r.secret_enc).not.toMatch(/sk-old|^tok$/);
    await expect(getCredentialByLabel('openai', 'oa')).resolves.toMatchObject({
      accessToken: 'tok',
      refreshToken: 'ref',
      priority: 1,
      baseUrl: 'https://example.test',
    });

    // Idempotent: nothing left to move.
    await expect(migrateLegacyCredentialsFile()).resolves.toBe(0);
    expect(accountRows()).toHaveLength(2);
  });

  it('a list call migrates, and an entry accounts already holds is kept', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'old',
      authType: 'api_key',
      accessToken: 'sk-new',
    });
    seedLegacy([...legacy]);
    const listed = await listCredentials();
    expect(listed.map((c) => `${c.provider}:${c.label}`).sort()).toEqual([
      'anthropic:old',
      'openai:oa',
    ]);
    expect(listed.find((c) => c.label === 'old')?.accessToken).toBe('sk-new');
    expect(existsSync(credentialsStorePath())).toBe(false);
  });

  it('a removed legacy entry does not come back', async () => {
    isolateHomes();
    seedLegacy([...legacy]);
    await expect(removeCredential('anthropic', 'old')).resolves.toBe(true);
    await expect(listCredentials('anthropic')).resolves.toEqual([]);
  });

  it('a malformed legacy file is left in place', async () => {
    isolateHomes();
    seedLegacy([], '{ not json');
    await expect(migrateLegacyCredentialsFile()).resolves.toBe(0);
    expect(readFileSync(credentialsStorePath(), 'utf-8')).toBe('{ not json');
  });
});
