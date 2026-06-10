/**
 * Universal service-vault — declarative service-provider registry (types + DATA).
 *
 * EP-UNIVERSAL-SERVICE-VAULT (epic T11765 · saga SG-VAULT-CORE T10409 · M2 W1a ·
 * task T11937). The **service** half of the universal vault: machine-wide OAuth /
 * API credentials for third-party SERVICES (github, google, notion, figma, …) —
 * distinct from the LLM-provider credential pool (`accounts`, T11709) which holds
 * model-API keys. A {@link ServiceProviderDef} is a purely declarative description
 * of one connectable service: its stable key, display label, auth shape, and the
 * default OAuth endpoints/scopes the (later) OAuth dance (T11939) will drive.
 *
 * ## Why this lives in `@cleocode/contracts` (Gate 10 purity)
 *
 * This module is **types + frozen DATA only**. {@link SERVICE_PROVIDERS} is a
 * `const` record literal (no bodied function, no zod schema, no type guard) — it
 * is configuration data, exactly like a routing table, so it satisfies the
 * contracts-purity gate (`lint-no-runtime-in-contracts`). The runtime that
 * CONSUMES the registry (the store, the trust gate, the OAuth flow) lives in
 * `@cleocode/core`; this file never imports from core and carries no side effects.
 *
 * ## Pattern, not census (T11937 vs T11938)
 *
 * Only **github** and **google** are seeded here, deliberately — they prove the
 * declarative pattern (one PKCE provider with a fixed loopback, one classic
 * web-OAuth provider) before the fan-out to ~40 services in the follow-up
 * (T11938). Adding a service is a single DATA entry; no code change.
 *
 * @module contracts/vault/service-provider
 * @task T11937
 * @epic T11765
 * @saga T10409
 * @see ../llm/oauth.js — `ProviderOAuthConfig` / `OAuthMode` (reused here)
 * @see ../llm/sealed-credential.js — `SealedCredential` (the egress handle a resolved service credential is wrapped in)
 */

import type { ProviderOAuthConfig } from '../llm/oauth.js';

/**
 * Auth shape a service uses to obtain credentials.
 *
 * - `oauth2` — classic OAuth 2.0 Authorization Code grant (e.g. github web flow).
 * - `oauth2-pkce` — OAuth 2.0 Authorization Code + PKCE (RFC 7636), for CLI /
 *   headless flows (e.g. google installed-app flow).
 * - `api-key` — a long-lived API token pasted/imported directly (no OAuth dance).
 *
 * The value drives which fields of {@link ServiceProviderDef.oauth} are required
 * and which OAuth code path (T11939) runs for the service.
 *
 * @task T11937
 */
export const SERVICE_AUTH_KINDS = ['oauth2', 'oauth2-pkce', 'api-key'] as const;

/** TypeScript union derived from {@link SERVICE_AUTH_KINDS}. */
export type ServiceAuthKind = (typeof SERVICE_AUTH_KINDS)[number];

/**
 * Declarative description of one connectable third-party service.
 *
 * A `ServiceProviderDef` is pure configuration: it names a service, describes how
 * it authenticates, and (for OAuth services) carries the default endpoints and
 * scopes the OAuth flow will drive. It holds NO secret material — a user's actual
 * tokens live encrypted in the `service_connections` table; BYOC client secrets
 * (when the user brings their own OAuth app) live encrypted in `service_configs`.
 *
 * @task T11937
 */
export interface ServiceProviderDef {
  /**
   * Stable provider key (lowercase, kebab) — the join key against
   * `service_connections.provider` / `service_configs.provider`. NEVER renamed
   * once shipped (it is persisted in user rows). e.g. `'github'`, `'google'`.
   */
  readonly provider: string;
  /** Human-readable display name for UI / CLI output. e.g. `'GitHub'`. */
  readonly displayName: string;
  /** Auth shape this service uses ({@link ServiceAuthKind}). */
  readonly authKind: ServiceAuthKind;
  /**
   * Default OAuth configuration (endpoints + scopes + the public client id of
   * CLEO's first-party OAuth app). `undefined` for an `api-key`-only service.
   *
   * Reuses the LLM-layer {@link ProviderOAuthConfig} shape verbatim — the OAuth
   * mechanics (PKCE vs classic, endpoints, redirect, extra params) are identical
   * whether the credential is for a model API or a service API. When the user
   * supplies their own client id/secret (BYOC, stored in `service_configs`),
   * those OVERRIDE the `clientId`/`scope` declared here at flow time (T11939).
   */
  readonly oauth?: ProviderOAuthConfig;
  /**
   * Default space-separated scopes requested when CLEO's first-party app is used
   * and `oauth.scope` is not overridden by a BYOC `service_configs.settings`.
   * Mirrors `oauth.scope`; kept as a top-level field so an `api-key` service can
   * still document the access level a token is expected to carry.
   */
  readonly defaultScopes?: string;
  /**
   * One-line description of what connecting this service enables. Surfaced in the
   * connect UI / `cleo service list`. Non-secret.
   */
  readonly description: string;
}

/**
 * The seeded service-provider registry — **github + google only** (T11937).
 *
 * Keyed by {@link ServiceProviderDef.provider}. This is the SSoT the store reads
 * when validating a `connect` and the OAuth flow (T11939) reads for default
 * endpoints/scopes. The two seeds prove the two OAuth shapes:
 *
 *  - **github** — classic OAuth 2.0 web flow (`authKind: 'oauth2'`), fixed
 *    loopback redirect; user grants `repo`/`read:user` scopes.
 *  - **google** — installed-app OAuth 2.0 + PKCE (`authKind: 'oauth2-pkce'`),
 *    loopback redirect; user grants offline-access + the requested API scopes.
 *
 * The `clientId` values are PLACEHOLDER public client ids for CLEO's first-party
 * OAuth apps — the real ids are wired (or BYOC-overridden) when the OAuth dance
 * lands in T11939. They are NOT secrets (a public OAuth client id is, by design,
 * embeddable in a distributed CLI).
 *
 * Fan-out to the full ~40-service census is the follow-up (T11938): add a DATA
 * entry here, nothing else.
 *
 * @task T11937
 */
export const SERVICE_PROVIDERS: Readonly<Record<string, ServiceProviderDef>> = {
  github: {
    provider: 'github',
    displayName: 'GitHub',
    authKind: 'oauth2',
    description: 'Repositories, issues, pull requests, and Actions on GitHub.',
    defaultScopes: 'repo read:user read:org',
    oauth: {
      mode: 'pkce',
      // PLACEHOLDER public client id for CLEO's first-party GitHub OAuth app —
      // real id (or a BYOC override from service_configs) wired in T11939.
      clientId: 'cleo-github-client-id',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      scope: 'repo read:user read:org',
      redirectUri: 'http://127.0.0.1:7878/service/github/callback',
    },
  },
  google: {
    provider: 'google',
    displayName: 'Google',
    authKind: 'oauth2-pkce',
    description: 'Gmail, Drive, Calendar, and other Google APIs.',
    defaultScopes: 'openid email profile https://www.googleapis.com/auth/drive.readonly',
    oauth: {
      mode: 'pkce',
      // PLACEHOLDER public client id for CLEO's first-party Google installed-app
      // OAuth client — real id (or a BYOC override) wired in T11939.
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'openid email profile https://www.googleapis.com/auth/drive.readonly',
      redirectUri: 'http://127.0.0.1:7878/service/google/callback',
      extraAuthParams: {
        // Google requires these to return a refresh token on the first consent.
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  },
};
