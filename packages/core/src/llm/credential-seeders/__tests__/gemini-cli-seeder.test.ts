/**
 * Unit tests for the Gemini (Google PKCE) credential seeder (T9418).
 *
 * Filesystem is pinned to a temp `CLEO_HOME`. `globalThis.fetch` is spied
 * to intercept the Google token-refresh call. No real network traffic.
 *
 * @task T9418
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiCliSeeder, geminiCliSeeder, getGoogleOauthPath } from '../gemini-cli-seeder.js';

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = ['CLEO_HOME', 'CLEO_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'];

let cleoHome: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  cleoHome = join(
    tmpdir(),
    `cleo-gemini-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(cleoHome, { recursive: true });
  process.env['CLEO_HOME'] = cleoHome;
  _resetCleoPlatformPathsCache();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  _resetCleoPlatformPathsCache();
  vi.restoreAllMocks();
  try {
    rmSync(cleoHome, { recursive: true, force: true });
  } catch {
    /* tmp cleanup is best-effort */
  }
});

function writeOauthFile(payload: unknown): void {
  writeFileSync(join(cleoHome, 'google_oauth.json'), JSON.stringify(payload), 'utf-8');
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('getGoogleOauthPath', () => {
  it('routes through getCleoHome()', () => {
    expect(getGoogleOauthPath()).toBe(join(cleoHome, 'google_oauth.json'));
  });
});

// ---------------------------------------------------------------------------
// Seeder contract
// ---------------------------------------------------------------------------

describe('GeminiCliSeeder', () => {
  it('declares sourceId=gemini-cli and provider=gemini', () => {
    const seeder = new GeminiCliSeeder();
    expect(seeder.sourceId).toBe('gemini-cli');
    expect(seeder.provider).toBe('gemini');
  });

  it('exports a module-level singleton', () => {
    expect(geminiCliSeeder).toBeInstanceOf(GeminiCliSeeder);
  });

  it('returns empty when google_oauth.json does not exist', async () => {
    const result = await geminiCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits the stored entry when access_token is still valid', async () => {
    const future = Date.now() + 60 * 60 * 1000; // +1h, well past skew
    writeOauthFile({
      access_token: 'valid-access',
      refresh_token: 'rt-1',
      expires_at: future,
      email: 'user@example.com',
    });

    const result = await geminiCliSeeder.seed();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      provider: 'gemini',
      label: 'gemini-pkce',
      authType: 'oauth',
      accessToken: 'valid-access',
      expiresAt: future,
      source: 'gemini-cli',
      refreshToken: 'rt-1',
      metadata: { email: 'user@example.com' },
    });
  });

  it('refreshes an expired access_token via Google token endpoint', async () => {
    const past = Date.now() - 60_000; // already expired
    writeOauthFile({
      access_token: 'stale-access',
      refresh_token: 'rt-good',
      expires_at: past,
    });

    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        access_token: 'fresh-access',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );

    const result = await geminiCliSeeder.seed();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].accessToken).toBe('fresh-access');
    expect(result.entries[0].expiresAt).toBeGreaterThan(Date.now());
    // refreshToken preserved from disk when Google did not rotate.
    expect(result.entries[0].refreshToken).toBe('rt-good');
  });

  it('propagates a rotated refresh_token from Google', async () => {
    const past = Date.now() - 1000;
    writeOauthFile({
      access_token: 'stale',
      refresh_token: 'rt-old',
      expires_at: past,
    });

    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        access_token: 'fresh',
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      }),
    );

    const result = await geminiCliSeeder.seed();
    expect(result.entries[0].refreshToken).toBe('rt-rotated');
  });

  it('falls back to the stored access token with a warning when refresh fails', async () => {
    const past = Date.now() - 1000;
    writeOauthFile({
      access_token: 'stored-fallback',
      refresh_token: 'rt-revoked',
      expires_at: past,
    });

    fetchSpy.mockResolvedValueOnce(
      makeResponse(400, { error: 'invalid_grant', error_description: 'revoked' }),
    );

    const result = await geminiCliSeeder.seed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].accessToken).toBe('stored-fallback');
    expect(result.warnings?.[0]).toMatch(/refresh failed/);
  });

  it('returns empty with a warning on malformed JSON', async () => {
    writeFileSync(join(cleoHome, 'google_oauth.json'), '{not valid', 'utf-8');
    const result = await geminiCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/not valid JSON/);
  });

  it('returns empty with a warning when access_token is missing', async () => {
    writeOauthFile({ refresh_token: 'rt', expires_at: 0 });
    const result = await geminiCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/missing access_token/);
  });

  it('emits stored access_token unchanged when no expires_at is present', async () => {
    writeOauthFile({ access_token: 'no-expiry', refresh_token: 'rt' });
    const result = await geminiCliSeeder.seed();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].accessToken).toBe('no-expiry');
    expect(result.entries[0].expiresAt).toBeNull();
  });

  it('does NOT attempt refresh when refresh_token is absent (just emits stale entry)', async () => {
    const past = Date.now() - 1000;
    writeOauthFile({ access_token: 'lone-access', expires_at: past });
    const result = await geminiCliSeeder.seed();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.entries[0].accessToken).toBe('lone-access');
  });
});
