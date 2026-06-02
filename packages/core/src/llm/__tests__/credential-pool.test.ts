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
// T9403: include CLEO_HOME so getCleoHome() resolves into per-test sandbox.
const ENV_KEYS = [
  'XDG_DATA_HOME',
  'CLEO_HOME',
  'HOME',
  'CLEO_DIR',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
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
  // T9403: getCleoHome() honours CLEO_HOME first; mirror the XDG layout.
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
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

// ---------------------------------------------------------------------------
// AC#2 — proactiveRefresh (T9323)
// ---------------------------------------------------------------------------

describe('CredentialPool.proactiveRefresh() — no-ops for non-OAuth credentials', () => {
  it('no-ops for api_key credentials', async () => {
    isolateHomes();

    await addCredential(
      makeCredential('apikey-cred', 10, {
        authType: 'api_key',
        expiresAt: Date.now() + 100,
        refreshToken: undefined,
      }),
    );

    const pool = new CredentialPool('anthropic');
    const refreshed = await pool.proactiveRefresh('apikey-cred');
    expect(refreshed).toBe(false);
  });

  it('no-ops when expiresAt is null', async () => {
    isolateHomes();

    await addCredential(
      makeCredential('oauth-no-expiry', 10, {
        authType: 'oauth',
        expiresAt: null,
        refreshToken: 'some-refresh-token',
      }),
    );

    const pool = new CredentialPool('anthropic');
    const refreshed = await pool.proactiveRefresh('oauth-no-expiry');
    expect(refreshed).toBe(false);
  });

  it('no-ops when no refreshToken is stored', async () => {
    isolateHomes();

    await addCredential(
      makeCredential('oauth-no-refresh', 10, {
        authType: 'oauth',
        expiresAt: Date.now() + 100,
        refreshToken: undefined,
      }),
    );

    const pool = new CredentialPool('anthropic');
    const refreshed = await pool.proactiveRefresh('oauth-no-refresh');
    expect(refreshed).toBe(false);
  });

  it('no-ops for a non-existent label', async () => {
    isolateHomes();

    const pool = new CredentialPool('anthropic');
    const refreshed = await pool.proactiveRefresh('ghost');
    expect(refreshed).toBe(false);
  });
});

describe('CredentialPool.proactiveRefresh() — OAuth credential threshold', () => {
  it('no-ops when remaining lifetime > 300s (floor not triggered)', async () => {
    isolateHomes();
    vi.useFakeTimers();

    // expiresAt = 10 minutes from now; remaining = 600s > 300s floor
    const expiresAt = Date.now() + 10 * 60 * 1000;
    await addCredential(
      makeCredential('long-lived', 10, {
        authType: 'oauth',
        expiresAt,
        refreshToken: 'tok-refresh',
      }),
    );

    const pool = new CredentialPool('anthropic');
    // No fetch mock set up — if refresh is attempted it will fail/throw
    const refreshed = await pool.proactiveRefresh('long-lived');
    expect(refreshed).toBe(false);
  });

  it('returns true when remaining lifetime < 300s (floor threshold)', async () => {
    isolateHomes();
    vi.useFakeTimers();

    // expiresAt = 200s from now (< 300s floor)
    const expiresAt = Date.now() + 200_000;
    await addCredential(
      makeCredential('soon-expiring', 10, {
        provider: 'kimi-code',
        authType: 'oauth',
        expiresAt,
        refreshToken: 'kimi-refresh-tok',
      }),
    );

    // Mock global fetch for the kimi-code token endpoint
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'sk-kimi-new-access-token',
          refresh_token: 'kimi-new-refresh-tok',
          expires_in: 900,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const pool = new CredentialPool('kimi-code');
    const refreshed = await pool.proactiveRefresh('soon-expiring');

    expect(refreshed).toBe(true);
    fetchSpy.mockRestore();
  });

  it('updates kimi-code credential store with new token after successful refresh', async () => {
    isolateHomes();
    vi.useFakeTimers();

    const expiresAt = Date.now() + 200_000;
    await addCredential(
      makeCredential('kimi-refresh-test', 10, {
        provider: 'kimi-code',
        authType: 'oauth',
        expiresAt,
        refreshToken: 'old-refresh-tok',
      }),
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'sk-kimi-brand-new',
          refresh_token: 'new-refresh-tok',
          expires_in: 900,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const pool = new CredentialPool('kimi-code');
    await pool.proactiveRefresh('kimi-refresh-test');

    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'kimi-refresh-test');
    expect(entry?.accessToken).toBe('sk-kimi-brand-new');
    expect(entry?.refreshToken).toBe('new-refresh-tok');
    vi.restoreAllMocks();
  });

  it('proactively refreshes Anthropic OAuth credential at <300s remaining', async () => {
    isolateHomes();
    vi.useFakeTimers();

    const expiresAt = Date.now() + 200_000;
    await addCredential(
      makeCredential('anthropic-oauth', 10, {
        provider: 'anthropic',
        authType: 'oauth',
        expiresAt,
        refreshToken: 'ant-refresh-tok',
      }),
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat-new-access',
          refresh_token: 'ant-new-refresh-tok',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const pool = new CredentialPool('anthropic');
    const refreshed = await pool.proactiveRefresh('anthropic-oauth');

    expect(refreshed).toBe(true);
    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'anthropic-oauth');
    expect(entry?.accessToken).toBe('sk-ant-oat-new-access');
    vi.restoreAllMocks();
  });

  it('PKCE-mode refresh POSTs grant_type=refresh_token to the PKCE token endpoint', async () => {
    isolateHomes();
    vi.useFakeTimers();

    const expiresAt = Date.now() + 200_000;
    await addCredential(
      makeCredential('anthropic-pkce', 10, {
        provider: 'anthropic',
        authType: 'oauth',
        expiresAt,
        refreshToken: 'ant-pkce-refresh-tok',
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'sk-ant-pkce-new',
          refresh_token: 'ant-pkce-new-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const pool = new CredentialPool('anthropic');
    await pool.proactiveRefresh('anthropic-pkce');

    // Verify it called the Anthropic token endpoint with refresh_token grant.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('anthropic.com');
    expect(String(init.body)).toContain('grant_type=refresh_token');
    expect(String(init.body)).toContain('refresh_token=ant-pkce-refresh-tok');

    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'anthropic-pkce');
    expect(entry?.accessToken).toBe('sk-ant-pkce-new');
    vi.restoreAllMocks();
  });

  it('silently no-ops when the PKCE refresh endpoint returns a non-200', async () => {
    isolateHomes();
    vi.useFakeTimers();

    const expiresAt = Date.now() + 200_000;
    await addCredential(
      makeCredential('anthropic-pkce-fail', 10, {
        provider: 'anthropic',
        authType: 'oauth',
        expiresAt,
        refreshToken: 'old-tok',
        accessToken: 'old-access-tok',
      }),
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const pool = new CredentialPool('anthropic');
    // Should return true (refresh attempted), but not throw.
    const refreshed = await pool.proactiveRefresh('anthropic-pkce-fail');
    expect(refreshed).toBe(true);

    // Token should be unchanged.
    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'anthropic-pkce-fail');
    expect(entry?.accessToken).toBe('old-access-tok');
    vi.restoreAllMocks();
  });
});

describe('CredentialPool.refreshExpiredOAuth() — self-heal on resolve (T11617)', () => {
  it('refreshes an ALREADY-EXPIRED OAuth credential that has a refresh token', async () => {
    isolateHomes();

    // expiresAt in the PAST (negative remaining) — previously dropped, now renewed.
    const expiresAt = Date.now() - 60_000;
    await addCredential(
      makeCredential('anthropic-expired', 10, {
        provider: 'anthropic',
        authType: 'oauth',
        expiresAt,
        refreshToken: 'ant-expired-refresh-tok',
        accessToken: 'sk-ant-stale',
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'sk-ant-renewed',
          refresh_token: 'ant-renewed-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const pool = new CredentialPool('anthropic');
    const attempted = await pool.refreshExpiredOAuth();

    expect(attempted).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const entries = await pool.listEntries();
    const entry = entries.find((e) => e.label === 'anthropic-expired');
    expect(entry?.accessToken).toBe('sk-ant-renewed');
    vi.restoreAllMocks();
  });

  it('skips non-OAuth and refresh-token-less entries (no network)', async () => {
    isolateHomes();

    await addCredential(makeCredential('api-key-entry', 50)); // api_key, no refresh
    await addCredential(
      makeCredential('oauth-no-refresh', 40, {
        authType: 'oauth',
        expiresAt: Date.now() - 1000, // expired but NO refresh token
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pool = new CredentialPool('anthropic');
    const attempted = await pool.refreshExpiredOAuth();

    expect(attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('does not refresh a still-valid OAuth token', async () => {
    isolateHomes();

    await addCredential(
      makeCredential('valid-oauth', 30, {
        authType: 'oauth',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1h out — well past the floor
        refreshToken: 'still-valid-refresh',
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pool = new CredentialPool('anthropic');
    const attempted = await pool.refreshExpiredOAuth();

    expect(attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
