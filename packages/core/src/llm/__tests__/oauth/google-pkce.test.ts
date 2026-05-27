/**
 * Unit tests for the Google OAuth refresh helper (T9418).
 *
 * `globalThis.fetch` is spied so no real network traffic occurs.
 *
 * @task T9418
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GOOGLE_CLIENT_ID,
  DEFAULT_GOOGLE_CLIENT_SECRET,
  ENV_GOOGLE_CLIENT_ID,
  ENV_GOOGLE_CLIENT_SECRET,
  GOOGLE_OAUTH_TOKEN_ENDPOINT,
  refreshGoogleAccessToken,
} from '../../oauth/google-pkce.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = [ENV_GOOGLE_CLIENT_ID, ENV_GOOGLE_CLIENT_SECRET];

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// refreshGoogleAccessToken
// ---------------------------------------------------------------------------

describe('refreshGoogleAccessToken', () => {
  it('rejects an empty refresh token without making a network call', async () => {
    await expect(refreshGoogleAccessToken('')).rejects.toThrow(/refresh_token is empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the Google token endpoint with form-urlencoded body', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'fresh', expires_in: 1800, token_type: 'Bearer' }),
    );

    await refreshGoogleAccessToken('rt-abc');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(GOOGLE_OAUTH_TOKEN_ENDPOINT);
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );

    const body = (init as RequestInit).body;
    expect(typeof body).toBe('string');
    const params = new URLSearchParams(body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt-abc');
    expect(params.get('client_id')).toBe(DEFAULT_GOOGLE_CLIENT_ID);
    expect(params.get('client_secret')).toBe(DEFAULT_GOOGLE_CLIENT_SECRET);
  });

  it('returns a fresh access token + computed expiresAt', async () => {
    const before = Date.now();
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, { access_token: 'fresh-token', expires_in: 3600 }),
    );

    const result = await refreshGoogleAccessToken('rt');
    expect(result.accessToken).toBe('fresh-token');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 50);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 50);
    expect(result.refreshToken).toBeUndefined();
  });

  it('propagates a rotated refresh_token', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        access_token: 'fresh',
        refresh_token: 'rt-rotated',
        expires_in: 60,
      }),
    );
    const result = await refreshGoogleAccessToken('rt-old');
    expect(result.refreshToken).toBe('rt-rotated');
  });

  it('falls back to the default 1h expiry when expires_in is missing or invalid', async () => {
    const before = Date.now();
    fetchSpy.mockResolvedValueOnce(makeResponse(200, { access_token: 'fresh' }));
    const result = await refreshGoogleAccessToken('rt');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 50);
  });

  it('honours CLEO_GEMINI_CLIENT_ID / CLEO_GEMINI_CLIENT_SECRET overrides', async () => {
    process.env[ENV_GOOGLE_CLIENT_ID] = 'custom-cid';
    process.env[ENV_GOOGLE_CLIENT_SECRET] = 'custom-csecret';

    fetchSpy.mockResolvedValueOnce(makeResponse(200, { access_token: 'fresh', expires_in: 100 }));
    await refreshGoogleAccessToken('rt');

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const params = new URLSearchParams(init.body as string);
    expect(params.get('client_id')).toBe('custom-cid');
    expect(params.get('client_secret')).toBe('custom-csecret');
  });

  it('throws with the error_description when Google returns 400', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(400, { error: 'invalid_grant', error_description: 'token revoked' }),
    );
    await expect(refreshGoogleAccessToken('rt')).rejects.toThrow(/HTTP 400 — token revoked/);
  });

  it('throws when the response is missing access_token', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, { expires_in: 3600 }));
    await expect(refreshGoogleAccessToken('rt')).rejects.toThrow(/missing access_token/);
  });
});
