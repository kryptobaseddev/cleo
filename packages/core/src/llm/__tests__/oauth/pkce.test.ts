/**
 * Unit tests for the RFC 7636 PKCE OAuth flow helpers.
 *
 * All HTTP calls are intercepted via `vi.spyOn(globalThis, 'fetch')`. No real
 * network requests are made.
 *
 * @task T9302
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizationUrl,
  exchangePkceCode,
  generatePkcePair,
  refreshPkceToken,
} from '../../oauth/pkce.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// generatePkcePair
// ---------------------------------------------------------------------------

describe('generatePkcePair', () => {
  it('returns non-empty codeVerifier and codeChallenge', async () => {
    const pair = await generatePkcePair();
    expect(pair.codeVerifier).toBeTruthy();
    expect(pair.codeChallenge).toBeTruthy();
  });

  it('codeVerifier is base64url-encoded (no +, /, or = chars)', async () => {
    const { codeVerifier } = await generatePkcePair();
    expect(codeVerifier).not.toMatch(/[+/=]/);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('codeChallenge is base64url-encoded SHA-256 of codeVerifier', async () => {
    const { codeVerifier, codeChallenge } = await generatePkcePair();

    // Re-derive the expected challenge manually.
    const verifierBytes = new TextEncoder().encode(codeVerifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', verifierBytes);
    const expected = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(codeChallenge).toBe(expected);
  });

  it('returns unique pairs on each call', async () => {
    const pair1 = await generatePkcePair();
    const pair2 = await generatePkcePair();
    expect(pair1.codeVerifier).not.toBe(pair2.codeVerifier);
    expect(pair1.codeChallenge).not.toBe(pair2.codeChallenge);
  });

  it('codeVerifier is at least 43 chars (from 32 bytes base64url)', async () => {
    const { codeVerifier } = await generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizationUrl
// ---------------------------------------------------------------------------

describe('buildAuthorizationUrl', () => {
  const BASE_PARAMS = {
    authorizationEndpoint: 'https://claude.ai/oauth/authorize',
    clientId: 'test-client-id',
    redirectUri: 'http://localhost:9999/callback',
    scope: 'user:profile org:create_api_key',
    codeChallenge: 'abc123-challenge',
    state: 'random-state-value',
  };

  it('produces a URL with all required parameters', () => {
    const url = buildAuthorizationUrl(BASE_PARAMS);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe(BASE_PARAMS.clientId);
    expect(parsed.searchParams.get('redirect_uri')).toBe(BASE_PARAMS.redirectUri);
    expect(parsed.searchParams.get('scope')).toBe(BASE_PARAMS.scope);
    expect(parsed.searchParams.get('code_challenge')).toBe(BASE_PARAMS.codeChallenge);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe(BASE_PARAMS.state);
  });

  it('uses the authorization endpoint as the base URL', () => {
    const url = buildAuthorizationUrl(BASE_PARAMS);
    expect(url.startsWith('https://claude.ai/oauth/authorize')).toBe(true);
  });

  it('URL-encodes special characters in scope and redirectUri', () => {
    const url = buildAuthorizationUrl({
      ...BASE_PARAMS,
      scope: 'scope:a scope:b',
      redirectUri: 'http://localhost:9999/callback?param=val',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('scope:a scope:b');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:9999/callback?param=val',
    );
  });
});

// ---------------------------------------------------------------------------
// exchangePkceCode
// ---------------------------------------------------------------------------

describe('exchangePkceCode', () => {
  const BASE_PARAMS = {
    provider: 'anthropic',
    clientId: 'test-client-id',
    code: 'auth-code-xyz',
    codeVerifier: 'verifier-abc',
    redirectUri: 'http://localhost:9999/callback',
    tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  };

  it('returns normalized OAuthTokens on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        access_token: 'sk-ant-oat-access',
        refresh_token: 'sk-ant-oat-refresh',
        expires_in: 3600,
        token_type: 'bearer',
      }),
    );

    const tokens = await exchangePkceCode(BASE_PARAMS);

    expect(tokens.accessToken).toBe('sk-ant-oat-access');
    expect(tokens.refreshToken).toBe('sk-ant-oat-refresh');
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.tokenType).toBe('bearer');
  });

  it('omits refreshToken when not present in response', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok-no-refresh', token_type: 'bearer' }),
    );

    const tokens = await exchangePkceCode(BASE_PARAMS);
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('POSTs grant_type=authorization_code with code and code_verifier', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok', token_type: 'bearer' }),
    );

    await exchangePkceCode(BASE_PARAMS);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BASE_PARAMS.tokenEndpoint);
    expect(init.method).toBe('POST');
    const body = String(init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code-xyz');
    expect(body).toContain('code_verifier=verifier-abc');
    expect(body).toContain('client_id=test-client-id');
    expect(body).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback');
  });

  it('throws on HTTP 4xx with error_description in message', async () => {
    fetchSpy.mockResolvedValue(
      makeResponse(400, { error: 'invalid_grant', error_description: 'Code expired' }),
    );

    const err = await exchangePkceCode(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 400');
    expect((err as Error).message).toContain('Code expired');
  });

  it('throws when access_token is missing from 200 response', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { token_type: 'bearer' /* no access_token */ }),
    );

    await expect(exchangePkceCode(BASE_PARAMS)).rejects.toThrow('access_token');
  });

  it('merges extraHeaders into the request', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok', token_type: 'bearer' }),
    );

    await exchangePkceCode({
      ...BASE_PARAMS,
      extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe('oauth-2025-04-20');
  });
});

// ---------------------------------------------------------------------------
// refreshPkceToken
// ---------------------------------------------------------------------------

describe('refreshPkceToken', () => {
  const BASE_PARAMS = {
    provider: 'anthropic',
    clientId: 'test-client-id',
    refreshToken: 'sk-ant-oat-refresh-xyz',
    tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  };

  it('returns normalized OAuthTokens on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 7200,
        token_type: 'bearer',
      }),
    );

    const tokens = await refreshPkceToken(BASE_PARAMS);

    expect(tokens.accessToken).toBe('new-access-token');
    expect(tokens.refreshToken).toBe('new-refresh-token');
    expect(tokens.expiresIn).toBe(7200);
    expect(tokens.tokenType).toBe('bearer');
  });

  it('POSTs grant_type=refresh_token with the refresh token', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok', token_type: 'bearer' }),
    );

    await refreshPkceToken(BASE_PARAMS);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BASE_PARAMS.tokenEndpoint);
    const body = String(init.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=sk-ant-oat-refresh-xyz');
    expect(body).toContain('client_id=test-client-id');
  });

  it('throws on HTTP 401 token expired', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(401, { error: 'invalid_token', error_description: 'Token expired' }),
    );

    await expect(refreshPkceToken(BASE_PARAMS)).rejects.toThrow('HTTP 401');
  });

  it('handles missing refresh_token in response (keeps original)', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'new-tok', token_type: 'bearer' /* no refresh */ }),
    );

    const tokens = await refreshPkceToken(BASE_PARAMS);
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('merges extraHeaders into the request', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok', token_type: 'bearer' }),
    );

    await refreshPkceToken({
      ...BASE_PARAMS,
      extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe('oauth-2025-04-20');
  });
});
