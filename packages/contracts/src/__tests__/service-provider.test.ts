/**
 * T11937 seed + T11938 BREADTH — service-provider registry contract.
 *
 * Asserts the declarative `SERVICE_PROVIDERS` registry: the two pattern seeds
 * (github + google) keep their precise shape (T11937), and the full ~40-service
 * census (T11938) is well-formed — every entry self-consistent on its key, every
 * provider carrying a NON-EMPTY `hostRules` array, and every OAuth (non-`api-key`)
 * provider carrying either a `refresh` config or an explicit re-auth shape. The
 * registry is DATA (no runtime helper) — this test is the only consumer that
 * exercises its shape.
 *
 * @task T11937
 * @task T11938
 * @epic T11765
 */

import { describe, expect, it } from 'vitest';
import {
  REFRESH_KINDS,
  SERVICE_AUTH_KINDS,
  SERVICE_PROVIDERS,
  type ServiceProviderDef,
} from '../vault/service-provider.js';

describe('SERVICE_PROVIDERS registry (T11937 seed + T11938 breadth)', () => {
  it('contains the full ~40-service census (≥ 38 providers, T11938 AC1)', () => {
    // 2 seeds (github, google) + ~37 breadth entries = ~40 declarative providers.
    expect(Object.keys(SERVICE_PROVIDERS).length).toBeGreaterThanOrEqual(38);
  });

  it('includes a representative spread across provider families', () => {
    const keys = Object.keys(SERVICE_PROVIDERS);
    // Seeds + Google family + Atlassian + api-key + JWT/client-credentials.
    for (const expected of [
      'github',
      'google',
      'gmail',
      'notion',
      'dropbox',
      'jira',
      'confluence',
      'supabase',
      'todoist',
      'resend',
      'cloudflare',
      'github-app',
      'mongodb-atlas',
      'vertex-ai',
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it('each entry is well-formed and self-consistent on its key', () => {
    for (const [key, def] of Object.entries(SERVICE_PROVIDERS) as Array<
      [string, ServiceProviderDef]
    >) {
      expect(def.provider).toBe(key);
      expect(def.displayName.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(SERVICE_AUTH_KINDS).toContain(def.authKind);
    }
  });

  it('every provider declares a NON-EMPTY hostRules array (T11938 AC4)', () => {
    for (const [key, def] of Object.entries(SERVICE_PROVIDERS) as Array<
      [string, ServiceProviderDef]
    >) {
      expect(Array.isArray(def.hostRules), `${key} must declare hostRules`).toBe(true);
      expect(def.hostRules.length, `${key} hostRules must be non-empty`).toBeGreaterThan(0);
      for (const rule of def.hostRules) {
        expect(rule.host.length).toBeGreaterThan(0);
        expect(['bearer', 'basic-x-access-token', 'header']).toContain(rule.strategy);
      }
    }
  });

  it('every OAuth (non api-key) provider declares a refresh config OR an oauth re-auth shape (T11938 AC4)', () => {
    for (const [key, def] of Object.entries(SERVICE_PROVIDERS) as Array<
      [string, ServiceProviderDef]
    >) {
      if (def.authKind === 'api-key') {
        // api-key services have no token to refresh — refresh MUST be absent.
        expect(def.refresh, `${key} (api-key) must not declare refresh`).toBeUndefined();
        continue;
      }
      // An OAuth provider must be refreshable OR at least carry a full oauth
      // block the flow can re-authorize against.
      const hasRefresh = def.refresh !== undefined;
      const hasOAuth = def.oauth !== undefined;
      expect(hasRefresh || hasOAuth, `${key} must declare refresh or oauth`).toBe(true);
      if (hasRefresh && def.refresh) {
        expect(REFRESH_KINDS).toContain(def.refresh.kind);
        expect(def.refresh.tokenUrl.length).toBeGreaterThan(0);
      }
    }
  });

  it('declares the three special-case refresh-kind discriminants (T11938 AC3)', () => {
    const kinds = new Set(
      Object.values(SERVICE_PROVIDERS)
        .map((d) => d.refresh?.kind)
        .filter((k): k is NonNullable<typeof k> => k !== undefined),
    );
    expect(kinds.has('github-app')).toBe(true);
    expect(kinds.has('client-credentials')).toBe(true);
    expect(kinds.has('refresh-token')).toBe(true);
  });

  it('github is a classic OAuth2 web flow with complete endpoints (T11937)', () => {
    const gh = SERVICE_PROVIDERS['github'];
    expect(gh).toBeDefined();
    expect(gh?.authKind).toBe('oauth2');
    expect(gh?.oauth?.authorizationEndpoint).toContain('github.com');
    expect(gh?.oauth?.tokenEndpoint).toContain('github.com');
    expect(gh?.oauth?.clientId.length).toBeGreaterThan(0);
    expect(gh?.defaultScopes).toContain('repo');
  });

  it('google is an installed-app OAuth2 + PKCE flow that requests offline access (T11937)', () => {
    const g = SERVICE_PROVIDERS['google'];
    expect(g).toBeDefined();
    expect(g?.authKind).toBe('oauth2-pkce');
    expect(g?.oauth?.authorizationEndpoint).toContain('accounts.google.com');
    expect(g?.oauth?.tokenEndpoint).toContain('oauth2.googleapis.com');
    // Google needs access_type=offline + prompt=consent to issue a refresh token.
    expect(g?.oauth?.extraAuthParams?.['access_type']).toBe('offline');
  });
});
