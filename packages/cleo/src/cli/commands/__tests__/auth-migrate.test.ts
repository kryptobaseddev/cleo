/**
 * Tests for `cleo auth migrate-project-secrets` (T9417).
 *
 * Covers:
 *   - Wiring: the subcommand is exposed on the `auth` command group.
 *   - Migration moves every `llm.providers.*.apiKey` into the pool,
 *     writes a `.pre-migration-bak`, and strips the keys from the project
 *     config (with empty provider entries dropped).
 *   - Idempotence: running again on the cleaned config is a no-op.
 *   - Dry-run: no filesystem mutation; result envelope flags `dryRun: true`.
 *   - Other `llm.*` keys (`default`, `roles`) are preserved.
 *
 * The credentials-store module is mocked so the test never writes to a real
 * `~/.cleo/llm-credentials.json` — we capture every `addCredential` call.
 *
 * @task T9417
 * @epic E-CONFIG-AUTH-UNIFY (E2b)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockAddCredential = vi.fn().mockResolvedValue(undefined);

// Partial mock — keep every other export (notably `pickCredentialForProviderSync`,
// which `resolveCredentials` uses in the warning-emission integration test).
vi.mock('@cleocode/core/llm/credentials-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/llm/credentials-store.js')>();
  return {
    ...actual,
    addCredential: (...a: unknown[]) => mockAddCredential(...a),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runMigrateProjectSecrets } from '../auth/migrate-project-secrets.js';
import { authCommand } from '../auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectRoot: string;

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function seedConfig(content: unknown): string {
  const cfgDir = join(projectRoot, '.cleo');
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(content, null, 2), 'utf-8');
  return cfgPath;
}

async function getAuthSubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof authCommand.subCommands === 'function'
      ? await authCommand.subCommands()
      : authCommand.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAddCredential.mockClear();
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-mig-secrets-'));
});

afterEach(() => {
  try {
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('cleo auth migrate-project-secrets — wiring', () => {
  it('is registered as a subcommand on `cleo auth`', async () => {
    const subs = await getAuthSubs();
    expect(Object.keys(subs).sort()).toEqual(['list', 'migrate-project-secrets', 'remove']);
  });
});

describe('runMigrateProjectSecrets — happy path', () => {
  it('moves every apiKey into the pool and strips them from the project config', async () => {
    const cfgPath = seedConfig({
      llm: {
        providers: {
          anthropic: { apiKey: 'sk-ant-api03-FIXTURE' },
          openai: { apiKey: 'sk-openai-FIXTURE', baseUrl: 'https://api.openai.com' },
        },
        default: { provider: 'anthropic', model: 'claude-sonnet-test' },
      },
    });

    const result = await runMigrateProjectSecrets({
      projectRoot,
      yes: true,
      dryRun: false,
    });

    // Backup file exists and matches the original byte-for-byte.
    expect(result.backupPath).toBe(`${cfgPath}.pre-migration-bak`);
    expect(existsSync(result.backupPath!)).toBe(true);

    // addCredential called once per provider with the expected shape.
    expect(mockAddCredential).toHaveBeenCalledTimes(2);
    expect(mockAddCredential).toHaveBeenCalledWith({
      provider: 'anthropic',
      label: 'migrated-from-project-config',
      authType: 'api_key',
      accessToken: 'sk-ant-api03-FIXTURE',
      source: 'manual',
    });
    expect(mockAddCredential).toHaveBeenCalledWith({
      provider: 'openai',
      label: 'migrated-from-project-config',
      authType: 'api_key',
      accessToken: 'sk-openai-FIXTURE',
      source: 'manual',
    });

    // Result envelope.
    expect(result.migrated.map((m) => m.provider).sort()).toEqual(['anthropic', 'openai']);
    expect(result.migrated.every((m) => m.moved)).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.dryRun).toBe(false);

    // Cleaned config: anthropic dropped (entry empty after apiKey removal),
    // openai retained (baseUrl remains), default preserved.
    const cleaned = readJsonFile(cfgPath);
    const llm = cleaned['llm'] as Record<string, unknown>;
    const providers = llm['providers'] as Record<string, unknown>;
    expect(providers['anthropic']).toBeUndefined();
    expect(providers['openai']).toEqual({ baseUrl: 'https://api.openai.com' });
    expect(llm['default']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-test' });
  });

  it('writes the backup BEFORE mutating the config (recoverable on partial failure)', async () => {
    const cfgPath = seedConfig({
      llm: { providers: { anthropic: { apiKey: 'sk-original' } } },
    });
    const originalRaw = readFileSync(cfgPath, 'utf-8');

    await runMigrateProjectSecrets({ projectRoot, yes: true, dryRun: false });

    const backupRaw = readFileSync(`${cfgPath}.pre-migration-bak`, 'utf-8');
    expect(backupRaw).toBe(originalRaw);
  });

  it('detects Anthropic OAuth tokens by prefix and stores authType=oauth', async () => {
    seedConfig({
      llm: { providers: { anthropic: { apiKey: 'sk-ant-oat-FIXTURE' } } },
    });

    await runMigrateProjectSecrets({ projectRoot, yes: true, dryRun: false });

    expect(mockAddCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        authType: 'oauth',
        accessToken: 'sk-ant-oat-FIXTURE',
      }),
    );
  });
});

describe('runMigrateProjectSecrets — idempotence', () => {
  it('is a no-op when the project config has no llm.providers.*.apiKey entries', async () => {
    const cfgPath = seedConfig({
      llm: { default: { provider: 'anthropic', model: 'claude-sonnet-test' } },
    });

    const result = await runMigrateProjectSecrets({
      projectRoot,
      yes: true,
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.backupPath).toBeNull();
    expect(result.cancelled).toBe(false);
    expect(mockAddCredential).not.toHaveBeenCalled();
    // Config file untouched — should still parse identically.
    expect(readJsonFile(cfgPath)).toEqual({
      llm: { default: { provider: 'anthropic', model: 'claude-sonnet-test' } },
    });
  });

  it('is a no-op when the project config file is missing', async () => {
    // No seedConfig call — `.cleo/config.json` does not exist.
    const result = await runMigrateProjectSecrets({
      projectRoot,
      yes: true,
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.backupPath).toBeNull();
    expect(mockAddCredential).not.toHaveBeenCalled();
  });

  it('re-running after a successful migration finds nothing to do', async () => {
    seedConfig({
      llm: { providers: { anthropic: { apiKey: 'sk-once' } } },
    });

    await runMigrateProjectSecrets({ projectRoot, yes: true, dryRun: false });
    mockAddCredential.mockClear();

    const second = await runMigrateProjectSecrets({
      projectRoot,
      yes: true,
      dryRun: false,
    });
    expect(second.migrated).toEqual([]);
    expect(second.backupPath).toBeNull();
    expect(mockAddCredential).not.toHaveBeenCalled();
  });
});

describe('runMigrateProjectSecrets — dry-run', () => {
  it('does not write to disk and does not call addCredential', async () => {
    const cfgPath = seedConfig({
      llm: { providers: { anthropic: { apiKey: 'sk-untouched' } } },
    });
    const originalRaw = readFileSync(cfgPath, 'utf-8');

    const result = await runMigrateProjectSecrets({
      projectRoot,
      yes: true,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(result.migrated).toEqual([
      { provider: 'anthropic', label: 'migrated-from-project-config', moved: false },
    ]);
    expect(mockAddCredential).not.toHaveBeenCalled();
    // Config untouched.
    expect(readFileSync(cfgPath, 'utf-8')).toBe(originalRaw);
    expect(existsSync(`${cfgPath}.pre-migration-bak`)).toBe(false);
  });
});

describe('runMigrateProjectSecrets — malformed config', () => {
  it('throws a descriptive error when the project config is not valid JSON', async () => {
    const cfgDir = join(projectRoot, '.cleo');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.json'), '{ not valid json', 'utf-8');

    await expect(
      runMigrateProjectSecrets({ projectRoot, yes: true, dryRun: false }),
    ).rejects.toThrow(/Failed to parse/);
    expect(mockAddCredential).not.toHaveBeenCalled();
  });
});

describe('warnProjectConfigApiKeyRejected — stderr warning (T9413 integration)', () => {
  it('the project-config rejection warning text mentions the migration command', async () => {
    // The warning emitter lives in @cleocode/core/llm/credentials. Verify the
    // string it emits references `cleo auth migrate-project-secrets` so the
    // user discovery loop (warning -> migrate) is wired correctly.
    const { resolveCredentials, _resetCredentialDeprecationLatchesForTests } = await import(
      '@cleocode/core/llm/credentials.js'
    );
    _resetCredentialDeprecationLatchesForTests();

    seedConfig({
      llm: { providers: { anthropic: { apiKey: 'sk-ant-api03-WARN-FIXTURE' } } },
    });

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: unknown) => {
      captured.push(String(s));
      return true;
    }) as typeof process.stderr.write;

    try {
      resolveCredentials('anthropic', { projectRoot });
    } finally {
      process.stderr.write = origWrite;
    }

    const stderr = captured.join('');
    expect(stderr).toContain('cleo auth migrate-project-secrets');
    expect(stderr).toContain('.cleo/config.json');
  });
});
