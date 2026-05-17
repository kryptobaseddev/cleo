/**
 * E2a stack tests — full integration: seeders → pool → resolver (T9414).
 *
 * Filename note: this file deliberately avoids the `-integration.test.ts`
 * suffix because the package's `vitest.config.ts` excludes that pattern
 * from `pnpm run test` (those tests run only via `pnpm run test:integration`
 * which is currently scoped to `src/store/__tests__/*-integration.test.ts`).
 * Calling this suite `e2a-stack.test.ts` keeps it in the unit-test sweep so
 * the CI gate that closes T9414 actually exercises it.
 *
 * Verifies the unified credential pipeline end-to-end by exercising the
 * three primary entry points operators interact with:
 *
 * 1. `resolveCredentialsAsync('anthropic')` returns a claude-code entry
 *    when the `~/.claude/.credentials.json` file is present AND consent is
 *    given via `auth.claudeCodeConsentGiven`. The pool is seeded with a
 *    `ClaudeCodeSeeder` configured to mimic both gates.
 *
 * 2. `resolveCredentialsAsync('openai')` returns an env entry when only
 *    the `OPENAI_API_KEY` env var is set. The pool is seeded with an
 *    `EnvSeeder`-style entry whose `source` is `'env'`.
 *
 * 3. `resolveCredentialsAsync('moonshot')` returns `{ apiKey: null }`
 *    when no source (env, claude-creds, pool entry, …) is present.
 *
 * 4. `getCredentialPool().list()` surfaces every entry written by the
 *    seeder sweep across multiple sources (claude-code + env + cleo-pkce)
 *    — proving `cleo auth list` (which is a thin wrapper over `list()`)
 *    correctly aggregates credentials from every registered seeder.
 *
 * Isolation strategy mirrors `credential-pool-unified.test.ts`: every test
 * points `HOME`, `XDG_DATA_HOME`, and `CLEO_HOME` at fresh tmpdirs so the
 * on-disk credential store, suppression list, and claude-code path cannot
 * leak between tests or pick up developer state.
 *
 * Scope clarification (T9414 is "E2a verify", not "rebuild E2a"):
 * this suite exercises the integration boundaries between the components
 * shipped in T9408–T9413. Per-component branch coverage already lives in:
 *
 *   - `credential-seeders/__tests__/*` (seeder behaviour)
 *   - `credential-pool-unified.test.ts` (pool sweep / gating / cache)
 *   - `credentials.test.ts` (resolver tier semantics)
 *
 * @task T9414
 * @epic E-CONFIG-AUTH-UNIFY (E2a §5.2 T-E2-11)
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCredentialPoolSingletonForTests,
  getCredentialPool,
  UnifiedCredentialPool,
} from '../credential-pool.js';
import {
  ClaudeCodeSeeder,
  type CredentialSeeder,
  SeederRegistry,
  type SeederSourceId,
} from '../credential-seeders/index.js';
import {
  _resetCredentialDeprecationLatchesForTests,
  clearAnthropicKeyCache,
  resolveCredentialsAsync,
} from '../credentials.js';
import { _resetPermsWarningForTests } from '../credentials-store.js';

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_DIR',
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
 * Pin every CLEO/XDG env var at a fresh tmpdir so the on-disk credential
 * store and home-dir reads are fully isolated for this test.
 */
