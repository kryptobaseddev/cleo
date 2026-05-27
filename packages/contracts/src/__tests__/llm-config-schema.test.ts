/**
 * Schema roundtrip tests for the extended `LlmConfig` shape.
 *
 * Asserts that:
 *
 * 1. A literal `LlmConfig` object containing the `default` and `roles` fields
 *    typechecks and survives a JSON serialize/deserialize cycle without
 *    structural loss.
 * 2. All five `RoleName` values (`extraction`, `consolidation`, `derivation`,
 *    `hygiene`, `judgement`) are accepted as keys of `roles`.
 * 3. Omitting `default` and/or `roles` still typechecks (both are optional).
 *
 * These tests guard the Phase 4 schema cleanup of T-LLM-CRED-CENTRALIZATION
 * (T9306 — daemon field removed) against accidental regressions.
 *
 * @task T9306
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, it } from 'vitest';
import type { LlmConfig, LlmDefaultConfig, LlmRoleConfig, RoleName } from '../config.js';

describe('LlmConfig — Phase 4 schema cleanup (T9306)', () => {
  it('accepts a fully-populated config with default and roles', () => {
    const cfg: LlmConfig = {
      providers: {
        anthropic: { apiKey: 'sk-test-anthropic' },
        openai: { apiKey: 'sk-test-openai' },
      },
      default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      roles: {
        extraction: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          credentialLabel: 'ext-key',
        },
        consolidation: {
          provider: 'openai',
          model: 'gpt-4o',
        },
        derivation: {
          provider: 'gemini',
          model: 'gemini-2.5-pro',
        },
        hygiene: {
          provider: 'moonshot',
          model: 'kimi-k2',
        },
        judgement: {
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          credentialLabel: 'judge-key',
        },
      },
    };

    const roundtripped: LlmConfig = JSON.parse(JSON.stringify(cfg));
    expect(roundtripped).toEqual(cfg);
  });

  it('preserves structural identity across JSON serialize/deserialize', () => {
    const cfg: LlmConfig = {
      default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      roles: {
        extraction: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      },
    };

    const serialized = JSON.stringify(cfg);
    const parsed = JSON.parse(serialized) as LlmConfig;

    expect(parsed.default).toEqual(cfg.default);
    expect(parsed.roles).toEqual(cfg.roles);
    expect(parsed.roles?.extraction?.provider).toBe('anthropic');
    expect(parsed.roles?.extraction?.model).toBe('claude-haiku-4-5');
  });

  it('accepts all five RoleName values as keys of roles', () => {
    const roleNames: readonly RoleName[] = [
      'extraction',
      'consolidation',
      'derivation',
      'hygiene',
      'judgement',
    ] as const;

    // Build a `roles` map populated with one entry per role name. The TS
    // compiler enforces that only valid `RoleName` keys appear here — any
    // typo would be a compile-time error.
    const roles: Partial<Record<RoleName, LlmRoleConfig>> = {};
    for (const name of roleNames) {
      roles[name] = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    }

    const cfg: LlmConfig = { roles };
    expect(Object.keys(cfg.roles ?? {})).toHaveLength(5);
    for (const name of roleNames) {
      expect(cfg.roles?.[name]?.provider).toBe('anthropic');
      expect(cfg.roles?.[name]?.model).toBe('claude-sonnet-4-6');
    }
  });

  it('typechecks when default and roles are both omitted', () => {
    const cfg: LlmConfig = {};

    expect(cfg.default).toBeUndefined();
    expect(cfg.roles).toBeUndefined();
  });

  it('typechecks an empty LlmConfig (all fields optional)', () => {
    const cfg: LlmConfig = {};
    expect(cfg).toEqual({});
  });

  it('allows a role entry without an optional credentialLabel', () => {
    const role: LlmRoleConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    expect(role.credentialLabel).toBeUndefined();
  });

  it('allows LlmDefaultConfig with only provider + model (no credential)', () => {
    const def: LlmDefaultConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    };
    expect(def.provider).toBe('anthropic');
    expect(def.model).toBe('claude-sonnet-4-6');
  });
});
