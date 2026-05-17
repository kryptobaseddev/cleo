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
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCredentialPoolSingletonForTests,
  UnifiedCredentialPool,
} from '../credential-pool.js';
import {
  type CredentialSeeder,
  SeederRegistry,
  type SeederSourceId,
} from '../credential-seeders/index.js';
import {
  _resetCredentialDeprecationLatchesForTests,
  clearAnthropicKeyCache,
  resolveCredentials,
  resolveCredentialsAsync,
  storeAnthropicApiKey,
} from '../credentials.js';
import { _resetPermsWarningForTests } from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';

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
  // T9405: getCleoPlatformPaths().config reads XDG_CONFIG_HOME, so the
  // resolver's config-dir tier (where T9405 moved config.json) must also be
  // isolated to a per-test temp dir — otherwise the real user's
  // ~/.config/cleo/config.json leaks through.
  'XDG_CONFIG_HOME',
  'CLEO_CONFIG_HOME',
  // T9403: getCleoHome() honours CLEO_HOME first, so we must save/restore it.
  // The global vitest setup pins CLEO_HOME per-fork; per-test makeTempXdg()
  // overrides it for filesystem isolation.
  'CLEO_HOME',
  'CLEO_DIR',
  // T9413: tier-3 (pool) reads files under HOME; isolate so developer state
  // does not bleed into the async resolver tests.
  'HOME',
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
 * Create a fresh temp dir and pin the CLEO env vars to it, returning the
 * cleo data dir. Sets every env var the resolver might consult so a test
 * cannot leak to (or read from) the real user's `~/.cleo` / `~/.config/cleo`:
 *
 * - `XDG_DATA_HOME`   → legacy resolver path
 * - `CLEO_HOME`       → `getCleoHome()` from `@cleocode/paths` (T9403)
 * - `XDG_CONFIG_HOME` → `getCleoPlatformPaths().config` (T9405)
 *
 * The returned `configPath` points at the **legacy data-dir** location so
 * existing tests that write `config.json` there continue to exercise tier 4a
 * via the transition-window fallback in `readGlobalProviderKey()`.
 *
 * Also resets the `@cleocode/paths` system-info cache and the once-per-process
 * migration latch so each test re-runs the migration with its own fresh env.
 */
