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

// ---------------------------------------------------------------------------
// Refresh configuration (T11938 BREADTH · T11939 W2 — driven by this DATA)
// ---------------------------------------------------------------------------

/**
 * Discriminant naming the refresh GRANT a provider uses (T11938 AC3).
 *
 * The OAuth flow (T11939) branches on this value to pick the refresh code path:
 *
 *  - `refresh-token` — the standard OAuth 2.0 `grant_type=refresh_token` exchange
 *    (RFC 6749 §6), shaped by {@link RefreshConfig.bodyFormat} /
 *    {@link RefreshConfig.clientAuth}. The common case (google, atlassian, …).
 *  - `github-app` — a GitHub App installation token: sign an RS256 JWT with the
 *    app private key, then POST `/app/installations/{id}/access_tokens`.
 *  - `service-account-jwt` — a Google service-account: sign an RS256 JWT and
 *    exchange it via `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
 *  - `client-credentials` — the OAuth 2.0 `grant_type=client_credentials` grant
 *    (RFC 6749 §4.4), Basic-auth client id/secret (e.g. MongoDB Atlas SAs).
 *
 * @task T11938
 */
export const REFRESH_KINDS = [
  'refresh-token',
  'github-app',
  'service-account-jwt',
  'client-credentials',
] as const;

/** TypeScript union derived from {@link REFRESH_KINDS}. */
export type RefreshKind = (typeof REFRESH_KINDS)[number];

/**
 * Body encoding for a `refresh-token` token-endpoint POST.
 *
 * - `form` — `application/x-www-form-urlencoded` (OAuth 2.0 default; google).
 * - `json` — `application/json` (required by Atlassian / Notion).
 *
 * @task T11938
 */
export type RefreshBodyFormat = 'form' | 'json';

/**
 * How the OAuth client credentials are presented on a `refresh-token` POST.
 *
 * - `body` — `client_id` + `client_secret` carried IN the request body (default).
 * - `basic-auth` — `Authorization: Basic base64(client_id:client_secret)` header
 *   (Notion, Supabase).
 *
 * @task T11938
 */
export type RefreshClientAuth = 'body' | 'basic-auth';

/**
 * Declarative refresh configuration for a `refresh-token` provider (T11938 AC1).
 *
 * Pure data: the token endpoint, the body encoding, and how the client
 * credentials are presented. The OAuth flow (T11939) reads this to drive the
 * `grant_type=refresh_token` exchange WITHOUT any per-provider code. The
 * `kind` discriminant selects the broader grant (the three special variants
 * — github-app / service-account-jwt / client-credentials — set `kind` and
 * leave `bodyFormat`/`clientAuth` at their `form`/`body` defaults; their grant
 * mechanics are not refresh-token-shaped).
 *
 * Cannibalized from onecli `apps.rs::RefreshConfig` (DATA only — the Rust
 * `reqwest`/env-var resolution is re-implemented in TS in T11939).
 *
 * @task T11938
 */
export interface RefreshConfig {
  /** Which refresh GRANT this provider uses ({@link RefreshKind}). */
  readonly kind: RefreshKind;
  /**
   * Token endpoint the refresh exchange POSTs to. For `refresh-token` /
   * `client-credentials`; the JWT variants use a fixed provider endpoint and may
   * leave this as the canonical value for documentation.
   */
  readonly tokenUrl: string;
  /** Body encoding for a `refresh-token` exchange. Defaults to `form`. */
  readonly bodyFormat?: RefreshBodyFormat;
  /** Client-credential presentation for a `refresh-token` exchange. Defaults to `body`. */
  readonly clientAuth?: RefreshClientAuth;
}

// ---------------------------------------------------------------------------
// Host rules + header injection (T11938 BREADTH — declarative reach metadata)
// ---------------------------------------------------------------------------

/**
 * Auth strategy a host rule applies when a resolved credential is injected into
 * an outbound request to a matched host.
 *
 * - `bearer` — `Authorization: Bearer <token>` (the OAuth default).
 * - `basic-x-access-token` — `Authorization: Basic base64("x-access-token:<token>")`
 *   (GitHub git-over-HTTPS).
 * - `header` — the token is injected via a named header rather than `Authorization`
 *   (paired with {@link ServiceProviderDef.credentialHeaders}).
 *
 * Declarative only in this milestone — the injecting proxy is a later epic.
 *
 * @task T11938
 */
