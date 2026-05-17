/**
 * Unit tests for `ClaudeCodeSeeder` (E-CONFIG-AUTH-UNIFY E2a / T9410).
 *
 * The seeder is exercised with constructor-injected dependency seams
 * (`readCredentialFile`, `readConsentFlag`) so the suite stays pure —
 * no fs writes, no env-var fiddling, no module mocks. Each test
 * asserts one branch of the seeder's decision tree:
 *
 * - valid token + consent → one pool entry emitted
 * - valid token + no consent → empty + readCredentialFile NOT called
 * - missing file → empty
 * - expired token → empty
 * - malformed JSON → empty
 * - auto-registered in BUILTIN_SEEDERS
 *
 * @task T9410
 */

import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_SEEDERS, ClaudeCodeSeeder, SeederRegistry } from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Far-future expiry so the parser never trips on `Date.now()` drift. */
const FUTURE_EXPIRES_AT = Date.now() + 24 * 60 * 60 * 1000; // +24 hours
/** Far-past expiry to exercise the expired-token branch. */
const PAST_EXPIRES_AT = Date.now() - 60 * 60 * 1000; // -1 hour

/** Minimal valid Claude Code credentials JSON with a refresh token. */
function validCredentialsJson(): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oauth-fixture-access',
      refreshToken: 'sk-ant-oauth-fixture-refresh',
      expiresAt: FUTURE_EXPIRES_AT,
    },
  });
}

/** Credentials JSON with `expiresAt` in the past — parser drops this. */
function expiredCredentialsJson(): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oauth-fixture-access',
      refreshToken: 'sk-ant-oauth-fixture-refresh',
      expiresAt: PAST_EXPIRES_AT,
    },
  });
}

// ---------------------------------------------------------------------------
// Behavioural tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeSeeder', () => {
  describe('identity', () => {
    it('reports sourceId=claude-code and provider=anthropic', () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => null,
        readConsentFlag: async () => false,
      });
      expect(seeder.sourceId).toBe('claude-code');
      expect(seeder.provider).toBe('anthropic');
    });
  });

  describe('seed — happy path', () => {
    it('emits a single anthropic entry when consent is given and file is valid', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => validCredentialsJson(),
        readConsentFlag: async () => true,
      });

      const result = await seeder.seed();

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0]!;
      expect(entry.provider).toBe('anthropic');
      expect(entry.label).toBe('claude-code');
      expect(entry.source).toBe('claude-code');
      expect(entry.authType).toBe('oauth');
      expect(entry.accessToken).toBe('sk-ant-oauth-fixture-access');
      expect(entry.refreshToken).toBe('sk-ant-oauth-fixture-refresh');
      expect(entry.expiresAt).toBe(FUTURE_EXPIRES_AT);
    });

    it('omits refreshToken/expiresAt when the source file omits them', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () =>
          JSON.stringify({
            claudeAiOauth: { accessToken: 'sk-ant-no-refresh' },
          }),
        readConsentFlag: async () => true,
      });

      const result = await seeder.seed();
      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0]!;
      expect(entry.accessToken).toBe('sk-ant-no-refresh');
      expect(entry).not.toHaveProperty('refreshToken');
      expect(entry).not.toHaveProperty('expiresAt');
    });
  });

  describe('seed — consent gate', () => {
    it('returns empty when consent is not given', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => validCredentialsJson(),
        readConsentFlag: async () => false,
      });

      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('does NOT read the credential file when consent is not given', async () => {
      const readSpy = vi.fn<() => string | null>(() => validCredentialsJson());
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: readSpy,
        readConsentFlag: async () => false,
      });

      const result = await seeder.seed();

      expect(result.entries).toEqual([]);
      // The whole point of the consent gate (Hermes Agent PR #4210):
      // an unconsented seeder MUST NOT touch the credential file.
      expect(readSpy).not.toHaveBeenCalled();
    });

    it('treats consent-flag resolution errors as no-consent (fail closed)', async () => {
      const readSpy = vi.fn<() => string | null>(() => validCredentialsJson());
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: readSpy,
        readConsentFlag: async () => {
          throw new Error('config read failed');
        },
      });

      const result = await seeder.seed();

      expect(result.entries).toEqual([]);
      expect(readSpy).not.toHaveBeenCalled();
    });
  });

  describe('seed — degraded source paths', () => {
    it('returns empty when the credentials file is missing (null)', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => null,
        readConsentFlag: async () => true,
      });

      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('returns empty when the credentials JSON is malformed', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => '{ this is not valid JSON',
        readConsentFlag: async () => true,
      });

      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('returns empty when the token is expired', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => expiredCredentialsJson(),
        readConsentFlag: async () => true,
      });

      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });

    it('returns empty when the claudeAiOauth block is absent', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => JSON.stringify({ someOtherKey: 'value' }),
        readConsentFlag: async () => true,
      });

      const result = await seeder.seed();
      expect(result.entries).toEqual([]);
    });
  });

  describe('isConsentEstablished', () => {
    it('returns the resolved consent boolean', async () => {
      const yes = new ClaudeCodeSeeder({
        readCredentialFile: () => null,
        readConsentFlag: async () => true,
      });
      const no = new ClaudeCodeSeeder({
        readCredentialFile: () => null,
        readConsentFlag: async () => false,
      });

      await expect(yes.isConsentEstablished('anthropic')).resolves.toBe(true);
      await expect(no.isConsentEstablished('anthropic')).resolves.toBe(false);
    });

    it('returns false when the flag resolver throws', async () => {
      const seeder = new ClaudeCodeSeeder({
        readCredentialFile: () => null,
        readConsentFlag: async () => {
          throw new Error('boom');
        },
      });

      await expect(seeder.isConsentEstablished('anthropic')).resolves.toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe('BUILTIN_SEEDERS auto-registration', () => {
  it('contains exactly one (claude-code, anthropic) seeder', () => {
    const matches = BUILTIN_SEEDERS.getAll().filter(
      (s) => s.sourceId === 'claude-code' && s.provider === 'anthropic',
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toBeInstanceOf(ClaudeCodeSeeder);
  });

  it('exposes the seeder via getByProvider("anthropic")', () => {
    const anthropicSeeders = BUILTIN_SEEDERS.getByProvider('anthropic');
    const claudeCode = anthropicSeeders.find((s) => s.sourceId === 'claude-code');

    expect(claudeCode).toBeDefined();
    expect(claudeCode).toBeInstanceOf(ClaudeCodeSeeder);
  });

  it('does NOT auto-register the seeder under any other provider', () => {
    for (const seeder of BUILTIN_SEEDERS.getAll()) {
      if (seeder instanceof ClaudeCodeSeeder) {
        expect(seeder.provider).toBe('anthropic');
      }
    }
  });

  it('uses the canonical SeederRegistry key encoding', () => {
    // Sanity check — the registry's collision detector relies on the
    // `<sourceId>::<provider>` encoding. If a future task changes the
    // separator, the auto-registration call would still succeed but the
    // duplicate-detection contract documented on `SeederRegistry` would
    // silently weaken. Tests assert the literal encoding here as a guard.
    expect(SeederRegistry.makeKey('claude-code', 'anthropic')).toBe('claude-code::anthropic');
  });
});
