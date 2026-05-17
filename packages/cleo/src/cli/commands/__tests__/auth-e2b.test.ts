/**
 * E2b closure — integration tests for the `cleo auth` removal +
 * migrate-project-secrets surface (T9419 — E-CONFIG-AUTH-UNIFY §5.2 T-E2-12).
 *
 * Unlike the wiring tests in `auth-command.test.ts` and `auth-migrate.test.ts`
 * (which mock the credential pool, removal registry, and store so the
 * subcommand's *citty wiring* can be exercised in isolation), this file
 * exercises the **real** modules end-to-end with `CLEO_HOME` redirected at a
 * fresh tmpdir. Three closure-grade scenarios are covered:
 *
 *   1. `cleo auth remove anthropic claude-code` invokes the real
 *      `CLAUDE_CODE_REMOVAL_STEP` and persists a suppression entry to
 *      `${CLEO_HOME}/auth-suppression.json` — verifiable by reading the
 *      file back through {@link readSuppressionFile}.
 *
 *   2. After suppression is written, re-running a real `UnifiedCredentialPool`
 *      seed pass with a `claude-code × anthropic` seeder in the registry
 *      reports `skipped-suppressed` for that seeder — proving suppression
 *      durability across seed runs (the very property E2b promises).
 *
 *   3. `runMigrateProjectSecrets` migrates a real `.cleo/config.json`'s
 *      `llm.providers.*.apiKey` entries into the real
 *      `~/.cleo/llm-credentials.json` store and the cleaned config no longer
 *      contains `apiKey`.
 *
 * Isolation strategy follows `credential-pool-unified.test.ts` — every test
 * redirects `CLEO_HOME`, `XDG_DATA_HOME`, and `HOME` to fresh tmpdirs so
 * neither developer state nor parallel test workers collide.
 *
 * @task T9419
 * @epic E-CONFIG-AUTH-UNIFY (E2b §5.2 T-E2-12)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCredentialPoolSingletonForTests,
  UnifiedCredentialPool,
} from '@cleocode/core/llm/credential-pool.js';
import {
  isSuppressed,
  readSuppressionFile,
  suppressionStatePath,
} from '@cleocode/core/llm/credential-removal.js';
import {
  type CredentialSeeder,
  SeederRegistry,
} from '@cleocode/core/llm/credential-seeders/index.js';
import { clearAnthropicKeyCache } from '@cleocode/core/llm/credentials.js';
import {
  _resetPermsWarningForTests,
  credentialsStorePath,
  listCredentials,
} from '@cleocode/core/llm/credentials-store.js';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrateProjectSecrets } from '../auth/migrate-project-secrets.js';
import { authCommand } from '../auth.js';

// ---------------------------------------------------------------------------
// Environment isolation — mirrors credential-pool-unified.test.ts
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_DIR',
  'CLEO_FORMAT',
  'HOME',
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
 * Point CLEO_HOME / XDG_DATA_HOME / HOME at fresh tmpdirs so the on-disk
 * credentials store, suppression file, and home-dir reads cannot collide
 * with developer data or parallel workers.
 */
