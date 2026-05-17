/**
 * Tests for the XDG drift migration (T9405).
 *
 * Covers:
 * - Migration runs when a data-dir `config.json` exists with no marker
 * - Migration is idempotent (marker prevents re-run; second call is a no-op)
 * - Resolver prefers the config-dir copy when both exist
 * - Backup file is created with the canonical `.pre-e1-bak` name
 * - Atomic temp-then-rename leaves no partial state on success
 * - Invalid JSON in the data-dir copy aborts migration without touching the
 *   config dir
 *
 * Filesystem isolation: each test stages a fresh temp dir tree and points the
 * `CLEO_HOME` + `XDG_CONFIG_HOME` env vars at it. `_resetCleoPlatformPathsCache`
 * + `_resetGlobalConfigMigrationLatch` re-arm the path resolver and the
 * once-per-process migration latch.
 *
 * @task T9405
 * @epic T9398
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache, getCleoPlatformPaths } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCredentials } from '../credentials.js';
import {
  _resetGlobalConfigMigrationLatch,
  configDirGlobalConfigPath,
  legacyGlobalConfigPath,
  migrateGlobalConfigToConfigDir,
} from '../global-config-migration.js';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'CLEO_HOME',
  'CLEO_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
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
 * Stage a fresh temp dir layout and point CLEO at it.
 *
 * Layout:
 *   <root>/data/    ← CLEO_HOME (data dir)
 *   <root>/config/  ← XDG_CONFIG_HOME (parent of the cleo config dir)
 */
