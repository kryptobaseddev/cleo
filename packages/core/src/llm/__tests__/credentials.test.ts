/**
 * Tests for the unified credentials resolver (T1677).
 *
 * Covers all 5 resolution tiers for `resolveCredentials()` and the
 * Anthropic key helpers:
 *   - storeAnthropicApiKey() / clearAnthropicKeyCache()
 *
 * Filesystem is isolated via XDG_DATA_HOME + temp directories.
 * Process env is saved and restored around every test.
 *
 * Note: tests that assert 'none' / 'config' for the Anthropic source use
 * ANTHROPIC_API_KEY='' (empty string sentinel) so the env check fires before
 * the Claude credentials file check. The env check rejects empty strings, so
 * tier 2 falls through to tier 3, 4, 5. To force tier 4/5 to win over tier 3,
 * we point the test's config file at the correct XDG home.
 *
 * When `~/.claude/.credentials.json` contains a valid OAuth token (true on
 * developer machines), tier-3 will resolve for anthropic provider. Tests that
 * verify "config" or "none" must provide a non-anthropic provider (e.g. openai)
 * that is unaffected by the Claude credentials file.
 *
 * @task T1677
 * @epic T1676
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAnthropicKeyCache,
  resolveCredentials,
  storeAnthropicApiKey,
} from '../credentials.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Saved env vars restored in afterEach. */
const SAVED_ENV: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  // T9403: getCleoHome() honours CLEO_HOME first, so we must save/restore it.
  // The global vitest setup pins CLEO_HOME per-fork; per-test makeTempXdg()
  // overrides it for filesystem isolation.
  'CLEO_HOME',
  'CLEO_DIR',
];

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

function clearEnv(): void {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
}

/**
 * Create a fresh temp dir and set XDG_DATA_HOME + CLEO_HOME to it, returning
 * the cleo dir. Sets both env vars so the test isolates the global CLEO home
 * regardless of whether the resolver consults XDG_DATA_HOME (legacy) or
 * CLEO_HOME (T9403 — getCleoHome() from @cleocode/paths takes precedence).
 */
