/**
 * T11939 — service-vault OAuth flow: build / exchange / refresh / self-heal.
 *
 * In-process tests (NO subprocess) against a TEMP-DIR global `cleo.db` (never
 * `.cleo/*.db`) with an INJECTED `fetch` stub (no network) and a FAKE CLOCK:
 *
 *  - AC1 buildAuthUrl — produces a correct PKCE S256 auth URL (challenge + state +
 *    provider `extraAuthParams`); a missing auth endpoint throws.
 *  - AC1 exchangeCode — POSTs the code to a mocked token endpoint and PERSISTS the
 *    `{accessToken, refreshToken}` blob; the token is CIPHERTEXT at rest and the
 *    plaintext is reached ONLY via the sealed handle.
 *  - AC2 refreshAccessToken — honors the per-provider refresh config (Form/Json ×
 *    Body/BasicAuth), asserted by inspecting the captured request.
 *  - AC3 selfHealConnection — an EXPIRED connection (fake clock past `expires_at`)
 *    is transparently refreshed, re-encrypted, and persisted back; the sealed
 *    handle yields the FRESH token and the stale token never leaks.
 *
 * @task T11939
 * @epic T11765
 * @saga T10409
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleoGlobalDb } from '../dual-scope-db.js';
import { _resetDualScopeDbCache } from '../dual-scope-db.js';
import {
  connectService,
  grantAgentAccess,
  openServiceVaultAtPath,
  resolveSealedConnection,
  type ServiceVaultDeps,
} from '../service-connections-accessor.js';
import {
  buildAuthUrl,
  exchangeCode,
  type FetchLike,
  refreshAccessToken,
  type ServiceOAuthDeps,
  selfHealConnection,
} from '../service-oauth.js';

let testRoot: string;
let db: CleoGlobalDb;

beforeEach(async () => {
  testRoot = join(
    tmpdir(),
    `service-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testRoot, { recursive: true });
  db = await openServiceVaultAtPath(join(testRoot, 'cleo.db'));
});

afterEach(() => {
  _resetDualScopeDbCache();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** Reach the native handle for raw column-value assertions. */
function native(handle: CleoGlobalDb): DatabaseSync {
  return (handle as unknown as { $client: DatabaseSync }).$client;
}

