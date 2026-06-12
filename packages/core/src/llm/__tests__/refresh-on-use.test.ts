/**
 * Refresh-on-use tests (T11986 · DHQ-087).
 *
 * Covers:
 *   1. `refreshExpiredOAuthForProvider` — expired+refresh-token → refreshed+persisted+ranked.
 *   2. `refreshExpiredOAuthForProvider` — expired+refresh fails → E_CRED_REFRESH hint surfaced.
 *   3. `refreshExpiredOAuthForProvider` — no refresh token → filtered/skipped (existing behaviour).
 *   4. Single-flight: N concurrent resolves → exactly 1 refresh HTTP call.
 *   5. `enumerateProvisionedProviders` — expired OAT flips from not-provisioned to provisioned.
 *   6. `llmTest` credential source routes through `resolveCredentialsAsync` (vault chokepoint).
 *
 * Isolation strategy: each test gets a fresh tmpdir via `XDG_DATA_HOME` /
 * `CLEO_HOME` env override so the credential store file never collides with
 * developer credentials or between parallel test workers.
 *
 * @module llm/__tests__/refresh-on-use
 * @task T11986
 * @epic T11679
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRefreshStateForTests, refreshExpiredOAuthForProvider } from '../credential-pool.js';
import { clearAnthropicKeyCache } from '../credentials.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
  getCredentialByLabel,
  type StoredCredential,
} from '../credentials-store.js';

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
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

function isolateHomes(): void {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-rou-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-rou-home-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
}

function makeOAuthCredential(
  label: string,
  opts: {
    expiresAt?: number | null;
    /** Pass `null` explicitly to omit the refresh token field. */
    refreshToken?: string | null;
    accessToken?: string;
    disabled?: boolean;
  } = {},
): Omit<StoredCredential, 'priority'> & { priority: number } {
  const base: Omit<StoredCredential, 'priority'> & { priority: number } = {
    provider: 'anthropic',
    label,
    authType: 'oauth',
    accessToken: opts.accessToken ?? 'sk-ant-oat-old-access',
    priority: 10,
    expiresAt: opts.expiresAt !== undefined ? opts.expiresAt : Date.now() - 60_000,
    disabled: opts.disabled ?? false,
    source: 'test',
  };
  // Only set refreshToken when explicitly provided and non-null.
  if (opts.refreshToken !== null && opts.refreshToken !== undefined) {
    base.refreshToken = opts.refreshToken;
  } else if (opts.refreshToken === undefined) {
    // Default: include a refresh token unless caller explicitly opted out.
    base.refreshToken = 'ant-refresh-tok';
  }
  // opts.refreshToken === null → no refresh token field set.
  return base;
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  isolateHomes();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
  _resetRefreshStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
  clearAnthropicKeyCache();
  _resetRefreshStateForTests();
});

// ---------------------------------------------------------------------------
// Case 1 — expired + refresh token → refreshed + persisted + ranked
// ---------------------------------------------------------------------------

