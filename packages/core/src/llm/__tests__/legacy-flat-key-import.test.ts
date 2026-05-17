/**
 * Tests for the legacy `anthropic-key` flat-file → credential-pool import
 * migration (T9406 — `E-CONFIG-AUTH-UNIFY` E1, T-E1-4).
 *
 * Filesystem isolation mirrors `credentials-store.test.ts`: per-test
 * tmpdirs backing `XDG_DATA_HOME` + `CLEO_HOME` + `HOME`, env saved /
 * restored in `afterEach`. Each test starts with a fresh CleoHome with
 * no flat file, no marker, no pool.
 *
 * @task T9406
 * @epic E-CONFIG-AUTH-UNIFY
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addCredential, getCredentialByLabel, listCredentials } from '../credentials-store.js';
import { clearAnthropicKeyCache } from '../credentials.js';
import {
  importLegacyFlatAnthropicKey,
  LEGACY_FLAT_KEY_BAK_SUFFIX,
  LEGACY_FLAT_KEY_LABEL,
  LEGACY_FLAT_KEY_MARKER,
} from '../legacy-flat-key-import.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
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
 * Per-test sandbox: every CLEO global path is rooted under tmpdirs that
 * are unique to this test. Returns the resolved CleoHome so we can
 * derive expected paths.
 */