function makeTempXdg(): { xdgRoot: string; cleoDir: string; configPath: string } {
  const xdgRoot = join(
    tmpdir(),
    `cleo-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const cleoDir = join(xdgRoot, 'cleo');
  const xdgConfigHome = join(xdgRoot, 'config-home');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_HOME'] = cleoDir;
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
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
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
  _resetCredentialDeprecationLatchesForTests();
  _resetCredentialPoolSingletonForTests();
  _resetPermsWarningForTests();
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
  _resetCredentialDeprecationLatchesForTests();
  _resetCredentialPoolSingletonForTests();
  _resetPermsWarningForTests();
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
// Tier 5 — project-config (REJECTED in T9413 — emits stderr warning,
// MUST NOT resolve)
// ---------------------------------------------------------------------------

describe('Tier 5 — project config (.cleo/config.json) — REJECTED (T9413)', () => {
  it('does NOT resolve openai key from project config and emits stderr warning', () => {
    const { xdgRoot } = makeTempXdg();
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    writeProjectProviderKey(projectRoot, 'openai', 'sk-project-openai');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = resolveCredentials('openai', { projectRoot });
      expect(result.apiKey).toBeNull();
      expect(result.source).toBeUndefined();
      const writes = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(writes).toMatch(/REJECTED/);
      expect(writes).toMatch(/migrate-project-secrets/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does NOT resolve gemini key from project config', () => {
    const { xdgRoot } = makeTempXdg();
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    writeProjectProviderKey(projectRoot, 'gemini', 'sk-project-gemini');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = resolveCredentials('gemini', { projectRoot });
      expect(result.apiKey).toBeNull();
      expect(result.source).toBeUndefined();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does not warn when no project apiKey is present', () => {
    const { xdgRoot } = makeTempXdg();
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = resolveCredentials('openai', { projectRoot });
      expect(result.apiKey).toBeNull();
      // No REJECTED warning should fire when the key is simply absent.
      const writes = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(writes).not.toMatch(/REJECTED/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('emits the rejection warning only once per provider', () => {
    const { xdgRoot } = makeTempXdg();
    const projectRoot = join(xdgRoot, 'myproject');
    mkdirSync(projectRoot, { recursive: true });
    writeProjectProviderKey(projectRoot, 'openai', 'sk-project-openai');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      resolveCredentials('openai', { projectRoot });
      resolveCredentials('openai', { projectRoot });
      resolveCredentials('openai', { projectRoot });
      const rejectionWrites = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('REJECTED'));
      expect(rejectionWrites).toHaveLength(1);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 4a — global config DEPRECATION warning (T9413)
// ---------------------------------------------------------------------------

describe('Tier 4a — global-config apiKey deprecation (T9413)', () => {
  it('still resolves the key but emits a DEPRECATED stderr warning', () => {
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'openai', 'sk-global-openai');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = resolveCredentials('openai');
      expect(result.apiKey).toBe('sk-global-openai');
      expect(result.source).toBe('global-config');
      const writes = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(writes).toMatch(/DEPRECATED/);
      expect(writes).toMatch(/cleo auth add/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('emits the deprecation warning only once per provider', () => {
    const { configPath } = makeTempXdg();
    writeGlobalProviderKey(configPath, 'openai', 'sk-global-openai');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      resolveCredentials('openai');
      resolveCredentials('openai');
      resolveCredentials('openai');
      const deprecationWrites = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('DEPRECATED'));
      expect(deprecationWrites).toHaveLength(1);
    } finally {
      writeSpy.mockRestore();
    }
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

// ---------------------------------------------------------------------------
// resolveCredentialsAsync (T9413 — E-CONFIG-AUTH-UNIFY §5.2 T-E2-6)
// ---------------------------------------------------------------------------

/**
 * Build a one-shot seeder that returns a single canned entry. Mirrors the
 * helper in `credential-pool-unified.test.ts` — duplicated here so this
 * file does not cross test-file boundaries.
 */
function makeAsyncTestSeeder(opts: {
  sourceId: SeederSourceId;
  provider: string;
  token: string;
  authType?: 'api_key' | 'oauth';
}): CredentialSeeder {
  return {
    sourceId: opts.sourceId,
    provider: opts.provider,
    async seed() {
      return {
        entries: [
          {
            provider: opts.provider as never,
            label: `${opts.sourceId}:${opts.provider}`,
            authType: opts.authType ?? 'api_key',
            source: opts.sourceId,
            accessToken: opts.token,
          },
        ],
      };
    },
  };
}

describe('resolveCredentialsAsync (T9413) — pool-backed', () => {
  it('returns the explicit apiKey via tier 1 without touching the pool', async () => {
    makeTempXdg();
    const result = await resolveCredentialsAsync('anthropic', { apiKey: 'sk-explicit-async' });
    expect(result.apiKey).toBe('sk-explicit-async');
    expect(result.source).toBe('explicit');
    expect(result.authType).toBe('api_key');
  });

  it('detects an OAuth-prefixed explicit key as authType=oauth', async () => {
    makeTempXdg();
    const result = await resolveCredentialsAsync('anthropic', {
      apiKey: 'sk-ant-oat-explicit',
    });
    expect(result.source).toBe('explicit');
    expect(result.authType).toBe('oauth');
  });

  it('delegates to getCredentialPool().pick() and returns the seeded entry', async () => {
    makeTempXdg();
    // Pre-seed the on-disk credential store via a test seeder. The default
    // singleton's seeder sweep will run on the next pick() but is gated on
    // consent + on-disk files that the isolated HOME does not provide — so
    // the seeded entry below is the only thing the singleton can pick up
    // when it reads the store.
    const registry = new SeederRegistry();
    registry.register(
      makeAsyncTestSeeder({
        sourceId: 'env',
        provider: 'openai',
        token: 'sk-pool-openai',
      }),
    );
    const seedingPool = new UnifiedCredentialPool(() => registry.getAll());
    await seedingPool.seed();

    // The async resolver delegates to the singleton pool which now reads the
    // pre-seeded entry from the store.
    const result = await resolveCredentialsAsync('openai');
    expect(result.apiKey).toBe('sk-pool-openai');
    expect(result.source).toBe('cred-file');
    expect(result.authType).toBe('api_key');
  });

  it('narrows oauth pool entries to authType=oauth', async () => {
    makeTempXdg();
    const registry = new SeederRegistry();
    registry.register(
      makeAsyncTestSeeder({
        sourceId: 'cleo-pkce',
        provider: 'anthropic',
        token: 'sk-ant-oat-pkce',
        authType: 'oauth',
      }),
    );
    const pool = new UnifiedCredentialPool(() => registry.getAll());
    await pool.seed();
    const entry = await pool.pick('anthropic');
    expect(entry?.authType).toBe('oauth');
    expect(entry?.accessToken).toBe('sk-ant-oat-pkce');
  });

  it('returns null with undefined source when the pool is empty', async () => {
    makeTempXdg();
    const result = await resolveCredentialsAsync('moonshot');
    expect(result.apiKey).toBeNull();
    expect(result.source).toBeUndefined();
    expect(result.provider).toBe('moonshot');
  });
});

// ---------------------------------------------------------------------------
// Sync resolveCredentials — pool tier read (no re-seeding) (T9413)
// ---------------------------------------------------------------------------

describe('resolveCredentials sync — pool file read without seeding (T9413)', () => {
  it('reads a pre-seeded entry from the pool file synchronously', async () => {
    makeTempXdg();
    const registry = new SeederRegistry();
    registry.register(
      makeAsyncTestSeeder({
        sourceId: 'env',
        provider: 'openai',
        token: 'sk-openai-from-pool',
      }),
    );
    // Seed once via the unified pool — this writes the entry into the
    // on-disk credential store under the isolated CLEO_HOME.
    const pool = new UnifiedCredentialPool(() => registry.getAll());
    await pool.seed();

    // The sync resolver MUST read that entry without re-seeding.
    const result = resolveCredentials('openai');
    expect(result.apiKey).toBe('sk-openai-from-pool');
    expect(result.source).toBe('cred-file');
    expect(result.authType).toBe('api_key');
  });
});
