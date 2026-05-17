/**
 * Unit tests for `CleoPkceSeeder` (E-CONFIG-AUTH-UNIFY E2a / T9411).
 *
 * Like the `claude-code` seeder tests, the suite uses constructor-injected
 * dependency seams so it stays pure — no fs writes, no env-var fiddling,
 * no module mocks. Each test asserts one branch of the seeder's decision
 * tree:
 *
 * - valid token → one pool entry emitted, with scopes-aware fields
 * - missing file → empty (no throw)
 * - malformed JSON → empty (no throw)
 * - expired token → empty (parser drops it)
 * - auto-registered in BUILTIN_SEEDERS
 *
 * Unlike `claude-code`, this seeder reads a first-party file so there is
 * NO consent gate to test — the `isConsentEstablished` hook is omitted on
 * the class entirely (treated as "always consented" per the contract).
 *
 * @task T9411
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_SEEDERS, CleoPkceSeeder, SeederRegistry } from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FUTURE_EXPIRES_AT = Date.now() + 24 * 60 * 60 * 1000; // +24 hours
const PAST_EXPIRES_AT = Date.now() - 60 * 60 * 1000; // -1 hour

function validPkceJson(): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-cleo-pkce-fixture',
      refreshToken: 'sk-ant-ort-cleo-pkce-fixture',
      expiresAt: FUTURE_EXPIRES_AT,
      scopes: ['user:inference'],
    },
  });
}

function expiredPkceJson(): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-cleo-pkce-fixture',
      refreshToken: 'sk-ant-ort-cleo-pkce-fixture',
      expiresAt: PAST_EXPIRES_AT,
    },
  });
}

// ---------------------------------------------------------------------------
// Behavioural tests
// ---------------------------------------------------------------------------

describe('CleoPkceSeeder', () => {
  describe('identity', () => {
    it('reports sourceId=cleo-pkce and provider=anthropic', () => {
      const seeder = new CleoPkceSeeder({ readCredentialFile: () => null });
      expect(seeder.sourceId).toBe('cleo-pkce');
      expect(seeder.provider).toBe('anthropic');
    });

    it('does NOT declare an isConsentEstablished hook (first-party source)', () => {
      const seeder = new CleoPkceSeeder({ readCredentialFile: () => null });
      // The PKCE file is CLEO-owned; consent is implicit by running `cleo
      // llm login`. Declaring the hook would route the seeder through the
      // consent gate path in the resolver, which is wrong.
      expect(seeder.isConsentEstablished).toBeUndefined();
    });
  });

  describe('seed — happy path', () => {
    it('emits one anthropic entry when the PKCE file is present + valid', async () => {
      const seeder = new CleoPkceSeeder({
        readCredentialFile: () => validPkceJson(),
      });

      const result = await seeder.seed();

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0]!;
      expect(entry.provider).toBe('anthropic');
      expect(entry.label).toBe('cleo-pkce');
      expect(entry.source).toBe('cleo-pkce');
      expect(entry.authType).toBe('oauth');
      expect(entry.accessToken).toBe('sk-ant-oat-cleo-pkce-fixture');
      expect(entry.refreshToken).toBe('sk-ant-ort-cleo-pkce-fixture');
      expect(entry.expiresAt).toBe(FUTURE_EXPIRES_AT);
    });

    it('omits refreshToken/expiresAt when the source file omits them', async () => {
      const seeder = new CleoPkceSeeder({
        readCredentialFile: () =>
          JSON.stringify({
            claudeAiOauth: { accessToken: 'sk-ant-oat-no-extras' },
          }),
      });

      const result = await seeder.seed();
      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0]!;
      expect(entry.accessToken).toBe('sk-ant-oat-no-extras');
      expect(entry).not.toHaveProperty('refreshToken');
      expect(entry).not.toHaveProperty('expiresAt');
    });
  });

  describe('seed — degraded source paths', () => {
    it('returns empty when the PKCE file is missing (null)', async () => {
      const seeder = new CleoPkceSeeder({
        readCredentialFile: () => null,
      });
      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('returns empty when the JSON is malformed', async () => {
      const seeder = new CleoPkceSeeder({
        readCredentialFile: () => '{ not valid json',
      });
      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('returns empty when the token is expired', async () => {
      const seeder = new CleoPkceSeeder({
        readCredentialFile: () => expiredPkceJson(),
      });
      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('returns empty when the claudeAiOauth block is absent', async () => {
      const seeder = new CleoPkceSeeder({
        readCredentialFile: () => JSON.stringify({ someOtherKey: 'value' }),
      });
      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('does NOT throw on filesystem errors — collapses to empty', async () => {
      const seeder = new CleoPkceSeeder({
        // Simulates the default `readCredentialFile`'s contract: every
        // error path (ENOENT, EACCES, etc.) collapses to `null`.
        readCredentialFile: () => null,
      });
      await expect(seeder.seed()).resolves.toEqual({ entries: [] });
    });
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe('BUILTIN_SEEDERS auto-registration (cleo-pkce)', () => {
  it('contains exactly one (cleo-pkce, anthropic) seeder', () => {
    const matches = BUILTIN_SEEDERS.getAll().filter(
      (s) => s.sourceId === 'cleo-pkce' && s.provider === 'anthropic',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBeInstanceOf(CleoPkceSeeder);
  });

  it('exposes the seeder via getByProvider("anthropic")', () => {
    const anthropicSeeders = BUILTIN_SEEDERS.getByProvider('anthropic');
    const pkce = anthropicSeeders.find((s) => s.sourceId === 'cleo-pkce');
    expect(pkce).toBeDefined();
    expect(pkce).toBeInstanceOf(CleoPkceSeeder);
  });

  it('uses the canonical SeederRegistry key encoding', () => {
    expect(SeederRegistry.makeKey('cleo-pkce', 'anthropic')).toBe('cleo-pkce::anthropic');
  });
});