export type HostAuthStrategy = 'bearer' | 'basic-x-access-token' | 'header';

/**
 * One host-match rule declaring which upstream hosts a provider's credential is
 * valid for and how it is injected (T11938 AC1/AC4 — every provider declares a
 * non-empty {@link ServiceProviderDef.hostRules}).
 *
 * `host` is matched EXACTLY (no wildcards in this milestone). `pathPrefix`, when
 * set, narrows the rule to requests under that path (e.g. the legacy
 * `www.googleapis.com/gmail/` endpoint). Cannibalized from onecli
 * `apps.rs::HostRule` (DATA only).
 *
 * @task T11938
 */
export interface ServiceHostRule {
  /** Exact upstream host this rule matches (e.g. `'api.github.com'`). */
  readonly host: string;
  /** Optional path prefix narrowing the rule (e.g. `'/gmail/'`). */
  readonly pathPrefix?: string;
  /** How the credential is injected for a matched request. */
  readonly strategy: HostAuthStrategy;
}

/**
 * One declarative injection action applied to an outbound request when a resolved
 * service credential is injected at the harness tool boundary (T11940 · M2-W3).
 *
 * A discriminated union over the action `kind`. The injector
 * ({@link import('@cleocode/core').injectServiceCredentials}) materializes the
 * sealed credential's plaintext ONLY at the wire (inside the action's value
 * resolver) and applies these mutations to a request descriptor — there is NO MITM
 * proxy (the seam is the in-process tool boundary, T11940 AC4):
 *
 *  - `set-header` — set `name` to the materialized value (overwriting any existing).
 *  - `replace-header` — set `name` to the value ONLY if the header is already
 *    present (a no-op when absent — used to swap a placeholder the tool emitted).
 *  - `remove-header` — delete `name` (e.g. strip a stale `Authorization` before
 *    re-injecting the vault credential).
 *  - `set-param` — set the query-string parameter `name` to the materialized value.
 *
 * The `valueSource` discriminates WHERE the injected value comes from:
 * `'token'` (the decrypted access token), `'credential-field'` (a named field of
 * the credential blob, e.g. an AWS access-key id), or `'metadata'` (a non-secret
 * connection-metadata key, e.g. a Google project id). `remove-header` carries no
 * `valueSource` (it injects nothing).
 *
 * @task T11940
 */
export type InjectionRule =
  | {
      /** Set a header to the injected value (overwrites any existing). */
      readonly kind: 'set-header';
      /** The header name to set. */
      readonly name: string;
      /** Where the injected value comes from. */
      readonly valueSource: InjectionValueSource;
      /** For `bearer`/`basic-x-access-token` token framing — how to wrap the value. */
      readonly framing?: HostAuthStrategy;
    }
  | {
      /** Set a header ONLY when it is already present (swap a placeholder). */
      readonly kind: 'replace-header';
      /** The header name to replace. */
      readonly name: string;
      /** Where the injected value comes from. */
      readonly valueSource: InjectionValueSource;
      /** For `bearer`/`basic-x-access-token` token framing — how to wrap the value. */
      readonly framing?: HostAuthStrategy;
    }
  | {
      /** Remove a header (injects no value). */
      readonly kind: 'remove-header';
      /** The header name to remove. */
      readonly name: string;
    }
  | {
      /** Set a query-string parameter to the injected value. */
      readonly kind: 'set-param';
      /** The query-parameter name to set. */
      readonly name: string;
      /** Where the injected value comes from. */
      readonly valueSource: InjectionValueSource;
    };

/**
 * Where an {@link InjectionRule}'s injected value is sourced from.
 *
 *  - `token` — the decrypted access token (the secret materialized at the wire).
 *  - `credential-field` — a named field of the credential blob (paired with the
 *    rule's `name` resolution via {@link ServiceProviderDef.credentialHeaders}).
 *  - `metadata` — a non-secret connection-metadata key.
 *
 * @task T11940
 */
