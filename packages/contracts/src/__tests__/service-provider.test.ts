/**
 * T11937 — service-provider registry seed contract (AC5).
 *
 * Asserts the declarative `SERVICE_PROVIDERS` registry seeds EXACTLY the two
 * pattern providers (github + google), each well-formed: a stable key, a display
 * name, a valid auth kind, and (for OAuth services) a complete `oauth` config.
 * The registry is DATA (no runtime helper) — this test is the only consumer that
 * exercises its shape.
 *
 * @task T11937
 * @epic T11765
 */

import { describe, expect, it } from 'vitest';
import {
  SERVICE_AUTH_KINDS,
  SERVICE_PROVIDERS,
  type ServiceProviderDef,
} from '../vault/service-provider.js';

describe('SERVICE_PROVIDERS registry seed (T11937)', () => {
  it('seeds EXACTLY github + google (pattern, not census)', () => {
    expect(Object.keys(SERVICE_PROVIDERS).sort()).toEqual(['github', 'google']);
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

  it('github is a classic OAuth2 web flow with complete endpoints', () => {
    const gh = SERVICE_PROVIDERS['github'];
    expect(gh).toBeDefined();
    expect(gh?.authKind).toBe('oauth2');
    expect(gh?.oauth?.authorizationEndpoint).toContain('github.com');
    expect(gh?.oauth?.tokenEndpoint).toContain('github.com');
    expect(gh?.oauth?.clientId.length).toBeGreaterThan(0);
    expect(gh?.defaultScopes).toContain('repo');
  });

  it('google is an installed-app OAuth2 + PKCE flow that requests offline access', () => {
    const g = SERVICE_PROVIDERS['google'];
    expect(g).toBeDefined();
    expect(g?.authKind).toBe('oauth2-pkce');
    expect(g?.oauth?.authorizationEndpoint).toContain('accounts.google.com');
    expect(g?.oauth?.tokenEndpoint).toContain('oauth2.googleapis.com');
    // Google needs access_type=offline + prompt=consent to issue a refresh token.
    expect(g?.oauth?.extraAuthParams?.['access_type']).toBe('offline');
  });
});
