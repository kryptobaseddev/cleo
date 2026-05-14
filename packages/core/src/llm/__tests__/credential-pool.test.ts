/**
 * Unit tests for `CredentialPool` (T-LLM-CRED-CENTRALIZATION Phase 3 / T9265).
 *
 * Isolation strategy: each test gets a fresh tmpdir pointed at by
 * `XDG_DATA_HOME` and `HOME` so the credential store file never collides with
 * developer credentials or between parallel test workers.
 *
 * Fake timers (`vi.useFakeTimers`) are used for all cooldown tests to avoid
 * real-time waits and make assertions deterministic.
 *
 * @task T9265
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialPool, PoolExhaustedError } from '../credential-pool.js';
import { clearAnthropicKeyCache } from '../credentials.js';
import type { StoredCredential } from '../credentials-store.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
} from '../credentials-store.js';

// ---------------------------------------------------------------------------
// Environment isolation helpers
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['XDG_DATA_HOME', 'HOME', 'CLEO_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

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
 * Point `XDG_DATA_HOME` and `HOME` at fresh tmp directories so the store file
 * never collides with developer credentials or other test workers.
 */
function isolateHomes(): { xdgRoot: string; home: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-pool-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-pool-home-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['HOME'] = home;
  return { xdgRoot, home };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Build a minimal StoredCredential for seeding the store. */
function makeCredential(
  label: string,
  priority: number,
  overrides: Partial<StoredCredential> = {},
): Omit<StoredCredential, 'priority'> & { priority: number } {
  return {
    provider: 'anthropic',
    label,
    authType: 'api_key',
    accessToken: `tok-${label}`,
    priority,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialPool — fill_first strategy', () => {
  it('returns the highest-priority entry (largest priority number wins)', async () => {
    isolateHomes();
    // Store convention: higher numeric priority = more preferred in pool.
    await addCredential(makeCredential('low', 10));
    await addCredential(makeCredential('high', 100));

    const pool = new CredentialPool('anthropic');
    const { credential, poolSize } = await pool.pick({ strategy: 'fill_first' });

    expect(credential.label).toBe('high');
    expect(poolSize).toBe(2);
  });

  it('skips entries with an active cooldown', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await addCredential(makeCredential('high', 100));
    await addCredential(makeCredential('low', 10));

    const pool = new CredentialPool('anthropic');
    // Put the high-priority entry in cooldown.
    await pool.markExhausted('high', 429);

    const { credential } = await pool.pick({ strategy: 'fill_first' });
    expect(credential.label).toBe('low');
  });

  it('throws PoolExhaustedError when all entries are in cooldown', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await addCredential(makeCredential('alpha', 100));
    await addCredential(makeCredential('beta', 50));

    const pool = new CredentialPool('anthropic');
    await pool.markExhausted('alpha', 429);
    await pool.markExhausted('beta', 429);

    await expect(pool.pick()).rejects.toBeInstanceOf(PoolExhaustedError);
    await expect(pool.pick()).rejects.toThrow('E_LLM_POOL_EXHAUSTED');
  });
});

describe('CredentialPool — round_robin strategy', () => {
  it('rotates across entries on successive calls', async () => {
    isolateHomes();

    await addCredential(makeCredential('a', 100));
    await addCredential(makeCredential('b', 50));
    await addCredential(makeCredential('c', 10));

    const pool = new CredentialPool('anthropic');
    const labels: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { credential } = await pool.pick({ strategy: 'round_robin' });
      labels.push(credential.label);
    }

    // Each entry should appear exactly once in one full rotation.
    expect(new Set(labels).size).toBe(3);
    expect(labels.sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips cooled-down entries during rotation', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await addCredential(makeCredential('x', 100));
    await addCredential(makeCredential('y', 50));

    const pool = new CredentialPool('anthropic');
    await pool.markExhausted('x', 429);

    const { credential } = await pool.pick({ strategy: 'round_robin' });
    expect(credential.label).toBe('y');
  });
});

describe('CredentialPool — least_used strategy', () => {
  it('picks the entry with the lowest requestCount', async () => {
    isolateHomes();

    // Seed with two entries; give 'b' a head-start request count.
    await addCredential(makeCredential('a', 100, { requestCount: 5 }));
    await addCredential(makeCredential('b', 50, { requestCount: 0 }));

    const pool = new CredentialPool('anthropic');
    const { credential } = await pool.pick({ strategy: 'least_used' });
    expect(credential.label).toBe('b');
  });
});

