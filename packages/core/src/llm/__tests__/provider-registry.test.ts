/**
 * Tests for the CLEO provider registry (T9262).
 *
 * Covers:
 *   1. Builtin profile lookup (`anthropic`).
 *   2. Case-insensitive lookup (`ANTHROPIC`).
 *   3. Alias resolution (`claude` → anthropic profile).
 *   4. `listProviders()` returns a sorted array.
 *   5. User plugin override — plugin file overrides the builtin profile.
 *   6. `discoverPlugins()` is a no-op when the plugin dir does not exist.
 *
 * Each test resets the registry state and isolates the CLEO_HOME env var so
 * tests are independent of the host machine's plugin directory.
 *
 * @task T9262
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetRegistryForTesting,
  discoverPlugins,
  getProviderProfile,
  listProviders,
  registerProvider,
} from '../provider-registry/index.js';

// ---------------------------------------------------------------------------
// Env isolation helpers
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['CLEO_HOME'];

function saveEnv(): void {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = SAVED_ENV[k];
    }
  }
}

/**
 * Create a temporary directory tree for CLEO_HOME and return the paths.
 * Sets `process.env.CLEO_HOME` to the temp root.
 */
function makeTempCleoHome(): {
  cleoHome: string;
  pluginDir: string;
} {
  const cleoHome = join(
    tmpdir(),
    `cleo-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const pluginDir = join(cleoHome, 'plugins', 'model-providers');
  mkdirSync(pluginDir, { recursive: true });
  process.env['CLEO_HOME'] = cleoHome;
  return { cleoHome, pluginDir };
}

/**
 * Remove a directory tree, tolerating non-existent paths.
 */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('provider-registry', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    saveEnv();
    _resetRegistryForTesting();
    tempDirs = [];
  });

  afterEach(() => {
    restoreEnv();
    _resetRegistryForTesting();
    for (const dir of tempDirs) {
      cleanupDir(dir);
    }
  });

  // ── 1. Builtin anthropic profile ─────────────────────────────────────────

  it('returns the builtin anthropic profile', async () => {
    // Point CLEO_HOME at a non-existent dir so no user plugins load.
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    const profile = await getProviderProfile('anthropic');

    expect(profile).toBeDefined();
    expect(profile?.name).toBe('anthropic');
    expect(profile?.displayName).toBe('Anthropic Claude');
    expect(profile?.baseUrl).toBe('https://api.anthropic.com');
    expect(profile?.defaultModel).toBe('claude-haiku-4-5-20251001');
    expect(profile?.authTypes).toContain('api_key');
    expect(profile?.authTypes).toContain('oauth');
    expect(profile?.defaultHeaders?.['anthropic-version']).toBe('2023-06-01');
  });

  // ── 2. Case-insensitive lookup ────────────────────────────────────────────

  it('resolves provider name case-insensitively', async () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    const profile = await getProviderProfile('ANTHROPIC');
    expect(profile).toBeDefined();
    expect(profile?.name).toBe('anthropic');
  });

  // ── 3. Alias resolution ───────────────────────────────────────────────────

  it('resolves alias "claude" to the anthropic profile', async () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    const profile = await getProviderProfile('claude');
    expect(profile).toBeDefined();
    expect(profile?.name).toBe('anthropic');
  });

  it('resolves alias "anthropic-api" to the anthropic profile', async () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    const profile = await getProviderProfile('anthropic-api');
    expect(profile).toBeDefined();
    expect(profile?.name).toBe('anthropic');
  });

  // ── 4. listProviders returns sorted array ─────────────────────────────────

  it('listProviders returns all registered profiles sorted by name', async () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    // Register an extra profile manually to exercise sorting.
    await discoverPlugins(); // load builtins first
    registerProvider({
      name: 'openai',
      displayName: 'OpenAI',
      authTypes: ['api_key'],
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    });

    const providers = await listProviders();

    expect(providers.length).toBeGreaterThanOrEqual(2);

    // Verify sorted order.
    const names = providers.map((p) => p.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);

    // Both profiles must be present.
    expect(names).toContain('anthropic');
    expect(names).toContain('openai');
  });

  // ── 5. User plugin override ───────────────────────────────────────────────

  it('user plugin overrides the builtin anthropic profile', async () => {
    const { cleoHome, pluginDir } = makeTempCleoHome();
    tempDirs.push(cleoHome);

    // Write a user plugin that registers a custom anthropic profile.
    const pluginContent = `
export function register(api) {
  api.registerProvider({
    name: 'anthropic',
    displayName: 'Anthropic Claude (user override)',
    authTypes: ['api_key'],
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-4-5-20251001',
  });
}
`;
    writeFileSync(join(pluginDir, 'override-anthropic.mjs'), pluginContent, 'utf-8');

    await discoverPlugins();

    const profile = await getProviderProfile('anthropic');
    expect(profile).toBeDefined();
    expect(profile?.displayName).toBe('Anthropic Claude (user override)');
    expect(profile?.defaultModel).toBe('claude-opus-4-5-20251001');
  });

  // ── 6. discoverPlugins no-ops when plugin dir does not exist ─────────────

  it('discoverPlugins is a no-op when plugin dir does not exist', async () => {
    const nonExistentHome = join(tmpdir(), 'cleo-no-plugins-' + Date.now());
    process.env['CLEO_HOME'] = nonExistentHome;

    // Should not throw, even though the directory does not exist.
    await expect(discoverPlugins()).resolves.toBeUndefined();

    // Builtins should still be registered.
    const profile = await getProviderProfile('anthropic');
    expect(profile).toBeDefined();
    expect(profile?.name).toBe('anthropic');
  });

  // ── 7. undefined for unknown provider ────────────────────────────────────

  it('returns undefined for an unregistered provider name', async () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    const profile = await getProviderProfile('nonexistent-provider');
    expect(profile).toBeUndefined();
  });

  // ── 8. xaiResponsesProfile aliases (T9311) ───────────────────────────────

  it('resolves alias "grok-responses" to xaiResponsesProfile', async () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    const profile = await getProviderProfile('grok-responses');
    expect(profile).toBeDefined();
    expect(profile?.name).toBe('xai');
    expect(profile?.displayName).toBe('xAI Grok (Responses)');
    expect(profile?.baseUrl).toBe('https://api.x.ai/v1');
  });

  it('resolves alias "x-ai-responses" to xaiResponsesProfile', async () => {
    process.env['CLEO_HOME'] = join(tmpdir(), 'no-such-cleo-home-' + Date.now());

    const profile = await getProviderProfile('x-ai-responses');
    expect(profile).toBeDefined();
    expect(profile?.name).toBe('xai');
    expect(profile?.displayName).toBe('xAI Grok (Responses)');
  });

  // ── 10. Plugin import error is tolerated ─────────────────────────────────

  it('tolerates a plugin file that throws on import', async () => {
    const { cleoHome, pluginDir } = makeTempCleoHome();
    tempDirs.push(cleoHome);

    // Write a broken plugin.
    writeFileSync(
      join(pluginDir, 'broken.mjs'),
      'throw new Error("intentional test failure");',
      'utf-8',
    );

    // Discovery should not throw — broken plugin is skipped.
    await expect(discoverPlugins()).resolves.toBeUndefined();

    // Builtins are still accessible.
    const profile = await getProviderProfile('anthropic');
    expect(profile).toBeDefined();
  });
});
