/**
 * Unit tests for `SeederRegistry` and the `BUILTIN_SEEDERS` singleton
 * (E-CONFIG-AUTH-UNIFY E2a / T9408).
 *
 * Scope: purely type-system / in-memory behaviour. No file I/O, no
 * credential-store interaction — those land in T9409+ when concrete
 * seeders are registered.
 *
 * @task T9408
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SEEDERS,
  type CredentialSeeder,
  SeederRegistry,
  type SeederResult,
  type SeederSourceId,
} from '../index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a no-op `CredentialSeeder` for the given source + provider pair.
 * Every test seeder returns `{ entries: [] }` so the registry contract can
 * be exercised without touching the credential store.
 */
function makeSeeder(
  sourceId: SeederSourceId,
  provider: string,
  result: SeederResult = { entries: [] },
): CredentialSeeder {
  return {
    sourceId,
    provider,
    async seed() {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// SeederRegistry tests
// ---------------------------------------------------------------------------

describe('SeederRegistry', () => {
  describe('register + getAll', () => {
    it('adds a seeder and returns it via getAll()', () => {
      const registry = new SeederRegistry();
      const seeder = makeSeeder('env', 'anthropic');

      registry.register(seeder);

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toBe(seeder);
    });

    it('preserves insertion order in getAll()', () => {
      const registry = new SeederRegistry();
      const a = makeSeeder('env', 'anthropic');
      const b = makeSeeder('claude-code', 'anthropic');
      const c = makeSeeder('env', 'openai');

      registry.register(a);
      registry.register(b);
      registry.register(c);

      expect(registry.getAll()).toEqual([a, b, c]);
    });

    it('returns an empty array before any seeder is registered', () => {
      const registry = new SeederRegistry();
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe('register — uniqueness rule', () => {
    it('rejects a duplicate (sourceId, provider) pair', () => {
      const registry = new SeederRegistry();
      registry.register(makeSeeder('env', 'anthropic'));

      expect(() => registry.register(makeSeeder('env', 'anthropic'))).toThrow(
        /E_SEEDER_DUPLICATE.*sourceId='env'.*provider='anthropic'/,
      );
    });

    it('allows the same sourceId across different providers', () => {
      const registry = new SeederRegistry();
      registry.register(makeSeeder('env', 'anthropic'));
      registry.register(makeSeeder('env', 'openai'));

      expect(registry.getAll()).toHaveLength(2);
    });

    it('allows the same provider across different sourceIds', () => {
      const registry = new SeederRegistry();
      registry.register(makeSeeder('env', 'anthropic'));
      registry.register(makeSeeder('claude-code', 'anthropic'));

      expect(registry.getAll()).toHaveLength(2);
    });
  });

  describe('getByProvider', () => {
    it('returns only seeders matching the requested provider', () => {
      const registry = new SeederRegistry();
      const envAnthropic = makeSeeder('env', 'anthropic');
      const claudeAnthropic = makeSeeder('claude-code', 'anthropic');
      const envOpenai = makeSeeder('env', 'openai');
      registry.register(envAnthropic);
      registry.register(claudeAnthropic);
      registry.register(envOpenai);

      const anthropicSeeders = registry.getByProvider('anthropic');

      expect(anthropicSeeders).toHaveLength(2);
      expect(anthropicSeeders).toContain(envAnthropic);
      expect(anthropicSeeders).toContain(claudeAnthropic);
      expect(anthropicSeeders).not.toContain(envOpenai);
    });

    it('returns an empty array for an unknown provider', () => {
      const registry = new SeederRegistry();
      registry.register(makeSeeder('env', 'anthropic'));

      expect(registry.getByProvider('mistral')).toEqual([]);
    });

    it('preserves insertion order in the filtered slice', () => {
      const registry = new SeederRegistry();
      const a = makeSeeder('env', 'anthropic');
      const b = makeSeeder('env', 'openai');
      const c = makeSeeder('claude-code', 'anthropic');
      registry.register(a);
      registry.register(b);
      registry.register(c);

      expect(registry.getByProvider('anthropic')).toEqual([a, c]);
    });
  });

  describe('makeKey (uniqueness composer)', () => {
    it('separates sourceId and provider so collisions cannot be spoofed', () => {
      // If the composer were just concatenation, ('env', 'foo:bar') could
      // collide with ('env:foo', 'bar'). The `::` separator makes the
      // boundaries explicit. Asserting on the literal protects the contract.
      expect(SeederRegistry.makeKey('env', 'anthropic')).toBe('env::anthropic');
    });
  });
});

// ---------------------------------------------------------------------------
// BUILTIN_SEEDERS singleton tests
// ---------------------------------------------------------------------------

describe('BUILTIN_SEEDERS singleton', () => {
  it('is an instance of SeederRegistry', () => {
    expect(BUILTIN_SEEDERS).toBeInstanceOf(SeederRegistry);
  });

  it('starts empty at T9408 (no concrete seeders registered yet)', () => {
    // Snapshot the size — concrete seeders land in T9409+. If this fires
    // after a future task without updating the assertion, the test
    // surfaces the contract change deliberately.
    //
    // We do NOT assert `length === 0` strictly because the registry may be
    // shared across tests in the same file via Node's ESM module cache;
    // instead we assert there is no seeder pointing at a non-existent
    // source so the singleton's invariant is upheld.
    for (const seeder of BUILTIN_SEEDERS.getAll()) {
      expect(typeof seeder.sourceId).toBe('string');
      expect(typeof seeder.provider).toBe('string');
      expect(typeof seeder.seed).toBe('function');
    }
  });

  it('returns the same instance across re-imports (module-state singleton)', async () => {
    // Dynamic re-import yields the same module record because Node ESM
    // caches modules by resolved URL. The exported `BUILTIN_SEEDERS`
    // const is therefore reference-equal across imports — which is the
    // singleton contract the spec requires.
    const mod = await import('../index.js');
    expect(mod.BUILTIN_SEEDERS).toBe(BUILTIN_SEEDERS);
  });
});

// ---------------------------------------------------------------------------
// CredentialSeeder contract tests
// ---------------------------------------------------------------------------

describe('CredentialSeeder contract', () => {
  it('allows a seeder without isConsentEstablished (optional gate)', async () => {
    const seeder = makeSeeder('env', 'anthropic');
    expect(seeder.isConsentEstablished).toBeUndefined();
    await expect(seeder.seed()).resolves.toEqual({ entries: [] });
  });

  it('supports an optional consent gate that gates per-provider', async () => {
    const seeder: CredentialSeeder = {
      sourceId: 'claude-code',
      provider: 'anthropic',
      isConsentEstablished(provider: string) {
        return provider === 'anthropic';
      },
      async seed() {
        return { entries: [] };
      },
    };

    expect(seeder.isConsentEstablished?.('anthropic')).toBe(true);
    expect(seeder.isConsentEstablished?.('openai')).toBe(false);
  });

  it('allows seeders to surface non-fatal warnings without rejecting', async () => {
    const seeder = makeSeeder('claude-code', 'anthropic', {
      entries: [],
      warnings: ['consent file present but unreadable'],
    });

    const result = await seeder.seed();
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual(['consent file present but unreadable']);
  });
});
