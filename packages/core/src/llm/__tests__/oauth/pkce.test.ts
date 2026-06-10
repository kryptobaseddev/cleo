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
  parseAuthorizationInput,
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
    tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
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

  it('T11774: surfaces the raw error body (not [object Object]) when no error_description', async () => {
    // Provider returns JSON with an unknown field structure — no error_description.
    // The improved extractErrorDetail must stringify the full body, not produce [object Object].
    fetchSpy.mockResolvedValue(makeResponse(400, { message: 'redirect_uri_mismatch', code: 400 }));

    const err = await exchangePkceCode(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 400');
    // Must NOT be [object Object]
    expect((err as Error).message).not.toContain('[object Object]');
    // Must contain the actual error field
    expect((err as Error).message).toContain('redirect_uri_mismatch');
  });

  it('T11774: surfaces raw text body when response is not valid JSON', async () => {
    // Simulate a provider that returns a plain-text or HTML error body.
    fetchSpy.mockResolvedValue(
      new Response('invalid_client: bad redirect_uri', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const err = await exchangePkceCode(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 400');
    expect((err as Error).message).toContain('bad redirect_uri');
  });

  it('T11958: surfaces the nested-object error body Anthropic actually returns (never [object Object])', async () => {
    // Anthropic's token endpoint nests the detail:
    //   {"type":"error","error":{"type":"invalid_grant","message":"..."}}
    // String(object) on that `error` field produced the undebuggable
    // "[object Object]" of DHQ-075.
    fetchSpy.mockResolvedValue(
      makeResponse(400, {
        type: 'error',
        error: { type: 'invalid_grant', message: 'redirect_uri does not match the code binding' },
      }),
    );

    const err = await exchangePkceCode(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('HTTP 400');
    expect((err as Error).message).not.toContain('[object Object]');
    expect((err as Error).message).toContain('invalid_grant');
    expect((err as Error).message).toContain('redirect_uri does not match the code binding');
  });

  it('T11958: nested-object error without a message field is JSON-stringified', async () => {
    fetchSpy.mockResolvedValue(makeResponse(400, { error: { code: 42, reason: 'opaque' } }));

    const err = await exchangePkceCode(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('[object Object]');
    expect((err as Error).message).toContain('"reason":"opaque"');
  });

  it("T11958: bodyFormat 'json' POSTs an application/json body including state", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok', token_type: 'bearer' }),
    );

    await exchangePkceCode({
      ...BASE_PARAMS,
      tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
      state: 'authorize-state-123',
      bodyFormat: 'json',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body['grant_type']).toBe('authorization_code');
    expect(body['code']).toBe('auth-code-xyz');
    expect(body['code_verifier']).toBe('verifier-abc');
    expect(body['client_id']).toBe('test-client-id');
    expect(body['state']).toBe('authorize-state-123');
  });

  it("T11958: default 'form' format omits state (not defined on RFC token requests)", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok', token_type: 'bearer' }),
    );

    await exchangePkceCode({ ...BASE_PARAMS, state: 'authorize-state-123' });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(String(init.body)).not.toContain('state=');
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
    tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
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

  it("T11958: bodyFormat 'json' POSTs an application/json refresh body", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'tok', token_type: 'bearer' }),
    );

    await refreshPkceToken({
      ...BASE_PARAMS,
      tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
      bodyFormat: 'json',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body['grant_type']).toBe('refresh_token');
    expect(body['refresh_token']).toBe('sk-ant-oat-refresh-xyz');
    expect(body['client_id']).toBe('test-client-id');
  });

  it('T11958: refresh error with nested-object body is never [object Object]', async () => {
    fetchSpy.mockResolvedValue(
      makeResponse(400, {
        type: 'error',
        error: { type: 'invalid_grant', message: 'refresh token revoked' },
      }),
    );

    const err = await refreshPkceToken(BASE_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('[object Object]');
    expect((err as Error).message).toContain('invalid_grant: refresh token revoked');
  });
});

// ---------------------------------------------------------------------------
// parseAuthorizationInput (T11958)
// ---------------------------------------------------------------------------

describe('parseAuthorizationInput', () => {
  it('parses a full redirect URL', () => {
    expect(
      parseAuthorizationInput(
        'https://platform.claude.com/oauth/code/callback?code=abc123&state=st-9',
      ),
    ).toEqual({ code: 'abc123', state: 'st-9' });
  });

  it('parses the code#state pair shown on the hosted callback page', () => {
    expect(parseAuthorizationInput('abc123#st-9')).toEqual({ code: 'abc123', state: 'st-9' });
  });

  it('parses a bare query string', () => {
    expect(parseAuthorizationInput('code=abc123&state=st-9')).toEqual({
      code: 'abc123',
      state: 'st-9',
    });
  });

  it('treats anything else as a bare authorization code', () => {
    expect(parseAuthorizationInput('  abc123  ')).toEqual({ code: 'abc123' });
  });

  it('returns empty for empty input', () => {
    expect(parseAuthorizationInput('   ')).toEqual({});
  });
});