export type InjectionValueSource = 'token' | 'credential-field' | 'metadata';

/**
 * Inject an HTTP header from a credential-blob field (e.g. a regional API key →
 * `DD-API-KEY`). Declarative metadata; the injecting proxy is a later epic.
 *
 * @task T11938
 */
export interface CredentialHeaderRule {
  /** The credential-blob field whose value is injected. */
  readonly credentialField: string;
  /** The HTTP header the value is injected as. */
  readonly headerName: string;
}

/**
 * Inject an HTTP header from a connection-metadata key (e.g. a project id →
 * `x-goog-user-project`). Declarative metadata; the injecting proxy is a later
 * epic.
 *
 * @task T11938
 */
export interface MetadataHeaderRule {
  /** The non-secret metadata key whose value is injected. */
  readonly metadataKey: string;
  /** The HTTP header the value is injected as. */
  readonly headerName: string;
}

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
  /**
   * Non-empty list of host-match rules (T11938 AC1/AC4) declaring which upstream
   * hosts this provider's resolved credential is valid for and how it is injected
   * ({@link ServiceHostRule}). The registry-completeness test asserts EVERY
   * provider carries at least one rule. Cannibalized from onecli
   * `apps.rs::AppProvider.host_rules` (DATA only).
   */
  readonly hostRules: readonly ServiceHostRule[];
  /**
   * Refresh configuration (T11938 AC1/AC3). Present for every `oauth2` /
   * `oauth2-pkce` provider that can refresh; `undefined` for an `api-key` service
   * (no token to refresh) or an OAuth service that only re-authorizes. The OAuth
   * flow (T11939) reads {@link RefreshConfig.kind} to pick the refresh grant.
   */
  readonly refresh?: RefreshConfig;
  /**
   * Optional header-injection rules sourced from the credential blob (T11938 AC1).
   * Declarative reach metadata; the injecting proxy is a later epic.
   */
  readonly credentialHeaders?: readonly CredentialHeaderRule[];
  /**
   * Optional header-injection rules sourced from connection metadata (T11938 AC1).
   * Declarative reach metadata; the injecting proxy is a later epic.
   */
  readonly metadataHeaders?: readonly MetadataHeaderRule[];
}

// ---------------------------------------------------------------------------
// Shared refresh configs (T11938) — frozen DATA reused across provider families.
// Mirror onecli `apps.rs` statics (GOOGLE_REFRESH, ATLASSIAN_REFRESH, …). These
// are `const` object literals (no runtime helper) so contracts-purity (Gate 10)
// stays green.
// ---------------------------------------------------------------------------

/** Shared refresh config for every Google OAuth API (form body, client-id/secret in body). */
const GOOGLE_REFRESH: RefreshConfig = {
  kind: 'refresh-token',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  bodyFormat: 'form',
  clientAuth: 'body',
};

/** Shared refresh config for the Atlassian OAuth APIs (Jira, Confluence) — JSON body. */
const ATLASSIAN_REFRESH: RefreshConfig = {
  kind: 'refresh-token',
  tokenUrl: 'https://auth.atlassian.com/oauth/token',
  bodyFormat: 'json',
  clientAuth: 'body',
};

/**
 * The full service-provider census — **~40 declarative entries** (T11938 BREADTH).
 *
 * Spread into {@link SERVICE_PROVIDERS} after the github/google seeds. Each entry
 * is PURE DATA cannibalized from onecli `apps.rs::APP_PROVIDERS` (host rules,
 * refresh shape, display name) — no code, no runtime helper. Three special-case
 * refresh GRANTS are declared as {@link RefreshKind} discriminants (T11938 AC3):
 * `github-app` (GitHub App), `client-credentials` (MongoDB Atlas SAs). The OAuth
 * flow (T11939) branches on `refresh.kind` to drive the right grant.
 *
 * Default OAuth `clientId`s are PLACEHOLDER public client ids (BYOC-overridden at
 * flow time from `service_configs`); they are not secrets.
 *
 * @task T11938
 */