/** A captured request the fetch stub recorded. */
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Build a fetch stub that returns a canned JSON token response and records calls. */
function makeFetchStub(
  responseBody: Record<string, unknown>,
  captured: CapturedRequest[],
  status = 200,
): FetchLike {
  return async (url, init) => {
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ?? '',
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
}

describe('buildAuthUrl (AC1)', () => {
  it('produces a PKCE S256 auth URL with challenge, state, and provider extra params (google)', async () => {
    const result = await buildAuthUrl('google', { state: 'fixed-state' });
    const url = new URL(result.authUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('fixed-state');
    // Google requires offline access + consent to issue a refresh token.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    // The verifier is the secret counterpart; a real base64url string (43+ chars).
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(result.codeVerifier).not.toBe(url.searchParams.get('code_challenge'));
  });

  it('generates a random state when none is supplied', async () => {
    const a = await buildAuthUrl('github');
    const b = await buildAuthUrl('github');
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('throws for an unknown provider', async () => {
    await expect(buildAuthUrl('not-a-real-provider')).rejects.toThrow('E_SERVICE_PROVIDER_UNKNOWN');
  });

  it('throws for an api-key-only provider (no oauth)', async () => {
    await expect(buildAuthUrl('resend')).rejects.toThrow('E_SERVICE_OAUTH_UNSUPPORTED');
  });
});

describe('exchangeCode (AC1) — persists encrypted, sealed plaintext only', () => {
  it('exchanges a code, encrypts the blob at rest, and resolves the plaintext via the sealed handle', async () => {
    const captured: CapturedRequest[] = [];
    const deps: ServiceOAuthDeps = {
      fetch: makeFetchStub(
        {
          access_token: 'acc-tok-123',
          refresh_token: 'ref-tok-456',
          expires_in: 3600,
          token_type: 'bearer',
        },
        captured,
      ),
      now: () => 1_700_000_000_000,
      vault: { db },
    };
    const result = await exchangeCode(
      'google',
      {
        code: 'auth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:7878/cb',
        label: 'personal',
      },
      deps,
    );
    expect(result.provider).toBe('google');
    expect(result.label).toBe('personal');
    expect(result.hasRefreshToken).toBe(true);
    expect(result.expiresAt).toBe(new Date(1_700_000_000_000 + 3600_000).toISOString());

    // The POST hit the token endpoint with the authorization_code grant.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://oauth2.googleapis.com/token');

    // CIPHERTEXT at rest — the raw column must NOT contain the plaintext token.
    const raw = native(db)
      .prepare('SELECT credentials_enc FROM service_connections WHERE provider = ? AND label = ?')
      .get('google', 'personal') as { credentials_enc: string } | undefined;
    expect(raw?.credentials_enc).toBeTruthy();
    expect(raw?.credentials_enc).not.toContain('acc-tok-123');
    expect(raw?.credentials_enc).not.toContain('ref-tok-456');

    // The plaintext is reachable ONLY via the sealed handle (granted agent).
    const agentId = 'agent-x';
    await grantAgentAccess(agentId, result.connectionId, { mode: 'allow' }, { db });
    const sealed = await resolveSealedConnection(
      { agentId, provider: 'google', label: 'personal' },
      { db },
    );
    expect(sealed).not.toBeNull();
    const tok = await sealed?.fetch();
    expect(tok?.value).toBe('acc-tok-123');
  });
});

describe('refreshAccessToken (AC2) — honors per-provider refresh config', () => {
  it('google — form body, client credentials in body', async () => {
    const captured: CapturedRequest[] = [];
    const tokens = await refreshAccessToken(
      'google',
      { refreshToken: 'rt-1', client: { clientId: 'cid', clientSecret: 'csec' } },
      { fetch: makeFetchStub({ access_token: 'new-acc', expires_in: 3600 }, captured) },
    );
    expect(tokens.accessToken).toBe('new-acc');
    const req = captured[0];
    expect(req?.url).toBe('https://oauth2.googleapis.com/token');
    expect(req?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // Form body carries grant_type + client credentials.
    expect(req?.body).toContain('grant_type=refresh_token');
    expect(req?.body).toContain('client_id=cid');
    expect(req?.body).toContain('client_secret=csec');
    expect(req?.headers['authorization']).toBeUndefined();
  });

  it('atlassian (jira) — JSON body', async () => {
    const captured: CapturedRequest[] = [];
    await refreshAccessToken(
      'jira',
      { refreshToken: 'rt-2', client: { clientId: 'cid', clientSecret: 'csec' } },
      { fetch: makeFetchStub({ access_token: 'jira-acc', expires_in: 3600 }, captured) },
    );
    const req = captured[0];
    expect(req?.headers['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(req?.body ?? '{}');
    expect(parsed.grant_type).toBe('refresh_token');
    expect(parsed.refresh_token).toBe('rt-2');
    expect(parsed.client_id).toBe('cid');
  });

  it('notion — JSON body + BasicAuth client credentials (header, not body)', async () => {
    const captured: CapturedRequest[] = [];
    await refreshAccessToken(
      'notion',
      { refreshToken: 'rt-3', client: { clientId: 'nid', clientSecret: 'nsec' } },
      { fetch: makeFetchStub({ access_token: 'notion-acc', expires_in: 3600 }, captured) },
    );
    const req = captured[0];
    expect(req?.headers['Content-Type']).toBe('application/json');
    // BasicAuth: credentials in the Authorization header, NOT the body.
    expect(req?.headers['authorization']).toBe(
      `Basic ${Buffer.from('nid:nsec').toString('base64')}`,
    );
    const parsed = JSON.parse(req?.body ?? '{}');
    expect(parsed.client_id).toBeUndefined();
    expect(parsed.refresh_token).toBe('rt-3');
  });

  it('supabase — form body + BasicAuth client credentials', async () => {
    const captured: CapturedRequest[] = [];
    await refreshAccessToken(
      'supabase',
      { refreshToken: 'rt-4', client: { clientId: 'sid', clientSecret: 'ssec' } },
      { fetch: makeFetchStub({ access_token: 'sb-acc', expires_in: 3600 }, captured) },
    );
    const req = captured[0];
    expect(req?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req?.headers['authorization']).toBe(
      `Basic ${Buffer.from('sid:ssec').toString('base64')}`,
    );
    expect(req?.body).toContain('grant_type=refresh_token');
    expect(req?.body).not.toContain('client_secret=ssec');
  });

  it('mongodb-atlas — client_credentials grant (special variant)', async () => {
    const captured: CapturedRequest[] = [];
    const tokens = await refreshAccessToken(
      'mongodb-atlas',
      { client: { clientId: 'maid', clientSecret: 'masec' } },
      { fetch: makeFetchStub({ access_token: 'atlas-acc', expires_in: 3600 }, captured) },
    );
    expect(tokens.accessToken).toBe('atlas-acc');
    const req = captured[0];
    expect(req?.headers['Authorization']).toBe(
      `Basic ${Buffer.from('maid:masec').toString('base64')}`,
    );
    expect(req?.body).toBe('grant_type=client_credentials');
  });

  it('throws when a refresh-token provider has no refresh token', async () => {
    await expect(
      refreshAccessToken('google', {}, { fetch: makeFetchStub({}, []) }),
    ).rejects.toThrow('E_SERVICE_REFRESH_NO_TOKEN');
  });

  it('throws for a provider with no refresh config (monday)', async () => {
    await expect(
      refreshAccessToken('monday', { refreshToken: 'x' }, { fetch: makeFetchStub({}, []) }),
    ).rejects.toThrow('E_SERVICE_REFRESH_UNSUPPORTED');
  });

  it('surfaces a non-OK token endpoint response', async () => {
    await expect(
      refreshAccessToken(
        'google',
        { refreshToken: 'rt', client: { clientId: 'c', clientSecret: 's' } },
        { fetch: makeFetchStub({ error: 'invalid_grant' }, [], 400) },
      ),
    ).rejects.toThrow('E_SERVICE_REFRESH_HTTP');
  });
});

describe('selfHealConnection (AC3) — transparent refresh of an expired token', () => {
  const T0 = 1_700_000_000_000; // a fixed "now"
  const agentId = 'agent-heal';

  /** Seed an EXPIRED google connection (expires_at one hour in the past). */
  async function seedExpired(): Promise<number> {
    const pastExpiry = new Date(T0 - 3600_000).toISOString();
    const connId = await connectService(
      {
        provider: 'google',
        label: 'work',
        tokens: { accessToken: 'STALE-access', refreshToken: 'good-refresh' },
        expiresAt: pastExpiry,
      },
      { db },
    );
    await grantAgentAccess(agentId, connId, { mode: 'allow' }, { db });
    return connId;
  }

  it('refreshes, re-encrypts, persists, and yields the FRESH token (no stale leak)', async () => {
    await seedExpired();
    const captured: CapturedRequest[] = [];
    const deps: ServiceOAuthDeps = {
      fetch: makeFetchStub(
        { access_token: 'FRESH-access', refresh_token: 'rotated-refresh', expires_in: 3600 },
        captured,
      ),
      now: () => T0, // fake clock: T0 is past the seeded expiry → refresh fires
      vault: { db },
    };
    const result = await selfHealConnection(
      { agentId, provider: 'google', label: 'work', client: { clientId: 'c', clientSecret: 's' } },
      deps,
    );

    // A refresh fired against the token endpoint.
    expect(result.refreshed).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(captured[0]?.body).toContain('refresh_token=good-refresh');

    // The sealed handle yields the FRESH token — the stale one never leaks.
    expect(result.sealed).not.toBeNull();
    const tok = await result.sealed?.fetch();
    expect(tok?.value).toBe('FRESH-access');
    expect(tok?.value).not.toBe('STALE-access');

    // The new expiry is in the future (T0 + 3600s).
    expect(result.expiresAt).toBe(new Date(T0 + 3600_000).toISOString());

    // PERSISTED back: the row is now ciphertext of the fresh blob (rotated refresh).
    const raw = native(db)
      .prepare(
        'SELECT credentials_enc, expires_at FROM service_connections WHERE provider = ? AND label = ?',
      )
      .get('google', 'work') as { credentials_enc: string; expires_at: string } | undefined;
    expect(raw?.credentials_enc).not.toContain('FRESH-access'); // encrypted, not plaintext
    expect(raw?.credentials_enc).not.toContain('STALE-access');
    expect(raw?.expires_at).toBe(new Date(T0 + 3600_000).toISOString());

    // A SECOND resolve (token now fresh) does NOT refresh again.
    const captured2: CapturedRequest[] = [];
    const result2 = await selfHealConnection(
      { agentId, provider: 'google', label: 'work', client: { clientId: 'c', clientSecret: 's' } },
      { ...deps, fetch: makeFetchStub({}, captured2) },
    );
    expect(result2.refreshed).toBe(false);
    expect(captured2).toHaveLength(0);
    const tok2 = await result2.sealed?.fetch();
    expect(tok2?.value).toBe('FRESH-access');
  });

  it('does NOT refresh a non-expired connection', async () => {
    const futureExpiry = new Date(T0 + 3600_000).toISOString();
    const connId = await connectService(
      {
        provider: 'google',
        label: 'fresh',
        tokens: { accessToken: 'current-access', refreshToken: 'rt' },
        expiresAt: futureExpiry,
      },
      { db },
    );
    await grantAgentAccess(agentId, connId, { mode: 'allow' }, { db });
    const captured: CapturedRequest[] = [];
    const result = await selfHealConnection(
      { agentId, provider: 'google', label: 'fresh', client: { clientId: 'c', clientSecret: 's' } },
      { fetch: makeFetchStub({}, captured), now: () => T0, vault: { db } },
    );
    expect(result.refreshed).toBe(false);
    expect(captured).toHaveLength(0);
    const tok = await result.sealed?.fetch();
    expect(tok?.value).toBe('current-access');
  });

  it('denies a non-granted agent WITHOUT decrypting (policy-before-decrypt)', async () => {
    await seedExpired();
    const decryptSpy = vi.fn(async (ct: string, _id: string) => ct);
    const deps: ServiceOAuthDeps = {
      fetch: makeFetchStub({ access_token: 'should-not-be-used', expires_in: 3600 }, []),
      now: () => T0,
      vault: { db, decrypt: decryptSpy as ServiceVaultDeps['decrypt'] },
    };
    const result = await selfHealConnection(
      { agentId: 'intruder', provider: 'google', label: 'work' },
      deps,
    );
    expect(result.sealed).toBeNull();
    expect(result.refreshed).toBe(false);
    expect(decryptSpy).not.toHaveBeenCalled();
  });
});