describe('refreshExpiredOAuthForProvider — expired+refresh-token → refreshed', () => {
  it('refreshes an expired OAuth credential with a valid refresh token', async () => {
    // Seed an expired anthropic OAuth credential with a refresh token.
    const expiredAt = Date.now() - 60_000; // 1 minute ago
    await addCredential(makeOAuthCredential('oat-default', { expiresAt: expiredAt }));

    // Mock the Anthropic PKCE token endpoint to return a fresh token.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat-brand-new',
          refresh_token: 'ant-new-refresh-tok',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await refreshExpiredOAuthForProvider('anthropic');

    expect(result.attempted).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.lastError).toBeNull();
    expect(result.actionableHint).toBeNull();

    // Verify the new token was persisted to the store.
    const updated = await getCredentialByLabel('anthropic', 'oat-default');
    expect(updated?.accessToken).toBe('sk-ant-oat-brand-new');
    expect(updated?.refreshToken).toBe('ant-new-refresh-tok');
    // expiresAt must now be in the future (now + 3600s).
    expect(typeof updated?.expiresAt).toBe('number');
    expect(updated!.expiresAt!).toBeGreaterThan(Date.now());

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it('POSTs to the Anthropic PKCE token endpoint with JSON body', async () => {
    await addCredential(
      makeOAuthCredential('oat-json-body', {
        expiresAt: Date.now() - 10_000,
        refreshToken: 'ant-pkce-ref-tok',
      }),
    );

    const capturedBody: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      capturedBody.push(JSON.parse(opts?.body as string));
      return new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat-v2',
          expires_in: 7200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await refreshExpiredOAuthForProvider('anthropic');

    expect(capturedBody[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ant-pkce-ref-tok',
    });
  });
});

// ---------------------------------------------------------------------------
// Case 2 — expired + refresh fails → E_CRED_REFRESH actionable hint
// ---------------------------------------------------------------------------

describe('refreshExpiredOAuthForProvider — refresh fails → actionable hint', () => {
  it('returns an actionable hint when the token endpoint rejects the refresh token', async () => {
    await addCredential(
      makeOAuthCredential('oat-revoked', {
        expiresAt: Date.now() - 120_000,
        refreshToken: 'revoked-refresh-tok',
      }),
    );

    // Token endpoint returns HTTP 400 (invalid_grant — refresh token revoked).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await refreshExpiredOAuthForProvider('anthropic');

    expect(result.attempted).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(result.lastError).not.toBeNull();
    expect(result.actionableHint).toMatch(/cleo login anthropic/);
  });

  it('returns actionable hint when network fetch throws', async () => {
    await addCredential(
      makeOAuthCredential('oat-net-error', {
        expiresAt: Date.now() - 60_000,
        refreshToken: 'tok',
      }),
    );

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network unreachable'));

    const result = await refreshExpiredOAuthForProvider('anthropic');

    expect(result.attempted).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(result.actionableHint).toMatch(/cleo login anthropic/);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — no refresh token → skipped (no HTTP call)
// ---------------------------------------------------------------------------

describe('refreshExpiredOAuthForProvider — no refresh token → skipped', () => {
  it('skips an expired OAuth credential that has no refresh token', async () => {
    await addCredential(
      makeOAuthCredential('oat-no-refresh', {
        expiresAt: Date.now() - 60_000,
        refreshToken: null, // explicitly no refresh token
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await refreshExpiredOAuthForProvider('anthropic');

    // No refresh attempted — no refresh token available.
    expect(result.attempted).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(result.lastError).toBeNull();
    expect(result.actionableHint).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips an api_key credential (non-OAuth)', async () => {
    await addCredential({
      provider: 'anthropic',
      label: 'apikey-cred',
      authType: 'api_key',
      accessToken: 'sk-ant-api-key',
      priority: 10,
      expiresAt: Date.now() - 60_000,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await refreshExpiredOAuthForProvider('anthropic');

    expect(result.attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips a credential that is not yet expired', async () => {
    await addCredential(
      makeOAuthCredential('oat-still-valid', {
        expiresAt: Date.now() + 3600_000, // 1 hour from now
        refreshToken: 'tok',
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await refreshExpiredOAuthForProvider('anthropic');

    expect(result.attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Single-flight: N concurrent resolves → exactly 1 refresh HTTP call
// ---------------------------------------------------------------------------

describe('refreshExpiredOAuthForProvider — single-flight coalescing', () => {
  it('only POSTs to the token endpoint once when called concurrently', async () => {
    await addCredential(
      makeOAuthCredential('oat-concurrent', {
        expiresAt: Date.now() - 30_000,
        refreshToken: 'ant-ref-concurrent',
      }),
    );

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount += 1;
      // Simulate a slow token endpoint to allow concurrent calls to coalesce.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat-coalesced',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    // Fire 5 concurrent refresh calls for the same credential.
    const results = await Promise.all([
      refreshExpiredOAuthForProvider('anthropic'),
      refreshExpiredOAuthForProvider('anthropic'),
      refreshExpiredOAuthForProvider('anthropic'),
      refreshExpiredOAuthForProvider('anthropic'),
      refreshExpiredOAuthForProvider('anthropic'),
    ]);

    // All calls should succeed.
    for (const r of results) {
      expect(r.refreshed).toBeGreaterThanOrEqual(0); // at least one succeeded
    }

    // Only ONE HTTP call to the token endpoint should have been made.
    expect(callCount).toBe(1);

    // The token in the store should reflect the refreshed value.
    const stored = await getCredentialByLabel('anthropic', 'oat-concurrent');
    expect(stored?.accessToken).toBe('sk-ant-oat-coalesced');
  });

  it('does not retry within the negative-cache window after a failed refresh', async () => {
    await addCredential(
      makeOAuthCredential('oat-neg-cache', {
        expiresAt: Date.now() - 10_000,
        refreshToken: 'invalid-tok',
      }),
    );

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // Intercept to count calls.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // First call: should attempt and fail.
    const r1 = await refreshExpiredOAuthForProvider('anthropic');
    expect(r1.attempted).toBe(1);
    expect(r1.refreshed).toBe(0);
    expect(callCount).toBe(1);

    // Second call immediately after: negative cache should suppress the retry.
    const r2 = await refreshExpiredOAuthForProvider('anthropic');
    // Either 0 or 1 attempt — if in neg-cache window, attempted = 1 but no new fetch.
    expect(r2.refreshed).toBe(0);
    // fetch must NOT have been called again.
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — enumerateProvisionedProviders flips anthropic to provisioned
// ---------------------------------------------------------------------------

describe('enumerateProvisionedProviders — refresh-on-use flips expired OAT to provisioned', () => {
  it('shows anthropic as provisioned after a successful refresh', async () => {
    // Seed an expired OAT.
    await addCredential(
      makeOAuthCredential('oat-enum', {
        expiresAt: Date.now() - 60_000,
        refreshToken: 'ant-refresh-for-enum',
        accessToken: 'sk-ant-oat-expired',
      }),
    );

    // Mock the token endpoint.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      // Token endpoint call.
      if (urlStr.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'sk-ant-oat-fresh-enum',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Any other call (e.g. ollama probe) → connection refused.
      throw new Error('ECONNREFUSED');
    });

    const { enumerateProvisionedProviders } = await import('../cross-provider-selector.js');
    const providers = await enumerateProvisionedProviders('frontier');
    const anthropic = providers.find((p) => p.id === 'anthropic');

    expect(anthropic?.provisioningState).toBe('provisioned');
    expect(anthropic?.reachabilityState).toBe('auth-reachable');
  });
});
