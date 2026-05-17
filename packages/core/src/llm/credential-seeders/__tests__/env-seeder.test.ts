/**
 * Unit tests for `EnvSeeder` and `registerEnvSeeders` (T9409).
 *
 * Scope:
 *
 * - Env var set → emits one entry, trimmed, tagged `source:'env'`.
 * - Env var unset / empty / whitespace-only → emits zero entries.
 * - Wrong-provider env var stays inert for unrelated seeders.
 * - `isConsentEstablished` returns `true` unconditionally.
 * - `registerEnvSeeders` populates one entry per provider in `ENV_VARS`.
 * - Module-load side effect populates `BUILTIN_SEEDERS`.
 *
 * Cross-platform isolation uses the canonical `SAVED_ENV` pattern from
 * `__tests__/global-config-migration.test.ts`: every test saves the
 * affected env keys, clears them, runs, and restores so a stray
 * developer-local `ANTHROPIC_API_KEY` does not leak into assertions.
 *
 * @task T9409
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_VARS } from '../../credentials.js';
import type { ModelTransport } from '../../types-config.js';
import { ENV_SEEDER_PRIORITY, EnvSeeder, registerEnvSeeders } from '../env-seeder.js';
import {
  BUILTIN_SEEDERS,
  type CredentialSeeder,
  SeederRegistry,
  type SeederSourceId,
} from '../index.js';

// ---------------------------------------------------------------------------
// Env isolation (cross-platform — save/restore every provider env var
// plus `CLEO_HOME` and the XDG keys so paths-based tests cannot leak)
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  ...Object.values(ENV_VARS),
  'CLEO_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
];

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function clearProviderEnv(): void {
  for (const k of Object.values(ENV_VARS)) delete process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

beforeEach(() => {
  saveEnv();
  clearProviderEnv();
});

afterEach(() => {
  restoreEnv();
});

// ---------------------------------------------------------------------------
// EnvSeeder — single-provider behaviour
// ---------------------------------------------------------------------------

describe('EnvSeeder', () => {
  describe('contract', () => {
    it('exposes sourceId="env" and the requested provider', () => {
      const seeder = new EnvSeeder('anthropic');
      expect(seeder.sourceId).toBe('env');
      expect(seeder.provider).toBe('anthropic');
    });

    it('snapshots the canonical env var name at construction', () => {
      expect(new EnvSeeder('anthropic').envVarName).toBe('ANTHROPIC_API_KEY');
      expect(new EnvSeeder('openai').envVarName).toBe('OPENAI_API_KEY');
      expect(new EnvSeeder('ollama').envVarName).toBe('OLLAMA_HOST');
    });

    it('throws when constructed for a provider without a canonical env var', () => {
      // Type system blocks the literal in real callers — cast here to
      // simulate a programmer error and assert the runtime guard fires.
      expect(() => new EnvSeeder('not-a-real-provider' as ModelTransport)).toThrow(
        /E_ENV_SEEDER_UNKNOWN_PROVIDER.*provider='not-a-real-provider'/,
      );
    });

    it('reports consent established unconditionally', () => {
      const seeder = new EnvSeeder('anthropic');
      expect(seeder.isConsentEstablished()).toBe(true);
    });
  });

  describe('seed()', () => {
    it('emits one entry when the env var is set to a non-empty value', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-key-abc';
      const seeder = new EnvSeeder('anthropic');

      const result = await seeder.seed();

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        provider: 'anthropic',
        label: 'env:ANTHROPIC_API_KEY',
        authType: 'api_key',
        source: 'env',
        accessToken: 'sk-ant-key-abc',
        priority: ENV_SEEDER_PRIORITY,
      });
      expect(result.warnings).toBeUndefined();
    });

    it('trims surrounding whitespace from the env var value', async () => {
      process.env['OPENAI_API_KEY'] = '   sk-openai-trimmed   \n';
      const seeder = new EnvSeeder('openai');

      const result = await seeder.seed();

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.accessToken).toBe('sk-openai-trimmed');
      expect(result.entries[0]?.label).toBe('env:OPENAI_API_KEY');
    });

    it('emits zero entries when the env var is unset', async () => {
      // beforeEach already deleted the provider env vars — assert explicitly
      expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
      const seeder = new EnvSeeder('anthropic');

      const result = await seeder.seed();

      expect(result.entries).toEqual([]);
    });

    it('emits zero entries when the env var is the empty string', async () => {
      process.env['GEMINI_API_KEY'] = '';
      const seeder = new EnvSeeder('gemini');

      const result = await seeder.seed();

      expect(result.entries).toEqual([]);
    });

    it('emits zero entries when the env var is whitespace-only', async () => {
      process.env['MOONSHOT_API_KEY'] = '   \t \n  ';
      const seeder = new EnvSeeder('moonshot');

      const result = await seeder.seed();

      expect(result.entries).toEqual([]);
    });

    it('ignores env vars belonging to other providers', async () => {
      // Set OpenAI's env var; the Anthropic seeder MUST NOT see it.
      process.env['OPENAI_API_KEY'] = 'sk-openai-only';
      const anthropicSeeder = new EnvSeeder('anthropic');

      const result = await anthropicSeeder.seed();

      expect(result.entries).toEqual([]);
    });

    it('handles ollama (OLLAMA_HOST) which is informational not a key', async () => {
      // The mapping intentionally exposes OLLAMA_HOST for ollama. When set,
      // the seeder treats the host URL the same as an api_key entry — pool
      // policy (T9412) decides whether ollama actually consumes it.
      process.env['OLLAMA_HOST'] = 'http://localhost:11434';
      const seeder = new EnvSeeder('ollama');

      const result = await seeder.seed();

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.accessToken).toBe('http://localhost:11434');
      expect(result.entries[0]?.label).toBe('env:OLLAMA_HOST');
    });
  });
});

// ---------------------------------------------------------------------------
// registerEnvSeeders — registry-level behaviour
// ---------------------------------------------------------------------------

describe('registerEnvSeeders', () => {
  it('registers one env seeder per provider in ENV_VARS into a fresh registry', () => {
    const registry = new SeederRegistry();
    registerEnvSeeders(registry);

    const providerCount = Object.keys(ENV_VARS).length;
    expect(registry.getAll()).toHaveLength(providerCount);

    for (const provider of Object.keys(ENV_VARS) as ModelTransport[]) {
      const matches = registry.getByProvider(provider);
      expect(matches).toHaveLength(1);
      const seeder = matches[0] as CredentialSeeder & { envVarName?: string };
      expect(seeder.sourceId).toBe<SeederSourceId>('env');
      expect(seeder.provider).toBe(provider);
      // Property visible because the entry is an EnvSeeder instance.
      expect(seeder.envVarName).toBe(ENV_VARS[provider]);
    }
  });

  it('throws E_SEEDER_DUPLICATE when called twice on the same registry', () => {
    const registry = new SeederRegistry();
    registerEnvSeeders(registry);
    expect(() => registerEnvSeeders(registry)).toThrow(/E_SEEDER_DUPLICATE/);
  });
});

// ---------------------------------------------------------------------------
// BUILTIN_SEEDERS — module-load side effect populated the singleton
// ---------------------------------------------------------------------------

describe('BUILTIN_SEEDERS module-load registration', () => {
  it('has an env seeder for every provider in ENV_VARS', () => {
    for (const provider of Object.keys(ENV_VARS) as ModelTransport[]) {
      const matches = BUILTIN_SEEDERS.getByProvider(provider).filter((s) => s.sourceId === 'env');
      expect(matches, `expected one env seeder for provider='${provider}'`).toHaveLength(1);
    }
  });

  it('env seeders in the singleton produce trimmed entries tagged source:"env"', async () => {
    process.env['XAI_API_KEY'] = '  xai-token-99  ';

    const seeders = BUILTIN_SEEDERS.getByProvider('xai').filter((s) => s.sourceId === 'env');
    expect(seeders).toHaveLength(1);

    const seeder = seeders[0];
    expect(seeder).toBeDefined();
    const result = await (seeder as CredentialSeeder).seed();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      provider: 'xai',
      source: 'env',
      authType: 'api_key',
      label: 'env:XAI_API_KEY',
      accessToken: 'xai-token-99',
    });
  });
});
