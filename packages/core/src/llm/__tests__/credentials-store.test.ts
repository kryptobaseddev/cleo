/**
 * Tests for the multi-credential pool store at
 * `~/.cleo/llm-credentials.json` (T-LLM-CRED-CENTRALIZATION Phase 2 / T9257).
 *
 * Filesystem isolation mirrors `credentials-auth-type.test.ts`: a fresh
 * tmpdir backing `XDG_DATA_HOME` and `HOME` per test, env restored in
 * `afterEach`. Tier-integration tests further seed `~/.claude/.credentials.json`
 * inside the same isolated HOME so they exercise the real precedence between
 * the cred-file tier (tier 3) and the legacy claude-creds tier (tier 4).
 *
 * @task T9257
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAnthropicKeyCache, resolveCredentials } from '../credentials.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
  type CredentialsStoreData,
  credentialsStorePath,
  getCredentialByLabel,
  listCredentials,
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
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

afterEach(() => {
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
  it('creates the file with chmod 0600 on first write', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'sk-ant-api03-aaa',
    });
    const path = credentialsStorePath();
    expect(existsSync(path)).toBe(true);
    const stats = statSync(path);
    expect(stats.mode & 0o777).toBe(0o600);

    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as CredentialsStoreData;
    expect(data.version).toBe(1);
    expect(data.defaultStrategy).toBe('priorityWithFallback');
    expect(data.credentials).toHaveLength(1);
    expect(data.credentials[0]?.label).toBe('personal');
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

  it('chmods the file back to 0600 after a remove', async () => {
    isolateHomes();
    await addCredential({
      provider: 'openai',
      label: 'a',
      authType: 'api_key',
      accessToken: 'k',
    });
    await removeCredential('openai', 'a');
    const mode = statSync(credentialsStorePath()).mode & 0o777;
    expect(mode).toBe(0o600);
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

describe('file-lock concurrent writes', () => {
  it('two parallel addCredential calls do not corrupt the file', async () => {
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

    // The file must parse, contain all 5 entries, and stay at 0600.
    const raw = readFileSync(credentialsStorePath(), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as CredentialsStoreData;
    expect(parsed.version).toBe(1);
    expect(parsed.credentials).toHaveLength(5);
    const labels = parsed.credentials.map((c) => c.label).sort();
    expect(labels).toEqual(['parallel-0', 'parallel-1', 'parallel-2', 'parallel-3', 'parallel-4']);
    const mode = statSync(credentialsStorePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Security: filesystem permissions
//
// Regression suite for the security-review findings on T9257:
//   S-01 — backup files leaked at 0644 (CWE-276)
//   S-02 — TOCTOU window between atomic rename and chmod (CWE-367)
//   S-03 — ~/.cleo parent dir created at 0755 enabled neighbor-UID
//          enumeration of .backups/ filenames + mtimes (CWE-732)
// ---------------------------------------------------------------------------

describe('security: filesystem permissions', () => {
  it('parent dir ~/.cleo is created at 0700 (S-03)', async () => {
    isolateHomes();
    await addCredential({
      provider: 'anthropic',
      label: 'perms-parent',
      authType: 'api_key',
      accessToken: 'sk-ant-x',
    });
    const parentDir = dirname(credentialsStorePath());
    const dirMode = statSync(parentDir).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('rotated backup files are 0600 across multiple writes (S-01)', async () => {
    isolateHomes();
    // Three writes → at least two rotated backups under .backups/.
    for (let i = 0; i < 3; i++) {
      await addCredential({
        provider: 'openai',
        label: 'rotating',
        authType: 'api_key',
        accessToken: `sk-${i}`,
      });
    }

    const backupDir = join(dirname(credentialsStorePath()), '.backups');
    expect(existsSync(backupDir)).toBe(true);

    // Backup directory itself must be 0o700 — otherwise neighbor UIDs can
    // enumerate filenames + mtimes even when each file is 0o600.
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);

    const entries = readdirSync(backupDir);
    expect(entries.length).toBeGreaterThan(0);
    for (const name of entries) {
      const mode = statSync(join(backupDir, name)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('live file is 0600 immediately after every addCredential — no TOCTOU window (S-02)', async () => {
    isolateHomes();
    // Five sequential writes — assert 0600 after each call returns. If the
    // implementation regresses to a post-rename chmod, the live file would
    // be 0644 in the gap between rename + chmod; here we serialize and
    // observe at every step.
    for (let i = 0; i < 5; i++) {
      await addCredential({
        provider: 'anthropic',
        label: `toctou-${i}`,
        authType: 'api_key',
        accessToken: `sk-ant-${i}`,
      });
      const mode = statSync(credentialsStorePath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