describe('CredentialPool.markExhausted()', () => {
  it('sets cooldown ~5 minutes ahead for 401', async () => {
    isolateHomes();
    vi.useFakeTimers();
    const now = Date.now();

    await addCredential(makeCredential('key1', 10));
    const pool = new CredentialPool('anthropic');
    await pool.markExhausted('key1', 401);

    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'key1');
    expect(entry?.lastStatus).toBe('exhausted');
    expect(entry?.lastErrorCode).toBe(401);
    // 5 minutes = 300_000 ms
    expect(entry?.lastErrorResetAt).toBeGreaterThanOrEqual(now + 299_000);
    expect(entry?.lastErrorResetAt).toBeLessThanOrEqual(now + 301_000);
  });

  it('sets cooldown ~1 hour ahead for 429', async () => {
    isolateHomes();
    vi.useFakeTimers();
    const now = Date.now();

    await addCredential(makeCredential('key2', 10));
    const pool = new CredentialPool('anthropic');
    await pool.markExhausted('key2', 429);

    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'key2');
    expect(entry?.lastStatus).toBe('exhausted');
    expect(entry?.lastErrorCode).toBe(429);
    // 1 hour = 3_600_000 ms
    expect(entry?.lastErrorResetAt).toBeGreaterThanOrEqual(now + 3_599_000);
    expect(entry?.lastErrorResetAt).toBeLessThanOrEqual(now + 3_601_000);
  });

  it('sets cooldown ~60 seconds ahead for 500', async () => {
    isolateHomes();
    vi.useFakeTimers();
    const now = Date.now();

    await addCredential(makeCredential('key3', 10));
    const pool = new CredentialPool('anthropic');
    await pool.markExhausted('key3', 500);

    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'key3');
    expect(entry?.lastStatus).toBe('exhausted');
    expect(entry?.lastErrorCode).toBe(500);
    // 60 seconds = 60_000 ms
    expect(entry?.lastErrorResetAt).toBeGreaterThanOrEqual(now + 59_000);
    expect(entry?.lastErrorResetAt).toBeLessThanOrEqual(now + 61_000);
  });
});

describe('CredentialPool.markOk()', () => {
  it('clears cooldown fields so the entry is immediately eligible again', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await addCredential(makeCredential('mainkey', 10));
    const pool = new CredentialPool('anthropic');

    // Put into cooldown.
    await pool.markExhausted('mainkey', 429);

    // Verify it is now in cooldown.
    await expect(pool.pick()).rejects.toBeInstanceOf(PoolExhaustedError);

    // Clear the cooldown.
    await pool.markOk('mainkey');

    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'mainkey');
    expect(entry?.lastStatus).toBe('ok');
    expect(entry?.lastErrorCode).toBeUndefined();
    expect(entry?.lastErrorResetAt).toBeUndefined();

    // Should now be pickable.
    const { credential } = await pool.pick();
    expect(credential.label).toBe('mainkey');
  });
});

describe('CredentialPool — requestCount', () => {
  it('increments requestCount on each pick', async () => {
    isolateHomes();

    await addCredential(makeCredential('solo', 10));
    const pool = new CredentialPool('anthropic');

    const r1 = await pool.pick();
    expect(r1.credential.requestCount).toBe(1);

    const r2 = await pool.pick();
    expect(r2.credential.requestCount).toBe(2);

    const r3 = await pool.pick();
    expect(r3.credential.requestCount).toBe(3);
  });
});

describe('CredentialPool.listEntries()', () => {
  it('returns all entries sorted by priority descending', async () => {
    isolateHomes();

    await addCredential(makeCredential('low', 10));
    await addCredential(makeCredential('mid', 50));
    await addCredential(makeCredential('high', 100));

    const pool = new CredentialPool('anthropic');
    const entries = await pool.listEntries();

    expect(entries.map((e) => e.label)).toEqual(['high', 'mid', 'low']);
  });
});

describe('CredentialPool — cooldown expiry', () => {
  it('becomes eligible again once Date.now() > lastErrorResetAt', async () => {
    isolateHomes();
    vi.useFakeTimers();

    await addCredential(makeCredential('expiring', 10));
    const pool = new CredentialPool('anthropic');

    // Apply a 60-second cooldown (500 error).
    await pool.markExhausted('expiring', 500);

    // Still in cooldown — should throw.
    await expect(pool.pick()).rejects.toBeInstanceOf(PoolExhaustedError);

    // Advance time past the 60-second cooldown.
    vi.setSystemTime(Date.now() + 61_000);

    // Now it should be eligible.
    const { credential } = await pool.pick();
    expect(credential.label).toBe('expiring');
  });
});