function isolateHomes(): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-legacyflat-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-legacyflat-home-${stamp}`);
  const cleoHome = join(xdgRoot, 'cleo');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['CLEO_HOME'] = cleoHome;
  process.env['HOME'] = home;
  return cleoHome;
}

function seedFlatFile(cleoHome: string, contents: string): string {
  const path = join(cleoHome, 'anthropic-key');
  writeFileSync(path, contents, 'utf-8');
  return path;
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
});

describe('importLegacyFlatAnthropicKey()', () => {
  it('imports the flat key, renames the file, writes the marker, adds the pool entry', async () => {
    const home = isolateHomes();
    const flatPath = seedFlatFile(home, 'sk-ant-api03-flat-key-value\n');

    const result = await importLegacyFlatAnthropicKey();

    expect(result.status).toBe('imported');
    expect(result.flatPath).toBe(flatPath);
    expect(result.bakPath).toBe(join(home, `anthropic-key${LEGACY_FLAT_KEY_BAK_SUFFIX}`));
    expect(result.markerPath).toBe(join(home, LEGACY_FLAT_KEY_MARKER));

    // Pool entry must exist with the canonical shape.
    const entry = await getCredentialByLabel('anthropic', LEGACY_FLAT_KEY_LABEL);
    expect(entry).not.toBeNull();
    expect(entry?.provider).toBe('anthropic');
    expect(entry?.label).toBe(LEGACY_FLAT_KEY_LABEL);
    expect(entry?.authType).toBe('api_key');
    expect(entry?.accessToken).toBe('sk-ant-api03-flat-key-value');
    expect(entry?.source).toBe('manual');
    expect(entry?.priority).toBe(100);

    // Original flat file is renamed (preserved, not deleted).
    expect(existsSync(flatPath)).toBe(false);
    expect(existsSync(result.bakPath ?? '')).toBe(true);
    expect(readFileSync(result.bakPath ?? '', 'utf-8').trim()).toBe('sk-ant-api03-flat-key-value');

    // Marker is written.
    expect(existsSync(result.markerPath)).toBe(true);
  });

  it('is idempotent when the pool already has a legacy-flat-key entry (no flat file)', async () => {
    isolateHomes();
    // Pre-seed pool with a `legacy-flat-key` entry, simulating an earlier
    // run that imported the key but lost its marker.
    await addCredential({
      provider: 'anthropic',
      label: LEGACY_FLAT_KEY_LABEL,
      authType: 'api_key',
      accessToken: 'sk-ant-api03-pre-existing',
      source: 'manual',
      priority: 100,
    });

    const result = await importLegacyFlatAnthropicKey();

    expect(result.status).toBe('already-imported');
    expect(result.bakPath).toBeNull();
    expect(existsSync(result.markerPath)).toBe(true);
    // Pool entry untouched.
    const all = await listCredentials('anthropic');
    expect(all).toHaveLength(1);
    expect(all[0]?.accessToken).toBe('sk-ant-api03-pre-existing');
  });

  it('short-circuits when the migration marker is present', async () => {
    const home = isolateHomes();
    // Seed a flat file AND a marker — marker wins, flat file is ignored.
    const flatPath = seedFlatFile(home, 'sk-ant-api03-should-be-ignored\n');
    writeFileSync(join(home, LEGACY_FLAT_KEY_MARKER), 'previous-run\n', 'utf-8');

    const result = await importLegacyFlatAnthropicKey();

    expect(result.status).toBe('marker-present');
    expect(result.bakPath).toBeNull();
    // Flat file is untouched (not renamed) because we short-circuited.
    expect(existsSync(flatPath)).toBe(true);
    // No pool entry was created.
    const entry = await getCredentialByLabel('anthropic', LEGACY_FLAT_KEY_LABEL);
    expect(entry).toBeNull();
  });

  it('writes the marker but creates no entry when the flat file is missing', async () => {
    const home = isolateHomes();
    expect(existsSync(join(home, 'anthropic-key'))).toBe(false);

    const result = await importLegacyFlatAnthropicKey();

    expect(result.status).toBe('no-flat-file');
    expect(result.bakPath).toBeNull();
    expect(existsSync(result.markerPath)).toBe(true);
    const entry = await getCredentialByLabel('anthropic', LEGACY_FLAT_KEY_LABEL);
    expect(entry).toBeNull();
  });

  it('skips silently on an empty flat file — no entry, no rename, marker written', async () => {
    const home = isolateHomes();
    const flatPath = seedFlatFile(home, '   \n  \t');

    const result = await importLegacyFlatAnthropicKey();

    expect(result.status).toBe('empty-flat-file');
    expect(result.bakPath).toBeNull();
    // Empty file is preserved (not renamed) for operator inspection.
    expect(existsSync(flatPath)).toBe(true);
    expect(existsSync(join(home, `anthropic-key${LEGACY_FLAT_KEY_BAK_SUFFIX}`))).toBe(false);
    // No pool entry.
    const entry = await getCredentialByLabel('anthropic', LEGACY_FLAT_KEY_LABEL);
    expect(entry).toBeNull();
    // Marker prevents re-statting on every CLI invocation.
    expect(existsSync(result.markerPath)).toBe(true);
  });

  it('trims surrounding whitespace from the flat key before storing', async () => {
    const home = isolateHomes();
    seedFlatFile(home, '\n   sk-ant-api03-whitespacey   \n\n');

    const result = await importLegacyFlatAnthropicKey();

    expect(result.status).toBe('imported');
    const entry = await getCredentialByLabel('anthropic', LEGACY_FLAT_KEY_LABEL);
    expect(entry?.accessToken).toBe('sk-ant-api03-whitespacey');
  });

  it('a second call after a successful import is a marker-present no-op', async () => {
    const home = isolateHomes();
    seedFlatFile(home, 'sk-ant-api03-flat-key-value\n');

    const first = await importLegacyFlatAnthropicKey();
    expect(first.status).toBe('imported');

    const second = await importLegacyFlatAnthropicKey();
    expect(second.status).toBe('marker-present');
    expect(second.bakPath).toBeNull();
    // .bak file is still there from the first run; nothing renamed twice.
    expect(existsSync(join(home, `anthropic-key${LEGACY_FLAT_KEY_BAK_SUFFIX}`))).toBe(true);
    // Pool still has exactly one entry.
    const all = await listCredentials('anthropic');
    expect(all).toHaveLength(1);
  });
});
