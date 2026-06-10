/**
 * T11704 — pure provider-alias resolution over `ProviderDef.aliases`.
 *
 * No DB, no network — `resolveProviderId` is a pure function of `(input, defs)`.
 *
 * @task T11704
 * @epic T11667
 */

import type { ProviderDef } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildAliasIndex, resolveProviderId } from '../provider-registry/provider-alias.js';
import { builtinProviderDefs } from '../provider-registry/provider-defs.js';

describe('resolveProviderId (T11704)', () => {
  it('resolves codex and chatgpt to openai (from the builtin set)', () => {
    expect(resolveProviderId('codex')).toBe('openai');
    expect(resolveProviderId('chatgpt')).toBe('openai');
    expect(resolveProviderId('openai-codex')).toBe('openai');
  });

  it('resolves claude → anthropic and google → gemini', () => {
    expect(resolveProviderId('claude')).toBe('anthropic');
    expect(resolveProviderId('google')).toBe('gemini');
  });

  it('resolves a primary id to itself', () => {
    expect(resolveProviderId('anthropic')).toBe('anthropic');
    expect(resolveProviderId('openai')).toBe('openai');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveProviderId('  CODEX ')).toBe('openai');
    expect(resolveProviderId('Claude')).toBe('anthropic');
  });

  it('returns null for an unknown name', () => {
    expect(resolveProviderId('definitely-not-a-provider')).toBeNull();
    expect(resolveProviderId('')).toBeNull();
  });

  it('is deterministic — same input yields the same output across calls', () => {
    expect(resolveProviderId('codex')).toBe(resolveProviderId('codex'));
  });

  it('accepts a prebuilt index (hot-loop seam)', () => {
    const index = buildAliasIndex(builtinProviderDefs());
    expect(resolveProviderId('codex', index)).toBe('openai');
    expect(resolveProviderId('nope', index)).toBeNull();
  });

  it('throws when an alias collides with another provider primary id', () => {
    const defs: ProviderDef[] = [
      {
        id: 'openai',
        displayName: 'OpenAI',
        aliases: [],
        authMethods: ['api_key'],
        endpoint: { transport: 'openai-completions', baseUrl: 'https://api.openai.com' },
        modelsDevId: 'openai',
      },
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        // 'openai' is openai's PRIMARY id — declaring it as an alias is a collision.
        aliases: ['openai'],
        authMethods: ['api_key'],
        endpoint: { transport: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
        modelsDevId: 'anthropic',
      },
    ];
    expect(() => buildAliasIndex(defs)).toThrow(/collides/);
  });

  it('throws when two providers declare the same alias (ambiguous)', () => {
    const defs: ProviderDef[] = [
      {
        id: 'p1',
        displayName: 'P1',
        aliases: ['shared'],
        authMethods: ['api_key'],
        endpoint: { transport: 'openai-completions', baseUrl: 'https://p1.example' },
        modelsDevId: 'p1',
      },
      {
        id: 'p2',
        displayName: 'P2',
        aliases: ['shared'],
        authMethods: ['api_key'],
        endpoint: { transport: 'openai-completions', baseUrl: 'https://p2.example' },
        modelsDevId: 'p2',
      },
    ];
    expect(() => buildAliasIndex(defs)).toThrow(/ambiguous/);
  });
});

describe('builtinProviderDefs derivation (T11703)', () => {
  it('derives one ProviderDef per provider id (xai collapsed to one row)', () => {
    const defs = builtinProviderDefs();
    const ids = defs.map((d) => d.id);
    // No duplicate ids — the xai completions + responses profiles collapse to one.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('xai');
    expect(ids.filter((id) => id === 'xai')).toHaveLength(1);
  });

  it('folds the xai Responses endpoint into the single xai row altEndpoints (AC4)', () => {
    const xai = builtinProviderDefs().find((d) => d.id === 'xai');
    expect(xai).toBeDefined();
    expect(xai?.endpoint.transport).toBe('openai-completions');
    expect(xai?.altEndpoints?.some((e) => e.transport === 'openai-responses')).toBe(true);
  });

  it('maps anthropic + kimi-code to the anthropic-messages transport', () => {
    const defs = builtinProviderDefs();
    expect(defs.find((d) => d.id === 'anthropic')?.endpoint.transport).toBe('anthropic-messages');
    expect(defs.find((d) => d.id === 'kimi-code')?.endpoint.transport).toBe('anthropic-messages');
  });

  it('maps kimi-code to its moonshot models.dev catalog key', () => {
    expect(builtinProviderDefs().find((d) => d.id === 'kimi-code')?.modelsDevId).toBe('moonshot');
  });

  it('carries the OAuth flow placeholder for anthropic + openai', () => {
    const defs = builtinProviderDefs();
    expect(defs.find((d) => d.id === 'anthropic')?.oauth?.mode).toBe('pkce');
    expect(defs.find((d) => d.id === 'openai')?.oauth?.mode).toBe('pkce');
  });
});
