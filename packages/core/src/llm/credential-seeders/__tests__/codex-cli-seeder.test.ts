/**
 * Unit tests for the Codex CLI credential seeder (T9418).
 *
 * Filesystem is pinned to a temp dir via `CODEX_HOME`; the real
 * `~/.codex/auth.json` is never touched. No network calls.
 *
 * @task T9418
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexCliSeeder, codexCliSeeder, getCodexAuthPath } from '../codex-cli-seeder.js';

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

let codexHome: string;
let savedCodexHome: string | undefined;

beforeEach(() => {
  savedCodexHome = process.env['CODEX_HOME'];
  codexHome = join(
    tmpdir(),
    `cleo-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(codexHome, { recursive: true });
  process.env['CODEX_HOME'] = codexHome;
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = savedCodexHome;
  try {
    rmSync(codexHome, { recursive: true, force: true });
  } catch {
    /* tmp cleanup is best-effort */
  }
});

function writeAuthJson(payload: unknown): void {
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(payload), 'utf-8');
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('getCodexAuthPath', () => {
  it('honours CODEX_HOME when set', () => {
    expect(getCodexAuthPath()).toBe(join(codexHome, 'auth.json'));
  });

  it('falls back to ~/.codex when CODEX_HOME is empty', () => {
    process.env['CODEX_HOME'] = '';
    const p = getCodexAuthPath();
    expect(p.endsWith(join('.codex', 'auth.json'))).toBe(true);
  });

  it('falls back to ~/.codex when CODEX_HOME is whitespace', () => {
    process.env['CODEX_HOME'] = '   ';
    const p = getCodexAuthPath();
    expect(p.endsWith(join('.codex', 'auth.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Seeder contract
// ---------------------------------------------------------------------------

describe('CodexCliSeeder', () => {
  it('declares sourceId=codex-cli and provider=openai', () => {
    const seeder = new CodexCliSeeder();
    expect(seeder.sourceId).toBe('codex-cli');
    expect(seeder.provider).toBe('openai');
  });

  it('exports a module-level singleton', () => {
    expect(codexCliSeeder).toBeInstanceOf(CodexCliSeeder);
  });

  it('returns empty entries when auth.json does not exist', async () => {
    const result = await codexCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings).toBeUndefined();
  });

  it('extracts an OAuth access_token from tokens.access_token', async () => {
    writeAuthJson({
      tokens: {
        access_token: 'oauth-access-abc',
        refresh_token: 'oauth-refresh-xyz',
        id_token: 'ignored',
        account_id: 'ignored',
      },
    });

    const result = await codexCliSeeder.seed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      provider: 'openai',
      label: 'codex-cli',
      authType: 'oauth',
      accessToken: 'oauth-access-abc',
      source: 'codex-cli',
      refreshToken: 'oauth-refresh-xyz',
    });
  });

  it('extracts an API key from OPENAI_API_KEY', async () => {
    writeAuthJson({ OPENAI_API_KEY: 'sk-from-codex' });

    const result = await codexCliSeeder.seed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      provider: 'openai',
      label: 'codex-cli-api-key',
      authType: 'api_key',
      accessToken: 'sk-from-codex',
      source: 'codex-cli',
    });
  });

  it('emits both entries when OAuth tokens AND API key are present, OAuth first', async () => {
    writeAuthJson({
      OPENAI_API_KEY: 'sk-coexists',
      tokens: { access_token: 'oauth-first' },
    });

    const result = await codexCliSeeder.seed();
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].authType).toBe('oauth');
    expect(result.entries[1].authType).toBe('api_key');
  });

  it('skips an empty/whitespace access_token without emitting', async () => {
    writeAuthJson({ tokens: { access_token: '   ' } });
    const result = await codexCliSeeder.seed();
    expect(result.entries).toEqual([]);
  });

  it('omits refreshToken from the OAuth entry when not present in tokens', async () => {
    writeAuthJson({ tokens: { access_token: 'oauth-no-refresh' } });
    const result = await codexCliSeeder.seed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].refreshToken).toBeUndefined();
  });

  it('warns and returns empty when auth.json is invalid JSON', async () => {
    writeFileSync(join(codexHome, 'auth.json'), '{ not valid json', 'utf-8');
    const result = await codexCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/codex-cli:.*not valid JSON/);
  });

  it('warns and returns empty when auth.json is an array (not an object)', async () => {
    writeFileSync(join(codexHome, 'auth.json'), '[1,2,3]', 'utf-8');
    const result = await codexCliSeeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings?.[0]).toMatch(/not a JSON object/);
  });

  it('ignores extra unrelated keys in auth.json', async () => {
    writeAuthJson({
      OPENAI_API_KEY: 'sk-only-this',
      stray: 'ignored',
      tokens: { /* no access_token */ id_token: 'x' },
    });
    const result = await codexCliSeeder.seed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].label).toBe('codex-cli-api-key');
  });

  it('never throws on unexpected internal structure', async () => {
    writeAuthJson({ tokens: 'string-not-object' });
    await expect(codexCliSeeder.seed()).resolves.toMatchObject({ entries: [] });
  });
});