function isolateHomes(): { cleoDir: string; home: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-e2a-int-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-e2a-int-home-${stamp}`);
  const cleoHome = join(xdgRoot, 'cleo');
  const xdgConfigHome = join(xdgRoot, 'config-home');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_HOME'] = cleoHome;
  process.env['HOME'] = home;
  _resetCleoPlatformPathsCache();
  return { cleoDir: cleoHome, home };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Far-future expiry so the parser never trips on `Date.now()` drift. */
const FUTURE_EXPIRES_AT = Date.now() + 24 * 60 * 60 * 1000; // +24 h

/** Minimal valid `~/.claude/.credentials.json` payload. */
function validClaudeCredentialsJson(): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-claude-code-fixture',
      refreshToken: 'sk-ant-ort-claude-code-fixture',
      expiresAt: FUTURE_EXPIRES_AT,
    },
  });
}

/**
 * Build a one-shot seeder that returns a single canned entry. Mirrors the
 * helper used by `credential-pool-unified.test.ts` and `credentials.test.ts`
 * — duplicated here to keep this suite self-contained.
 */
function makeStaticSeeder(opts: {
  sourceId: SeederSourceId;
  provider: string;
  token: string;
  label?: string;
  authType?: 'api_key' | 'oauth';
}): CredentialSeeder {
  const label = opts.label ?? `${opts.sourceId}:${opts.provider}`;
  return {
    sourceId: opts.sourceId,
    provider: opts.provider,
    async seed() {
      return {
        entries: [
          {
            provider: opts.provider as never,
            label,
            authType: opts.authType ?? 'api_key',
            source: opts.sourceId,
            accessToken: opts.token,
          },
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetCredentialPoolSingletonForTests();
  _resetCredentialDeprecationLatchesForTests();
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetCredentialPoolSingletonForTests();
  _resetCredentialDeprecationLatchesForTests();
});

// ---------------------------------------------------------------------------
// resolveCredentialsAsync('anthropic') — claude-code seeder path
// ---------------------------------------------------------------------------

describe('E2a integration — resolveCredentialsAsync routes claude-code source', () => {
  it('returns a claude-code entry when claude-creds present + consent given (via pool)', async () => {
    isolateHomes();

    // Seed the on-disk store via a `ClaudeCodeSeeder` whose dependencies are
    // pinned to "file present + consent given". This is the integration path
    // the singleton uses on real machines, just with the I/O seams stubbed so
    // the test never touches the developer's home dir.
    const registry = new SeederRegistry();
    registry.register(
      new ClaudeCodeSeeder({
        readCredentialFile: () => validClaudeCredentialsJson(),
        readConsentFlag: async () => true,
      }),
    );
    const seedingPool = new UnifiedCredentialPool(() => registry.getAll());
    await seedingPool.seed();

    // The singleton-backed async resolver reads the just-written entry.
    const result = await resolveCredentialsAsync('anthropic');

    expect(result.provider).toBe('anthropic');
    expect(result.apiKey).toBe('sk-ant-oat-claude-code-fixture');
    // OAuth-prefixed token from the claude-code seeder must surface as oauth.
    expect(result.authType).toBe('oauth');
    // Pool reads attribute to `cred-file` (the unified pool's storage tag).
    expect(result.source).toBe('cred-file');
  });

  it('returns an env-sourced entry when only the env var path is seeded', async () => {
    isolateHomes();

    // Pre-seed an entry tagged `source: 'env'` — mimics the on-disk artefact
    // produced by `EnvSeeder` after a normal CLI invocation reads
    // `OPENAI_API_KEY` from the environment.
    const registry = new SeederRegistry();
    registry.register(
      makeStaticSeeder({
        sourceId: 'env',
        provider: 'openai',
        token: 'sk-openai-from-env-seeder',
      }),
    );
    const seedingPool = new UnifiedCredentialPool(() => registry.getAll());
    await seedingPool.seed();

    const result = await resolveCredentialsAsync('openai');

    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('sk-openai-from-env-seeder');
    expect(result.source).toBe('cred-file');
    expect(result.authType).toBe('api_key');
  });

  it('returns null when neither env nor claude-creds (nor any pool entry) is present', async () => {
    isolateHomes();

    // No seeders → pool sweep produces zero entries → resolver returns null.
    // The singleton will still try the BUILTIN seeder sweep on first pick,
    // but the isolated HOME has no `~/.claude/.credentials.json`, the
    // consent flag defaults to false, and no env var is set, so every
    // built-in seeder is a no-op.
    const result = await resolveCredentialsAsync('moonshot');

    expect(result.provider).toBe('moonshot');
    expect(result.apiKey).toBeNull();
    expect(result.source).toBeUndefined();
    // The default authType for a null result is the safe `api_key` fallback.
    expect(result.authType).toBe('api_key');
  });
});

// ---------------------------------------------------------------------------
// getCredentialPool().list() — aggregates entries across every source
// ---------------------------------------------------------------------------

describe('E2a integration — getCredentialPool().list() surfaces every seeded source', () => {
  it('lists entries from claude-code, env, and cleo-pkce after a seed sweep', async () => {
    isolateHomes();

    const registry = new SeederRegistry();
    registry.register(
      new ClaudeCodeSeeder({
        readCredentialFile: () => validClaudeCredentialsJson(),
        readConsentFlag: async () => true,
      }),
    );
    registry.register(
      makeStaticSeeder({
        sourceId: 'env',
        provider: 'openai',
        token: 'sk-openai-env',
      }),
    );
    registry.register(
      makeStaticSeeder({
        sourceId: 'cleo-pkce',
        provider: 'anthropic',
        token: 'sk-ant-oat-pkce-fixture',
        authType: 'oauth',
      }),
    );

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    await pool.seed();

    // `cleo auth list` calls `pool.list()` under the hood; assert the same
    // surface here so the CLI contract is exercised end-to-end.
    const all = await pool.list();
    const tagged = all.map((c) => `${c.source}:${c.provider}:${c.label}`).sort();

    expect(tagged).toEqual(
      [
        'claude-code:anthropic:claude-code',
        'cleo-pkce:anthropic:cleo-pkce:anthropic',
        'env:openai:env:openai',
      ].sort(),
    );

    // Spot-check: the claude-code entry carries the OAuth marker so
    // downstream rotation/refresh paths can find it.
    const claude = all.find((c) => c.source === 'claude-code');
    expect(claude?.authType).toBe('oauth');
    expect(claude?.accessToken).toBe('sk-ant-oat-claude-code-fixture');
  });

  it('list() is pure-read — never triggers a seed sweep', async () => {
    isolateHomes();
    let seedCalls = 0;
    const registry = new SeederRegistry();
    registry.register({
      sourceId: 'env',
      provider: 'anthropic',
      async seed() {
        seedCalls++;
        return { entries: [] };
      },
    });

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    const entries = await pool.list();

    expect(entries).toEqual([]);
    expect(seedCalls).toBe(0);
  });

  it('singleton pool also exposes list() — empty when nothing is seeded', async () => {
    isolateHomes();
    // No registry override → real `BUILTIN_SEEDERS`. Isolated HOME has no
    // claude-creds and consent is false, so list() is empty without any
    // pre-seeding work.
    const entries = await getCredentialPool().list();
    expect(entries).toEqual([]);
  });
});