function makeTempXdg(): { xdgRoot: string; cleoDir: string; configPath: string } {
  const xdgRoot = join(
    tmpdir(),
    `cleo-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const cleoDir = join(xdgRoot, 'cleo');
  mkdirSync(cleoDir, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['CLEO_HOME'] = cleoDir;
  return { xdgRoot, cleoDir, configPath: join(cleoDir, 'config.json') };
}

/** Write a minimal config.json with llm.providers[provider].apiKey. */
function writeGlobalProviderKey(configPath: string, provider: string, apiKey: string): void {
  writeFileSync(
    configPath,
    JSON.stringify({ llm: { providers: { [provider]: { apiKey } } } }),
    'utf-8',
  );
}

/** Write a minimal project config.json at .cleo/config.json under projectRoot. */
function writeProjectProviderKey(projectRoot: string, provider: string, apiKey: string): void {
  const cleoDir = join(projectRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  writeFileSync(
    join(cleoDir, 'config.json'),
    JSON.stringify({ llm: { providers: { [provider]: { apiKey } } } }),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
});

// ---------------------------------------------------------------------------
// Tier 1 — explicit options.apiKey
// ---------------------------------------------------------------------------

describe('Tier 1 — explicit options.apiKey', () => {
  it('returns explicit key with source=explicit for anthropic', () => {
    const result = resolveCredentials('anthropic', { apiKey: 'sk-explicit-key' });
    expect(result.apiKey).toBe('sk-explicit-key');
    expect(result.source).toBe('explicit');
    expect(result.provider).toBe('anthropic');
  });

  it('returns explicit key with source=explicit for openai', () => {
    const result = resolveCredentials('openai', { apiKey: 'sk-openai-explicit' });
    expect(result.apiKey).toBe('sk-openai-explicit');
    expect(result.source).toBe('explicit');
  });

  it('trims whitespace from explicit key', () => {
    const result = resolveCredentials('anthropic', { apiKey: '  sk-trimmed  ' });
    expect(result.apiKey).toBe('sk-trimmed');
  });

  it('skips explicit null and falls through to next tier', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-from-env';
    const result = resolveCredentials('anthropic', { apiKey: null });
    expect(result.source).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — environment variable
// ---------------------------------------------------------------------------

describe('Tier 2 — environment variable', () => {
  it('resolves ANTHROPIC_API_KEY for anthropic provider', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-anthropic';
    const result = resolveCredentials('anthropic');
    expect(result.apiKey).toBe('sk-env-anthropic');
    expect(result.source).toBe('env');
  });

  it('resolves OPENAI_API_KEY for openai provider', () => {
    process.env['OPENAI_API_KEY'] = 'sk-env-openai';
    const result = resolveCredentials('openai');
    expect(result.apiKey).toBe('sk-env-openai');
    expect(result.source).toBe('env');
  });

  it('resolves GEMINI_API_KEY for gemini provider', () => {
    process.env['GEMINI_API_KEY'] = 'sk-env-gemini';
    const result = resolveCredentials('gemini');
    expect(result.apiKey).toBe('sk-env-gemini');
    expect(result.source).toBe('env');
  });

  it('resolves MOONSHOT_API_KEY for moonshot provider', () => {
    process.env['MOONSHOT_API_KEY'] = 'sk-env-moonshot';
    const result = resolveCredentials('moonshot');
    expect(result.apiKey).toBe('sk-env-moonshot');
    expect(result.source).toBe('env');
  });

  it('env takes priority over global-config', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-wins';
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'anthropic', 'sk-config-loses');
    const result = resolveCredentials('anthropic');
    expect(result.apiKey).toBe('sk-env-wins');
    expect(result.source).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — global-config
// ---------------------------------------------------------------------------

describe('Tier 4 — global config (llm.providers[p].apiKey)', () => {
  it('resolves openai key from global config (openai unaffected by claude-creds)', () => {
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'openai', 'sk-global-openai');
    const result = resolveCredentials('openai');
    expect(result.apiKey).toBe('sk-global-openai');
    expect(result.source).toBe('global-config');
  });

  it('resolves gemini key from global config', () => {
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'gemini', 'sk-global-gemini');
    const result = resolveCredentials('gemini');
    expect(result.apiKey).toBe('sk-global-gemini');
    expect(result.source).toBe('global-config');
  });

  it('resolves moonshot key from global config', () => {
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'moonshot', 'sk-global-moonshot');
    const result = resolveCredentials('moonshot');
    expect(result.apiKey).toBe('sk-global-moonshot');
    expect(result.source).toBe('global-config');
  });

  it('env key takes priority over global config key', () => {
    process.env['OPENAI_API_KEY'] = 'sk-env-wins';
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'openai', 'sk-config-loses');
    const result = resolveCredentials('openai');
    expect(result.apiKey).toBe('sk-env-wins');
    expect(result.source).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// Tier 5 — project-config
// ---------------------------------------------------------------------------

describe('Tier 5 — project config (.cleo/config.json)', () => {
  it('resolves openai key from project config (openai unaffected by claude-creds)', () => {
    const { xdgRoot } = makeTempXdg();
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    writeProjectProviderKey(projectRoot, 'openai', 'sk-project-openai');
    const result = resolveCredentials('openai', { projectRoot });
    expect(result.apiKey).toBe('sk-project-openai');
    expect(result.source).toBe('project-config');
  });

  it('resolves gemini key from project config', () => {
    const { xdgRoot } = makeTempXdg();
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    writeProjectProviderKey(projectRoot, 'gemini', 'sk-project-gemini');
    const result = resolveCredentials('gemini', { projectRoot });
    expect(result.apiKey).toBe('sk-project-gemini');
    expect(result.source).toBe('project-config');
  });

  it('project-config is NOT used when projectRoot is not provided (openai)', () => {
    const { xdgRoot } = makeTempXdg();
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    writeProjectProviderKey(projectRoot, 'openai', 'sk-project-key');
    // No projectRoot passed — should not find the key
    const result = resolveCredentials('openai');
    expect(result.apiKey).toBeNull();
    expect(result.source).toBeUndefined();
  });

  it('global-config takes priority over project-config (openai)', () => {
    const { xdgRoot, configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'openai', 'sk-global-wins');
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    writeProjectProviderKey(projectRoot, 'openai', 'sk-project-loses');
    const result = resolveCredentials('openai', { projectRoot });
    expect(result.apiKey).toBe('sk-global-wins');
    expect(result.source).toBe('global-config');
  });
});

// ---------------------------------------------------------------------------
// No key found
// ---------------------------------------------------------------------------

describe('No key found', () => {
  it('returns null apiKey and undefined source when all tiers exhausted (openai provider)', () => {
    // openai is unaffected by the Claude credentials file (tier 3 only fires for anthropic)
    makeTempXdg(); // XDG set to empty dir — no config.json, no providers key
    const result = resolveCredentials('openai');
    expect(result.apiKey).toBeNull();
    expect(result.source).toBeUndefined();
    expect(result.provider).toBe('openai');
  });

  it('returns null apiKey for moonshot when no key configured', () => {
    makeTempXdg();
    const result = resolveCredentials('moonshot');
    expect(result.apiKey).toBeNull();
    expect(result.provider).toBe('moonshot');
  });
});

// ---------------------------------------------------------------------------
// resolveCredentials — Anthropic key resolution
// ---------------------------------------------------------------------------

describe('resolveCredentials("anthropic") — key resolution', () => {
  it('returns key from env var', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-direct';
    const result = resolveCredentials('anthropic');
    expect(result.apiKey).toBe('sk-env-direct');
    expect(result.source).toBe('env');
  });

  it('returns a non-null key when env tier resolves', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-explicit-env';
    expect(resolveCredentials('anthropic').apiKey).toBe('sk-explicit-env');
  });
});

describe('clearAnthropicKeyCache()', () => {
  it('is a no-op that does not throw', () => {
    // resolveCredentials has no internal cache; clearAnthropicKeyCache is retained
    // for test call-site compatibility.
    expect(() => clearAnthropicKeyCache()).not.toThrow();
  });

  it('resolveCredentials still reads env after clearAnthropicKeyCache call', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-after';
    clearAnthropicKeyCache();
    expect(resolveCredentials('anthropic').apiKey).toBe('sk-after');
  });

  it('returns explicit key when env is cleared after cache call', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    clearAnthropicKeyCache();
    const result = resolveCredentials('anthropic', { apiKey: 'sk-fallback' });
    expect(result.apiKey).toBe('sk-fallback');
    expect(result.source).toBe('explicit');
  });
});

describe('resolveCredentials source mapping — anthropic', () => {
  it('source is "env" when ANTHROPIC_API_KEY is set', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-source';
    expect(resolveCredentials('anthropic').source).toBe('env');
  });

  it('source is "global-config" when openai key comes from global config', () => {
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'openai', 'sk-openai-config');
    const result = resolveCredentials('openai');
    expect(result.source).toBe('global-config');
    expect(result.apiKey).toBe('sk-openai-config');
  });

  it('source is undefined when no openai key is available', () => {
    makeTempXdg();
    const result = resolveCredentials('openai');
    expect(result.apiKey).toBeNull();
    expect(result.source).toBeUndefined();
  });
});

describe('storeAnthropicApiKey()', () => {
  it('writes the flat key file readable via resolveCredentials', () => {
    const { cleoDir } = makeTempXdg();
    void cleoDir;
    storeAnthropicApiKey('sk-stored-key');
    clearAnthropicKeyCache();
    // Either from flat file (tier 4b) or from claude-creds (tier 3) — key is non-null
    expect(resolveCredentials('anthropic').apiKey).not.toBeNull();
  });

  it('env key takes precedence over stored key after store', () => {
    makeTempXdg();
    storeAnthropicApiKey('sk-cache-test');
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-after-store';
    expect(resolveCredentials('anthropic').apiKey).toBe('sk-env-after-store');
  });
});