function isolateHomes(): { cleoHome: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-e2b-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-e2b-home-${stamp}`);
  const cleoHome = join(xdgRoot, 'cleo');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['CLEO_HOME'] = cleoHome;
  process.env['HOME'] = home;
  return { cleoHome };
}

// ---------------------------------------------------------------------------
// CLI helpers — match auth-command.test.ts wiring
// ---------------------------------------------------------------------------

async function getAuthSubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof authCommand.subCommands === 'function'
      ? await authCommand.subCommands()
      : authCommand.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

async function runSub(
  cmd: CommandDef,
  args: Record<string, unknown>,
  rawArgs: string[] = [],
): Promise<void> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('Subcommand has no run function');
  await runFn({ args, rawArgs, cmd: resolved });
}

function captureStdout(): { restore: () => void; lines: string[] } {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

function captureStderr(): { restore: () => void; lines: string[] } {
  const orig = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetCredentialPoolSingletonForTests();
  // The auth subcommands emit LAFS JSON when CLEO_FORMAT=json — match the
  // shape the auth-command.test.ts wiring tests already assert on.
  process.env['CLEO_FORMAT'] = 'json';
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetCredentialPoolSingletonForTests();
});

// ---------------------------------------------------------------------------
// 1. cleo auth remove anthropic claude-code persists suppression to disk
// ---------------------------------------------------------------------------

describe('cleo auth remove — suppression file is persisted to disk (T9419 §5.2 T-E2-12)', () => {
  it('writes <CLEO_HOME>/auth-suppression.json with the claude-code anthropic entry', async () => {
    const { cleoHome } = isolateHomes();

    // Seed a real claude-code-sourced credential into the real store. We
    // bypass the seeder + consent gate by writing the JSON directly so the
    // integration test focuses on the removal half of the flow (consent +
    // claude-code seeding are covered by their own unit tests).
    const storePath = credentialsStorePath();
    expect(storePath.startsWith(cleoHome)).toBe(true);
    writeFileSync(
      storePath,
      JSON.stringify(
        {
          version: 1,
          strategy: 'priorityWithFallback',
          credentials: [
            {
              provider: 'anthropic',
              label: 'claude-code-import',
              authType: 'oauth',
              accessToken: 'sk-ant-oat-INTEGRATION-FIXTURE',
              priority: 100,
              source: 'claude-code',
            },
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    // Suppression file MUST NOT exist before the remove call — proves we are
    // observing a real disk-write rather than pre-existing developer state.
    expect(existsSync(suppressionStatePath())).toBe(false);

    const stdout = captureStdout();
    const stderr = captureStderr();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['remove']!, {
        provider: 'anthropic',
        label: 'claude-code-import',
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }

    // Suppression file exists, parses, and contains the expected entry.
    expect(existsSync(suppressionStatePath())).toBe(true);
    const suppFile = readSuppressionFile();
    expect(suppFile.version).toBe(1);
    expect(suppFile.entries).toHaveLength(1);
    expect(suppFile.entries[0]).toMatchObject({
      provider: 'anthropic',
      sourceId: 'claude-code',
    });
    expect(typeof suppFile.entries[0]?.suppressedAt).toBe('number');
    expect(isSuppressed('anthropic', 'claude-code')).toBe(true);

    // The CLEO-MUST-NEVER-DELETE hint was surfaced to stderr (E2b safety
    // contract — the file is owned by Claude Code, not CLEO).
    const hintLine = stderr.lines.find(
      (l) => l.startsWith('hint:') && l.includes('.claude/.credentials.json'),
    );
    expect(hintLine).toBeDefined();

    // LAFS envelope on stdout reflects suppression + removal.
    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({
      provider: 'anthropic',
      label: 'claude-code-import',
      source: 'claude-code',
      suppressed: true,
      removed: true,
    });

    // Store no longer contains the entry — visible to the very next list().
    const remaining = await listCredentials('anthropic');
    expect(remaining.find((c) => c.label === 'claude-code-import')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Re-seeding pool after suppression skips the suppressed source
// ---------------------------------------------------------------------------

describe('cleo auth remove — durability: a seed pass after suppression skips the suppressed source (T9419 §5.2 T-E2-12)', () => {
  it('reports skipped-suppressed for the claude-code anthropic seeder once suppression is on disk', async () => {
    isolateHomes();

    // Stage 1 — seed a credential, then exercise `cleo auth remove` which
    // writes the real suppression file via addSuppression().
    writeFileSync(
      credentialsStorePath(),
      JSON.stringify(
        {
          version: 1,
          strategy: 'priorityWithFallback',
          credentials: [
            {
              provider: 'anthropic',
              label: 'claude-code-import',
              authType: 'oauth',
              accessToken: 'sk-ant-oat-DURABILITY-FIXTURE',
              priority: 100,
              source: 'claude-code',
            },
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const stdout = captureStdout();
    const stderr = captureStderr();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['remove']!, {
        provider: 'anthropic',
        label: 'claude-code-import',
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }

    expect(isSuppressed('anthropic', 'claude-code')).toBe(true);

    // Stage 2 — build a fresh `UnifiedCredentialPool` with a registry
    // containing exactly the suppressed seeder + one un-suppressed seeder for
    // contrast. A `seed()` pass must skip the suppressed seeder and run the
    // other (proves suppression is honoured by the real seed loop, not just
    // recorded to disk).
    const claudeCodeSeeder: CredentialSeeder = {
      sourceId: 'claude-code',
      provider: 'anthropic',
      async seed() {
        return {
          entries: [
            {
              provider: 'anthropic',
              label: 'claude-code-import',
              authType: 'oauth',
              accessToken: 'sk-ant-oat-REDISCOVERED',
              source: 'claude-code',
            },
          ],
        };
      },
    };
    const envOpenAiSeeder: CredentialSeeder = {
      sourceId: 'env',
      provider: 'openai',
      async seed() {
        return {
          entries: [
            {
              provider: 'openai',
              label: 'env:OPENAI_API_KEY',
              authType: 'api_key',
              accessToken: 'sk-openai-DURABILITY',
              source: 'env',
            },
          ],
        };
      },
    };

    const registry = new SeederRegistry();
    registry.register(claudeCodeSeeder);
    registry.register(envOpenAiSeeder);

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    const result = await pool.seed();

    // The claude-code seeder MUST be skipped because of the suppression
    // entry written by `cleo auth remove`. The env-openai seeder MUST add.
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    const status = pool.getSeederStatus();
    const claude = status.find((s) => s.sourceId === 'claude-code' && s.provider === 'anthropic');
    expect(claude?.lastResult).toBe('skipped-suppressed');

    const envOpenai = status.find((s) => s.sourceId === 'env' && s.provider === 'openai');
    expect(envOpenai?.lastResult).toBe('ok');

    // And the durable proof: list() does NOT contain a re-seeded
    // claude-code-import entry for anthropic.
    const stored = await listCredentials();
    const reSeeded = stored.find(
      (c) => c.provider === 'anthropic' && c.label === 'claude-code-import',
    );
    expect(reSeeded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. cleo auth migrate-project-secrets removes apiKey from project config
// ---------------------------------------------------------------------------

describe('cleo auth migrate-project-secrets — removes apiKey from project config and seeds the pool (T9419 §5.2 T-E2-12)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-e2b-mig-'));
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('moves every llm.providers.*.apiKey into the pool; cleaned config no longer contains apiKey', async () => {
    isolateHomes();

    // Seed a real project config containing two provider apiKey entries.
    const cfgDir = join(projectRoot, '.cleo');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          llm: {
            providers: {
              anthropic: { apiKey: 'sk-ant-api03-E2B-FIXTURE' },
              openai: {
                apiKey: 'sk-openai-E2B-FIXTURE',
                baseUrl: 'https://api.openai.com',
              },
            },
            default: { provider: 'anthropic', model: 'claude-sonnet-test' },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = await runMigrateProjectSecrets({
      projectRoot,
      yes: true,
      dryRun: false,
    });

    // Migration outcome envelope.
    expect(result.cancelled).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.migrated.map((m) => m.provider).sort()).toEqual(['anthropic', 'openai']);
    expect(result.migrated.every((m) => m.moved)).toBe(true);
    expect(result.backupPath).toBe(`${cfgPath}.pre-migration-bak`);
    expect(existsSync(result.backupPath!)).toBe(true);

    // The cleaned project config no longer contains any apiKey field. The
    // contract (T9417) is the strongest possible statement of E2b's
    // "no project-level secrets" invariant: a raw string search MUST NOT
    // find `apiKey` anywhere in the post-migration file.
    const cleanedRaw = readFileSync(cfgPath, 'utf-8');
    expect(cleanedRaw).not.toContain('apiKey');
    expect(cleanedRaw).not.toContain('sk-ant-api03-E2B-FIXTURE');
    expect(cleanedRaw).not.toContain('sk-openai-E2B-FIXTURE');

    const cleaned = JSON.parse(cleanedRaw) as Record<string, unknown>;
    const llm = cleaned['llm'] as Record<string, unknown>;
    const providers = llm['providers'] as Record<string, unknown>;
    // anthropic had only apiKey -> dropped entirely; openai retained baseUrl.
    expect(providers['anthropic']).toBeUndefined();
    expect(providers['openai']).toEqual({ baseUrl: 'https://api.openai.com' });
    // Other LLM keys preserved.
    expect(llm['default']).toEqual({ provider: 'anthropic', model: 'claude-sonnet-test' });

    // And the pool store NOW contains both migrated entries with
    // label='migrated-from-project-config' + source='manual'.
    const stored = await listCredentials();
    const anthropic = stored.find(
      (c) => c.provider === 'anthropic' && c.label === 'migrated-from-project-config',
    );
    const openai = stored.find(
      (c) => c.provider === 'openai' && c.label === 'migrated-from-project-config',
    );
    expect(anthropic).toBeDefined();
    expect(anthropic?.source).toBe('manual');
    expect(anthropic?.accessToken).toBe('sk-ant-api03-E2B-FIXTURE');
    expect(openai).toBeDefined();
    expect(openai?.source).toBe('manual');
    expect(openai?.accessToken).toBe('sk-openai-E2B-FIXTURE');

    // Backup is byte-perfect — the operator can restore in one cp.
    const backupRaw = readFileSync(result.backupPath!, 'utf-8');
    const originalRoundTripped = JSON.stringify(
      {
        llm: {
          providers: {
            anthropic: { apiKey: 'sk-ant-api03-E2B-FIXTURE' },
            openai: {
              apiKey: 'sk-openai-E2B-FIXTURE',
              baseUrl: 'https://api.openai.com',
            },
          },
          default: { provider: 'anthropic', model: 'claude-sonnet-test' },
        },
      },
      null,
      2,
    );
    expect(backupRaw).toBe(originalRoundTripped);
  });
});
