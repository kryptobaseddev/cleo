/**
 * Unit tests for `UnifiedCredentialPool` + `getCredentialPool` singleton
 * (E-CONFIG-AUTH-UNIFY E2a / T9412).
 *
 * Isolation strategy mirrors `credential-pool.test.ts` — every test points
 * `XDG_DATA_HOME`, `HOME`, and `CLEO_HOME` at fresh tmpdirs so the on-disk
 * credentials store, suppression file, and home-dir reads never collide
 * with developer state or between parallel workers.
 *
 * Scope:
 *
 * - `seed()` invokes every registered seeder and upserts the entries.
 * - Consent gate blocks `seed()` from running (status: `'skipped-consent'`).
 * - Suppression list blocks `seed()` (status: `'skipped-suppressed'`).
 * - Per-seeder failures are isolated; the sweep keeps going.
 * - 60 s cache TTL short-circuits non-`force` calls.
 * - `force: true` bypasses the cache.
 * - `pick()` lazy-seeds on first call.
 * - `list()` reads the store without seeding.
 * - `getCredentialPool()` returns a stable singleton across imports.
 * - `getSeederStatus()` snapshots per-seeder outcomes.
 *
 * @task T9412
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCredentialPoolSingletonForTests,
  getCredentialPool,
  POOL_SEED_CACHE_TTL_MS,
  UnifiedCredentialPool,
} from '../credential-pool.js';
import { addSuppression } from '../credential-removal.js';
import {
  type CredentialSeeder,
  SeederRegistry,
  type SeederResult,
  type SeederSourceId,
} from '../credential-seeders/index.js';
import { clearAnthropicKeyCache } from '../credentials.js';
import { _resetPermsWarningForTests, listCredentials } from '../credentials-store.js';

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_HOME',
  'CLEO_CONFIG_HOME',
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

/** Point CLEO + XDG envs at fresh tmpdirs so state cannot leak. */
function isolateHomes(): void {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-unifiedpool-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-unifiedpool-home-${stamp}`);
  const cleoHome = join(xdgRoot, 'cleo');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['CLEO_HOME'] = cleoHome;
  process.env['HOME'] = home;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a seeder that returns a single canned entry. */
function makeSeeder(opts: {
  sourceId: SeederSourceId;
  provider: string;
  token?: string;
  label?: string;
  consent?: boolean | (() => boolean | Promise<boolean>);
  throwOnSeed?: Error;
  result?: SeederResult;
}): CredentialSeeder {
  const label = opts.label ?? `${opts.sourceId}:${opts.provider}`;
  const result: SeederResult = opts.result ?? {
    entries: [
      {
        provider: opts.provider as never,
        label,
        authType: 'api_key',
        source: opts.sourceId,
        accessToken: opts.token ?? `tok-${label}`,
      },
    ],
  };
  const seeder: CredentialSeeder = {
    sourceId: opts.sourceId,
    provider: opts.provider,
    async seed() {
      if (opts.throwOnSeed) throw opts.throwOnSeed;
      return result;
    },
  };
  if (opts.consent !== undefined) {
    seeder.isConsentEstablished = async (): Promise<boolean> => {
      return typeof opts.consent === 'function' ? await opts.consent() : opts.consent === true;
    };
  }
  return seeder;
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
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetCredentialPoolSingletonForTests();
});

// ---------------------------------------------------------------------------
// seed() — happy path
// ---------------------------------------------------------------------------

describe('UnifiedCredentialPool.seed', () => {
  it('invokes every seeder in the registry and upserts the entries', async () => {
    isolateHomes();
    const registry = new SeederRegistry();
    registry.register(makeSeeder({ sourceId: 'env', provider: 'anthropic' }));
    registry.register(makeSeeder({ sourceId: 'env', provider: 'openai' }));

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    const result = await pool.seed();

    expect(result.added).toBe(2);
    expect(result.failed).toBe(0);

    const stored = await listCredentials();
    expect(stored.map((c) => c.label).sort()).toEqual(['env:anthropic', 'env:openai']);
    expect(stored.every((c) => c.source === 'env')).toBe(true);
  });

  it('records a per-seeder status snapshot for every invocation', async () => {
    isolateHomes();
    const registry = new SeederRegistry();
    registry.register(makeSeeder({ sourceId: 'env', provider: 'anthropic' }));

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    await pool.seed();

    const status = pool.getSeederStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.sourceId).toBe('env');
    expect(status[0]?.provider).toBe('anthropic');
    expect(status[0]?.lastResult).toBe('ok');
    expect(status[0]?.entriesProduced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// seed() — consent + suppression gating
// ---------------------------------------------------------------------------

describe('UnifiedCredentialPool.seed — gating', () => {
  it('skips seeders whose isConsentEstablished returns false', async () => {
    isolateHomes();
    const registry = new SeederRegistry();
    registry.register(
      makeSeeder({ sourceId: 'claude-code', provider: 'anthropic', consent: false }),
    );
    registry.register(makeSeeder({ sourceId: 'env', provider: 'openai' }));

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    const result = await pool.seed();

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    const labels = (await listCredentials()).map((c) => c.label);
    expect(labels).toContain('env:openai');
    expect(labels).not.toContain('claude-code:anthropic');

    const status = pool.getSeederStatus();
    const claude = status.find((s) => s.sourceId === 'claude-code');
    expect(claude?.lastResult).toBe('skipped-consent');
  });

  it('skips seeders that are suppressed via the suppression file', async () => {
    isolateHomes();
    addSuppression('anthropic', 'claude-code');

    const registry = new SeederRegistry();
    registry.register(makeSeeder({ sourceId: 'claude-code', provider: 'anthropic' }));
    registry.register(makeSeeder({ sourceId: 'env', provider: 'anthropic' }));

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    const result = await pool.seed();

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);

    const status = pool.getSeederStatus();
    const claude = status.find((s) => s.sourceId === 'claude-code');
    expect(claude?.lastResult).toBe('skipped-suppressed');
  });
});

// ---------------------------------------------------------------------------
// seed() — failure isolation
// ---------------------------------------------------------------------------

describe('UnifiedCredentialPool.seed — failure isolation', () => {
  it('a seeder that throws does not prevent other seeders from running', async () => {
    isolateHomes();
    const registry = new SeederRegistry();
    registry.register(
      makeSeeder({
        sourceId: 'env',
        provider: 'anthropic',
        throwOnSeed: new Error('boom'),
      }),
    );
    registry.register(makeSeeder({ sourceId: 'env', provider: 'openai' }));

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    const result = await pool.seed();

    expect(result.failed).toBe(1);
    expect(result.added).toBe(1);

    const labels = (await listCredentials()).map((c) => c.label);
    expect(labels).toEqual(['env:openai']);

    const status = pool.getSeederStatus();
    const failing = status.find((s) => s.provider === 'anthropic');
    expect(failing?.lastResult).toBe('failed');
    expect(failing?.error).toContain('boom');
  });
});

// ---------------------------------------------------------------------------
// seed() — 60s cache TTL
// ---------------------------------------------------------------------------

describe('UnifiedCredentialPool.seed — cache TTL', () => {
  it('skips the sweep entirely when the last seed was less than 60s ago', async () => {
    isolateHomes();
    let seedCalls = 0;
    const registry = new SeederRegistry();
    const counter: CredentialSeeder = {
      sourceId: 'env',
      provider: 'anthropic',
      async seed() {
        seedCalls++;
        return { entries: [] };
      },
    };
    registry.register(counter);

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    await pool.seed();
    await pool.seed();
    await pool.seed();

    expect(seedCalls).toBe(1);
  });

  it('force:true bypasses the cache', async () => {
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
    await pool.seed();
    await pool.seed({ force: true });
    await pool.seed({ force: true });

    expect(seedCalls).toBe(3);
  });

  it('re-seeds after the cache TTL elapses (fake timers)', async () => {
    isolateHomes();
    vi.useFakeTimers();
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
    await pool.seed();
    expect(seedCalls).toBe(1);

    // Advance past the cache TTL.
    vi.setSystemTime(Date.now() + POOL_SEED_CACHE_TTL_MS + 1);
    await pool.seed();
    expect(seedCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// pick() / list()
// ---------------------------------------------------------------------------

describe('UnifiedCredentialPool.pick + list', () => {
  it('pick() lazy-seeds on the first call', async () => {
    isolateHomes();
    let seedCalls = 0;
    const registry = new SeederRegistry();
    registry.register({
      sourceId: 'env',
      provider: 'anthropic',
      async seed() {
        seedCalls++;
        return {
          entries: [
            {
              provider: 'anthropic' as never,
              label: 'env:ANTHROPIC_API_KEY',
              authType: 'api_key',
              source: 'env',
              accessToken: 'sk-test',
            },
          ],
        };
      },
    });

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    expect(seedCalls).toBe(0);

    const entry = await pool.pick('anthropic');
    expect(seedCalls).toBe(1);
    expect(entry?.label).toBe('env:ANTHROPIC_API_KEY');
    expect(entry?.accessToken).toBe('sk-test');
  });

  it('pick() returns null when no entry exists for the provider', async () => {
    isolateHomes();
    const registry = new SeederRegistry();
    registry.register(makeSeeder({ sourceId: 'env', provider: 'openai' }));

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    const entry = await pool.pick('anthropic');
    expect(entry).toBeNull();
  });

  it('list() reads the store without invoking seeders', async () => {
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

  it('list() shows entries from every source after a seed sweep', async () => {
    isolateHomes();
    const registry = new SeederRegistry();
    registry.register(makeSeeder({ sourceId: 'env', provider: 'anthropic' }));
    registry.register(
      makeSeeder({ sourceId: 'claude-code', provider: 'anthropic', label: 'claude-code:default' }),
    );
    registry.register(makeSeeder({ sourceId: 'env', provider: 'openai' }));

    const pool = new UnifiedCredentialPool(() => registry.getAll());
    await pool.seed();

    const all = await pool.list();
    expect(all.map((c) => `${c.source}:${c.label}`).sort()).toEqual(
      ['claude-code:claude-code:default', 'env:env:anthropic', 'env:env:openai'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

describe('getCredentialPool — singleton', () => {
  it('returns the same instance across multiple calls', () => {
    isolateHomes();
    const a = getCredentialPool();
    const b = getCredentialPool();
    expect(a).toBe(b);
  });

  it('returns a new instance after _resetCredentialPoolSingletonForTests()', () => {
    isolateHomes();
    const a = getCredentialPool();
    _resetCredentialPoolSingletonForTests();
    const b = getCredentialPool();
    expect(a).not.toBe(b);
  });
});