const SERVICE_PROVIDERS_BREADTH: Readonly<Record<string, ServiceProviderDef>> = {
  // ── GitHub App (installation token via signed RS256 JWT — special refresh) ──
  'github-app': {
    provider: 'github-app',
    displayName: 'GitHub App',
    authKind: 'oauth2',
    description: 'GitHub App installation access — short-lived installation tokens.',
    defaultScopes: '',
    refresh: {
      kind: 'github-app',
      tokenUrl: 'https://api.github.com/app/installations',
    },
    hostRules: [
      { host: 'api.github.com', strategy: 'bearer' },
      { host: 'github.com', strategy: 'basic-x-access-token' },
      { host: 'raw.githubusercontent.com', strategy: 'bearer' },
    ],
  },
  // ── Google API family (all share GOOGLE_REFRESH + the google PKCE oauth) ──
  gmail: {
    provider: 'gmail',
    displayName: 'Gmail',
    authKind: 'oauth2-pkce',
    description: 'Read, search, and send mail via the Gmail API.',
    defaultScopes: 'https://www.googleapis.com/auth/gmail.modify',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      redirectUri: 'http://127.0.0.1:7878/service/gmail/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [
      { host: 'gmail.googleapis.com', strategy: 'bearer' },
      { host: 'www.googleapis.com', pathPrefix: '/gmail/', strategy: 'bearer' },
    ],
  },
  'google-calendar': {
    provider: 'google-calendar',
    displayName: 'Google Calendar',
    authKind: 'oauth2-pkce',
    description: 'Manage calendars and events via the Google Calendar API.',
    defaultScopes: 'https://www.googleapis.com/auth/calendar',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/calendar',
      redirectUri: 'http://127.0.0.1:7878/service/google-calendar/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'www.googleapis.com', pathPrefix: '/calendar/', strategy: 'bearer' }],
  },
  'google-drive': {
    provider: 'google-drive',
    displayName: 'Google Drive',
    authKind: 'oauth2-pkce',
    description: 'List, read, and write files via the Google Drive API.',
    defaultScopes: 'https://www.googleapis.com/auth/drive',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/drive',
      redirectUri: 'http://127.0.0.1:7878/service/google-drive/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [
      { host: 'www.googleapis.com', pathPrefix: '/drive/', strategy: 'bearer' },
      { host: 'www.googleapis.com', pathPrefix: '/upload/drive/', strategy: 'bearer' },
    ],
  },
  'google-docs': {
    provider: 'google-docs',
    displayName: 'Google Docs',
    authKind: 'oauth2-pkce',
    description: 'Read and edit documents via the Google Docs API.',
    defaultScopes: 'https://www.googleapis.com/auth/documents',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/documents',
      redirectUri: 'http://127.0.0.1:7878/service/google-docs/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'docs.googleapis.com', strategy: 'bearer' }],
  },
  'google-sheets': {
    provider: 'google-sheets',
    displayName: 'Google Sheets',
    authKind: 'oauth2-pkce',
    description: 'Read and write spreadsheets via the Google Sheets API.',
    defaultScopes: 'https://www.googleapis.com/auth/spreadsheets',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      redirectUri: 'http://127.0.0.1:7878/service/google-sheets/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'sheets.googleapis.com', strategy: 'bearer' }],
  },
  'google-slides': {
    provider: 'google-slides',
    displayName: 'Google Slides',
    authKind: 'oauth2-pkce',
    description: 'Read and edit presentations via the Google Slides API.',
    defaultScopes: 'https://www.googleapis.com/auth/presentations',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/presentations',
      redirectUri: 'http://127.0.0.1:7878/service/google-slides/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'slides.googleapis.com', strategy: 'bearer' }],
  },
  'google-tasks': {
    provider: 'google-tasks',
    displayName: 'Google Tasks',
    authKind: 'oauth2-pkce',
    description: 'Manage task lists via the Google Tasks API.',
    defaultScopes: 'https://www.googleapis.com/auth/tasks',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/tasks',
      redirectUri: 'http://127.0.0.1:7878/service/google-tasks/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'tasks.googleapis.com', strategy: 'bearer' }],
  },
  'google-forms': {
    provider: 'google-forms',
    displayName: 'Google Forms',
    authKind: 'oauth2-pkce',
    description: 'Read forms and responses via the Google Forms API.',
    defaultScopes: 'https://www.googleapis.com/auth/forms.body',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/forms.body',
      redirectUri: 'http://127.0.0.1:7878/service/google-forms/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'forms.googleapis.com', strategy: 'bearer' }],
  },
  'google-classroom': {
    provider: 'google-classroom',
    displayName: 'Google Classroom',
    authKind: 'oauth2-pkce',
    description: 'Manage courses and coursework via the Google Classroom API.',
    defaultScopes: 'https://www.googleapis.com/auth/classroom.courses',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/classroom.courses',
      redirectUri: 'http://127.0.0.1:7878/service/google-classroom/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'classroom.googleapis.com', strategy: 'bearer' }],
  },
  'google-admin': {
    provider: 'google-admin',
    displayName: 'Google Admin',
    authKind: 'oauth2-pkce',
    description: 'Directory and admin operations via the Google Admin SDK.',
    defaultScopes: 'https://www.googleapis.com/auth/admin.directory.user',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/admin.directory.user',
      redirectUri: 'http://127.0.0.1:7878/service/google-admin/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'admin.googleapis.com', strategy: 'bearer' }],
  },
  'google-analytics': {
    provider: 'google-analytics',
    displayName: 'Google Analytics',
    authKind: 'oauth2-pkce',
    description: 'Query reports via the Google Analytics Data API.',
    defaultScopes: 'https://www.googleapis.com/auth/analytics.readonly',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      redirectUri: 'http://127.0.0.1:7878/service/google-analytics/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'analyticsdata.googleapis.com', strategy: 'bearer' }],
  },
  'google-search-console': {
    provider: 'google-search-console',
    displayName: 'Google Search Console',
    authKind: 'oauth2-pkce',
    description: 'Query search analytics via the Google Search Console API.',
    defaultScopes: 'https://www.googleapis.com/auth/webmasters.readonly',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      redirectUri: 'http://127.0.0.1:7878/service/google-search-console/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [
      { host: 'searchconsole.googleapis.com', strategy: 'bearer' },
      { host: 'www.googleapis.com', pathPrefix: '/webmasters/', strategy: 'bearer' },
    ],
  },
  'google-meet': {
    provider: 'google-meet',
    displayName: 'Google Meet',
    authKind: 'oauth2-pkce',
    description: 'Manage meeting spaces and conference records via the Google Meet API.',
    defaultScopes: 'https://www.googleapis.com/auth/meetings.space.created',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/meetings.space.created',
      redirectUri: 'http://127.0.0.1:7878/service/google-meet/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'meet.googleapis.com', strategy: 'bearer' }],
  },
  'google-photos': {
    provider: 'google-photos',
    displayName: 'Google Photos',
    authKind: 'oauth2-pkce',
    description: 'Read media items and albums via the Google Photos Library API.',
    defaultScopes: 'https://www.googleapis.com/auth/photoslibrary.readonly',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/photoslibrary.readonly',
      redirectUri: 'http://127.0.0.1:7878/service/google-photos/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'photoslibrary.googleapis.com', strategy: 'bearer' }],
  },
  youtube: {
    provider: 'youtube',
    displayName: 'YouTube',
    authKind: 'oauth2-pkce',
    description: 'Manage channels, videos, and playlists via the YouTube Data API.',
    defaultScopes: 'https://www.googleapis.com/auth/youtube',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/youtube',
      redirectUri: 'http://127.0.0.1:7878/service/youtube/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [{ host: 'www.googleapis.com', pathPrefix: '/youtube/', strategy: 'bearer' }],
  },
  'vertex-ai': {
    provider: 'vertex-ai',
    displayName: 'Vertex AI',
    authKind: 'oauth2-pkce',
    description: 'Call Google Cloud Vertex AI model endpoints.',
    defaultScopes: 'https://www.googleapis.com/auth/cloud-platform',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-google-client-id.apps.googleusercontent.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      redirectUri: 'http://127.0.0.1:7878/service/vertex-ai/callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    refresh: GOOGLE_REFRESH,
    hostRules: [
      { host: 'aiplatform.googleapis.com', strategy: 'bearer' },
      { host: 'oauth2.googleapis.com', strategy: 'bearer' },
    ],
    metadataHeaders: [{ metadataKey: 'projectId', headerName: 'x-goog-user-project' }],
  },
  // ── Atlassian family (JSON refresh body) ──
  jira: {
    provider: 'jira',
    displayName: 'Jira',
    authKind: 'oauth2',
    description: 'Issues, projects, and workflows via the Jira Cloud REST API.',
    defaultScopes: 'read:jira-work write:jira-work offline_access',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-atlassian-client-id',
      authorizationEndpoint: 'https://auth.atlassian.com/authorize',
      tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
      scope: 'read:jira-work write:jira-work offline_access',
      redirectUri: 'http://127.0.0.1:7878/service/jira/callback',
      extraAuthParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    },
    refresh: ATLASSIAN_REFRESH,
    hostRules: [{ host: 'api.atlassian.com', strategy: 'bearer' }],
  },
  confluence: {
    provider: 'confluence',
    displayName: 'Confluence',
    authKind: 'oauth2',
    description: 'Spaces, pages, and content via the Confluence Cloud REST API.',
    defaultScopes: 'read:confluence-content.all write:confluence-content offline_access',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-atlassian-client-id',
      authorizationEndpoint: 'https://auth.atlassian.com/authorize',
      tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
      scope: 'read:confluence-content.all write:confluence-content offline_access',
      redirectUri: 'http://127.0.0.1:7878/service/confluence/callback',
      extraAuthParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    },
    refresh: ATLASSIAN_REFRESH,
    hostRules: [{ host: 'api.atlassian.com', strategy: 'bearer' }],
  },
  // ── Notion (JSON body + Basic-auth client credentials) ──
  notion: {
    provider: 'notion',
    displayName: 'Notion',
    authKind: 'oauth2',
    description: 'Databases, pages, and blocks via the Notion API.',
    defaultScopes: '',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-notion-client-id',
      authorizationEndpoint: 'https://api.notion.com/v1/oauth/authorize',
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
      scope: '',
      redirectUri: 'http://127.0.0.1:7878/service/notion/callback',
      extraAuthParams: { owner: 'user' },
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      bodyFormat: 'json',
      clientAuth: 'basic-auth',
    },
    hostRules: [{ host: 'api.notion.com', strategy: 'bearer' }],
  },
  // ── Dropbox (form body) ──
  dropbox: {
    provider: 'dropbox',
    displayName: 'Dropbox',
    authKind: 'oauth2',
    description: 'Files, folders, and sharing via the Dropbox API.',
    defaultScopes: 'files.content.read files.content.write account_info.read',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-dropbox-client-id',
      authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
      tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
      scope: 'files.content.read files.content.write account_info.read',
      redirectUri: 'http://127.0.0.1:7878/service/dropbox/callback',
      extraAuthParams: { token_access_type: 'offline' },
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [
      { host: 'api.dropboxapi.com', strategy: 'bearer' },
      { host: 'content.dropboxapi.com', strategy: 'bearer' },
    ],
  },
  // ── LinkedIn (form body) ──
  linkedin: {
    provider: 'linkedin',
    displayName: 'LinkedIn',
    authKind: 'oauth2',
    description: 'Profile, posts, and shares via the LinkedIn API.',
    defaultScopes: 'r_liteprofile r_emailaddress w_member_social',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-linkedin-client-id',
      authorizationEndpoint: 'https://www.linkedin.com/oauth/v2/authorization',
      tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken',
      scope: 'r_liteprofile r_emailaddress w_member_social',
      redirectUri: 'http://127.0.0.1:7878/service/linkedin/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [{ host: 'api.linkedin.com', strategy: 'bearer' }],
  },
  // ── Todoist (form body) ──
  todoist: {
    provider: 'todoist',
    displayName: 'Todoist',
    authKind: 'oauth2',
    description: 'Tasks, projects, and labels via the Todoist REST API.',
    defaultScopes: 'data:read_write',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-todoist-client-id',
      authorizationEndpoint: 'https://todoist.com/oauth/authorize',
      tokenEndpoint: 'https://api.todoist.com/oauth/access_token',
      scope: 'data:read_write',
      redirectUri: 'http://127.0.0.1:7878/service/todoist/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://api.todoist.com/oauth/access_token',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [{ host: 'api.todoist.com', strategy: 'bearer' }],
  },
  // ── Supabase Management API (form body + Basic-auth client credentials) ──
  supabase: {
    provider: 'supabase',
    displayName: 'Supabase',
    authKind: 'oauth2',
    description: 'Projects and configuration via the Supabase Management API.',
    defaultScopes: 'all',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-supabase-client-id',
      authorizationEndpoint: 'https://api.supabase.com/v1/oauth/authorize',
      tokenEndpoint: 'https://api.supabase.com/v1/oauth/token',
      scope: 'all',
      redirectUri: 'http://127.0.0.1:7878/service/supabase/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://api.supabase.com/v1/oauth/token',
      bodyFormat: 'form',
      clientAuth: 'basic-auth',
    },
    hostRules: [{ host: 'api.supabase.com', strategy: 'bearer' }],
  },
  // ── MongoDB Atlas (client_credentials grant — special refresh) ──
  'mongodb-atlas': {
    provider: 'mongodb-atlas',
    displayName: 'MongoDB Atlas',
    authKind: 'oauth2',
    description: 'Clusters and projects via the MongoDB Atlas Administration API.',
    defaultScopes: '',
    refresh: {
      kind: 'client-credentials',
      tokenUrl: 'https://cloud.mongodb.com/api/oauth/token',
    },
    hostRules: [{ host: 'cloud.mongodb.com', strategy: 'bearer' }],
  },
  // ── monday.com (api-key — no OAuth refresh) ──
  monday: {
    provider: 'monday',
    displayName: 'monday.com',
    authKind: 'oauth2',
    description: 'Boards, items, and updates via the monday.com GraphQL API.',
    defaultScopes: 'me:read boards:read boards:write',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-monday-client-id',
      authorizationEndpoint: 'https://auth.monday.com/oauth2/authorize',
      tokenEndpoint: 'https://auth.monday.com/oauth2/token',
      scope: 'me:read boards:read boards:write',
      redirectUri: 'http://127.0.0.1:7878/service/monday/callback',
    },
    hostRules: [{ host: 'api.monday.com', strategy: 'bearer' }],
  },
  // ── Resend (api-key) ──
  resend: {
    provider: 'resend',
    displayName: 'Resend',
    authKind: 'api-key',
    description: 'Send transactional email via the Resend API (API-key auth).',
    defaultScopes: 'full_access',
    hostRules: [{ host: 'api.resend.com', strategy: 'bearer' }],
  },
  // ── Cloudflare (api-key) ──
  cloudflare: {
    provider: 'cloudflare',
    displayName: 'Cloudflare',
    authKind: 'api-key',
    description: 'Zones, DNS, and Workers via the Cloudflare API (API-token auth).',
    defaultScopes: '',
    hostRules: [{ host: 'api.cloudflare.com', strategy: 'bearer' }],
  },
  // ── Fly.io (api-key) ──
  flyio: {
    provider: 'flyio',
    displayName: 'Fly.io',
    authKind: 'api-key',
    description: 'Machines and apps via the Fly.io Machines API (API-token auth).',
    defaultScopes: '',
    hostRules: [
      { host: 'api.machines.dev', strategy: 'bearer' },
      { host: 'api.fly.io', strategy: 'bearer' },
    ],
  },
  // ── AWS (api-key/SigV4 — credential headers; no token refresh) ──
  aws: {
    provider: 'aws',
    displayName: 'AWS',
    authKind: 'api-key',
    description: 'AWS service APIs signed with SigV4 (access-key credentials).',
    defaultScopes: '',
    hostRules: [{ host: 'amazonaws.com', strategy: 'header' }],
    credentialHeaders: [{ credentialField: 'accessKeyId', headerName: 'x-amz-access-key-id' }],
  },
  // ── Figma (form body refresh) ──
  figma: {
    provider: 'figma',
    displayName: 'Figma',
    authKind: 'oauth2',
    description: 'Files, projects, and comments via the Figma REST API.',
    defaultScopes: 'file_read',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-figma-client-id',
      authorizationEndpoint: 'https://www.figma.com/oauth',
      tokenEndpoint: 'https://api.figma.com/v1/oauth/token',
      scope: 'file_read',
      redirectUri: 'http://127.0.0.1:7878/service/figma/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://api.figma.com/v1/oauth/refresh',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [{ host: 'api.figma.com', strategy: 'bearer' }],
  },
  // ── Linear (form body refresh) ──
  linear: {
    provider: 'linear',
    displayName: 'Linear',
    authKind: 'oauth2',
    description: 'Issues, projects, and cycles via the Linear GraphQL API.',
    defaultScopes: 'read write',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-linear-client-id',
      authorizationEndpoint: 'https://linear.app/oauth/authorize',
      tokenEndpoint: 'https://api.linear.app/oauth/token',
      scope: 'read write',
      redirectUri: 'http://127.0.0.1:7878/service/linear/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://api.linear.app/oauth/token',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [{ host: 'api.linear.app', strategy: 'bearer' }],
  },
  // ── Slack (form body refresh; token rotation) ──
  slack: {
    provider: 'slack',
    displayName: 'Slack',
    authKind: 'oauth2',
    description: 'Channels, messages, and users via the Slack Web API.',
    defaultScopes: 'channels:read chat:write users:read',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-slack-client-id',
      authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
      scope: 'channels:read chat:write users:read',
      redirectUri: 'http://127.0.0.1:7878/service/slack/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [{ host: 'slack.com', strategy: 'bearer' }],
  },
  // ── Discord (form body refresh) ──
  discord: {
    provider: 'discord',
    displayName: 'Discord',
    authKind: 'oauth2',
    description: 'Guilds, channels, and messages via the Discord API.',
    defaultScopes: 'identify guilds',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-discord-client-id',
      authorizationEndpoint: 'https://discord.com/oauth2/authorize',
      tokenEndpoint: 'https://discord.com/api/oauth2/token',
      scope: 'identify guilds',
      redirectUri: 'http://127.0.0.1:7878/service/discord/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [{ host: 'discord.com', strategy: 'bearer' }],
  },
  // ── Sentry (form body refresh) ──
  sentry: {
    provider: 'sentry',
    displayName: 'Sentry',
    authKind: 'oauth2',
    description: 'Issues, events, and releases via the Sentry API.',
    defaultScopes: 'org:read project:read event:read',
    oauth: {
      mode: 'pkce',
      clientId: 'cleo-sentry-client-id',
      authorizationEndpoint: 'https://sentry.io/oauth/authorize/',
      tokenEndpoint: 'https://sentry.io/oauth/token/',
      scope: 'org:read project:read event:read',
      redirectUri: 'http://127.0.0.1:7878/service/sentry/callback',
    },
    refresh: {
      kind: 'refresh-token',
      tokenUrl: 'https://sentry.io/oauth/token/',
      bodyFormat: 'form',
      clientAuth: 'body',
    },
    hostRules: [{ host: 'sentry.io', strategy: 'bearer' }],
  },
  // ── Vercel (api-key — no OAuth refresh) ──
  vercel: {
    provider: 'vercel',
    displayName: 'Vercel',
    authKind: 'api-key',
    description: 'Deployments, projects, and domains via the Vercel REST API.',
    defaultScopes: '',
    hostRules: [{ host: 'api.vercel.com', strategy: 'bearer' }],
  },
};

/**
 * The seeded service-provider registry — **github + google + the ~40-service
 * census** (T11937 seeds + T11938 breadth).
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
    hostRules: [
      { host: 'api.github.com', strategy: 'bearer' },
      { host: 'github.com', strategy: 'basic-x-access-token' },
      { host: 'raw.githubusercontent.com', strategy: 'bearer' },
    ],
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
    refresh: GOOGLE_REFRESH,
    hostRules: [
      { host: 'www.googleapis.com', strategy: 'bearer' },
      { host: 'accounts.google.com', strategy: 'bearer' },
    ],
  },
  ...SERVICE_PROVIDERS_BREADTH,
};