function stageTempHome(): { root: string; dataDir: string; configRoot: string; configDir: string } {
  const root = join(tmpdir(), `cleo-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dataDir = join(root, 'data');
  const configRoot = join(root, 'config');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  process.env['CLEO_HOME'] = dataDir;
  process.env['XDG_CONFIG_HOME'] = configRoot;
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
  const configDir = getCleoPlatformPaths().config;
  return { root, dataDir, configRoot, configDir };
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  _resetGlobalConfigMigrationLatch();
  // Silence the human-readable stderr lines the migration emits — they're
  // intentional in production but pollute the test output.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
});

// ---------------------------------------------------------------------------
// migrateGlobalConfigToConfigDir()
// ---------------------------------------------------------------------------

describe('migrateGlobalConfigToConfigDir()', () => {
  it('copies data-dir config.json to config dir when no marker exists', () => {
    const { dataDir } = stageTempHome();
    const source = legacyGlobalConfigPath();
    const target = configDirGlobalConfigPath();
    const body = JSON.stringify({ llm: { providers: { openai: { apiKey: 'sk-migrated' } } } });
    writeFileSync(source, body, 'utf-8');

    const ran = migrateGlobalConfigToConfigDir();

    expect(ran).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe(body);
    // Marker stamped under data dir.
    expect(existsSync(join(dataDir, '.migrations', 'config-dir-v1.done'))).toBe(true);
  });

  it('renames the data-dir original to config.json.pre-e1-bak after a successful copy', () => {
    stageTempHome();
    const source = legacyGlobalConfigPath();
    writeFileSync(source, '{"llm":{"providers":{}}}', 'utf-8');

    migrateGlobalConfigToConfigDir();

    expect(existsSync(source)).toBe(false);
    expect(existsSync(`${source}.pre-e1-bak`)).toBe(true);
    expect(readFileSync(`${source}.pre-e1-bak`, 'utf-8')).toBe('{"llm":{"providers":{}}}');
  });

  it('is idempotent — second invocation is a no-op once the marker exists', () => {
    stageTempHome();
    const source = legacyGlobalConfigPath();
    const target = configDirGlobalConfigPath();
    writeFileSync(source, '{"llm":{"providers":{"openai":{"apiKey":"sk-one"}}}}', 'utf-8');

    const firstRan = migrateGlobalConfigToConfigDir();
    expect(firstRan).toBe(true);

    // Drop a fresh file at the legacy location; the marker should prevent
    // re-migration so the new file is left alone.
    writeFileSync(source, '{"llm":{"providers":{"openai":{"apiKey":"sk-fresh"}}}}', 'utf-8');
    const secondRan = migrateGlobalConfigToConfigDir();

    expect(secondRan).toBe(false);
    // Config dir copy is the original migrated payload — unchanged.
    expect(readFileSync(target, 'utf-8')).toBe(
      '{"llm":{"providers":{"openai":{"apiKey":"sk-one"}}}}',
    );
    // Legacy file is left as-is (no marker re-write, no rename).
    expect(readFileSync(source, 'utf-8')).toBe(
      '{"llm":{"providers":{"openai":{"apiKey":"sk-fresh"}}}}',
    );
  });

  it('stamps the marker and skips when the data-dir source is absent (fresh install)', () => {
    const { dataDir } = stageTempHome();

    const ran = migrateGlobalConfigToConfigDir();

    expect(ran).toBe(false);
    expect(existsSync(join(dataDir, '.migrations', 'config-dir-v1.done'))).toBe(true);
    expect(existsSync(configDirGlobalConfigPath())).toBe(false);
  });

  it('does not overwrite an existing config-dir copy; backs up the data-dir source instead', () => {
    const { configDir } = stageTempHome();
    const source = legacyGlobalConfigPath();
    const target = configDirGlobalConfigPath();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(target, '{"existing":"target"}', 'utf-8');
    writeFileSync(source, '{"existing":"source"}', 'utf-8');

    const ran = migrateGlobalConfigToConfigDir();

    expect(ran).toBe(false);
    // Target preserved verbatim.
    expect(readFileSync(target, 'utf-8')).toBe('{"existing":"target"}');
    // Source moved to backup so the legacy fallback can't shadow the config-dir copy.
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(`${source}.pre-e1-bak`, 'utf-8')).toBe('{"existing":"source"}');
  });

  it('aborts cleanly when the data-dir source contains invalid JSON', () => {
    const { dataDir } = stageTempHome();
    const source = legacyGlobalConfigPath();
    const target = configDirGlobalConfigPath();
    writeFileSync(source, 'not-json', 'utf-8');

    const ran = migrateGlobalConfigToConfigDir();

    expect(ran).toBe(false);
    expect(existsSync(target)).toBe(false);
    // Source untouched — no rename to backup.
    expect(readFileSync(source, 'utf-8')).toBe('not-json');
    // No marker either — admin can re-run after fixing the file.
    expect(existsSync(join(dataDir, '.migrations', 'config-dir-v1.done'))).toBe(false);
  });

  it('leaves no partial temp file on the happy path', () => {
    const { configDir } = stageTempHome();
    const source = legacyGlobalConfigPath();
    writeFileSync(source, '{"llm":{"providers":{}}}', 'utf-8');

    migrateGlobalConfigToConfigDir();

    // The temp file used by the atomic temp-then-rename must not linger.
    expect(existsSync(join(configDir, 'config.json.tmp'))).toBe(false);
    expect(existsSync(configDirGlobalConfigPath())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveCredentials() integration — config-dir wins over legacy
// ---------------------------------------------------------------------------

describe('resolveCredentials() + migration', () => {
  it('finds the config-dir copy when both locations exist (config-dir wins)', () => {
    const { configDir, dataDir } = stageTempHome();
    // Pre-stamp the marker so the resolver short-circuits the migration and
    // exercises the BOTH-locations transition-window read path.
    mkdirSync(join(dataDir, '.migrations'), { recursive: true });
    writeFileSync(join(dataDir, '.migrations', 'config-dir-v1.done'), '\n', 'utf-8');

    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configDirGlobalConfigPath(),
      JSON.stringify({ llm: { providers: { openai: { apiKey: 'sk-config-dir-wins' } } } }),
      'utf-8',
    );
    writeFileSync(
      legacyGlobalConfigPath(),
      JSON.stringify({ llm: { providers: { openai: { apiKey: 'sk-data-dir-loses' } } } }),
      'utf-8',
    );

    const result = resolveCredentials('openai');

    expect(result.apiKey).toBe('sk-config-dir-wins');
    expect(result.source).toBe('global-config');
  });

  it('migrates a legacy-only install and then reads from the config dir on first resolve', () => {
    stageTempHome();
    writeFileSync(
      legacyGlobalConfigPath(),
      JSON.stringify({ llm: { providers: { openai: { apiKey: 'sk-from-migrated-file' } } } }),
      'utf-8',
    );

    const result = resolveCredentials('openai');

    expect(result.apiKey).toBe('sk-from-migrated-file');
    expect(result.source).toBe('global-config');
    // Migration must have moved the file over.
    expect(existsSync(configDirGlobalConfigPath())).toBe(true);
    expect(existsSync(legacyGlobalConfigPath())).toBe(false);
    expect(existsSync(`${legacyGlobalConfigPath()}.pre-e1-bak`)).toBe(true);
  });

  it('falls back to the legacy data-dir copy when only it exists and migration was already marked', () => {
    // Edge case: a file lands in the data dir AFTER the marker was stamped
    // (e.g. scaffold.ts still writes there). The resolver must still find it
    // via the transition-window fallback.
    const { dataDir } = stageTempHome();
    mkdirSync(join(dataDir, '.migrations'), { recursive: true });
    writeFileSync(join(dataDir, '.migrations', 'config-dir-v1.done'), '\n', 'utf-8');

    writeFileSync(
      legacyGlobalConfigPath(),
      JSON.stringify({ llm: { providers: { openai: { apiKey: 'sk-legacy-fallback' } } } }),
      'utf-8',
    );

    const result = resolveCredentials('openai');

    expect(result.apiKey).toBe('sk-legacy-fallback');
    expect(result.source).toBe('global-config');
  });
});
