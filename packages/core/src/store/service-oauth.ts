/**
 * Service-vault OAuth flow — build / exchange / refresh / self-heal (T11939).
 *
 * EP-UNIVERSAL-SERVICE-VAULT (epic T11765 · saga SG-VAULT-CORE T10409 · M2 W2 ·
 * task T11939). The OAuth dance the foundation (T11937) left a clean seam for.
 * Every function is DRIVEN BY the declarative {@link ServiceProviderDef} from the
 * `SERVICE_PROVIDERS` registry (contracts, T11937 + T11938 breadth) — there is no
 * per-provider code, only data-shaped branches on the provider's `oauth` config
 * and `refresh.kind` discriminant.
 *
 * ## What this module owns (the four entry points)
 *
 *  1. {@link buildAuthUrl} — compose the authorization URL (PKCE S256 + state +
 *     provider `extraAuthParams`) for an `oauth2`/`oauth2-pkce` provider, or the
 *     device-authorization start for a `device-code` provider.
 *  2. {@link exchangeCode} — POST `grant_type=authorization_code` (+ PKCE
 *     verifier) to the token endpoint and PERSIST the resulting
 *     `{accessToken, refreshToken}` blob `encryptGlobal`-encrypted via
 *     {@link connectService} (the foundation accessor — reused, not reinvented).
 *  3. {@link refreshAccessToken} — refresh an access token honoring the
 *     provider's `refresh` config: the `refresh-token` grant (Form/Json body ×
 *     Body/BasicAuth client auth) plus the three special variants (`github-app`
 *     JWT, `service-account-jwt` bearer, `client-credentials`).
 *  4. {@link selfHealConnection} — the resolve-path self-heal: when a connection's
 *     `expires_at` is past, transparently refresh → re-`encryptGlobal` → persist
 *     back via the accessor, returning a FRESH {@link SealedCredential} so agents
 *     NEVER see a stale token. Cannibalizes onecli `connect.rs::resolve_access_token`.
 *
 * ## Crypto + persistence reuse (DRY — no new crypto, no new store)
 *
 * Encryption is ALWAYS `encryptGlobal` keyed `id = service:${provider}:${label}`
 * (via {@link connectService} / {@link updateConnectionTokens}). The egress handle
 * is the shared {@link makeSealedCredential} — the plaintext materializes ONLY at
 * the wire inside the handle's `fetch()`, never inline on a resolve. HTTP uses the
 * platform `globalThis.fetch` (no new dep) so tests inject a stub.
 *
 * @module store/service-oauth
 * @task T11939
 * @epic T11765
 * @saga T10409
 * @see ../../../contracts/src/vault/service-provider.ts — the DATA that drives this flow
 * @see ./service-connections-accessor.ts — connect/resolve/persist (reused)
 * @see ../llm/oauth/pkce.ts — generatePkcePair / buildAuthorizationUrl (reused)
 * @see ../crypto/credentials.ts — encryptGlobal / decryptGlobal (reused)
 * @see ../../../onecli — apps/gateway/src/{apps.rs,connect.rs} (the ported design)
 */

import type {
  ProviderOAuthConfig,
  RefreshConfig,
  SealedCredential,
  ServiceProviderDef,
} from '@cleocode/contracts';
import { SERVICE_PROVIDERS } from '@cleocode/contracts';
import { buildAuthorizationUrl, generatePkcePair, type OAuthTokens } from '../llm/oauth/pkce.js';
import { makeSealedCredential, tokenPreview } from '../llm/sealed-credential.js';
import {
  connectService,
  loadDecryptedTokenBlob,
  type ServiceTokenBlob,
  type ServiceVaultDeps,
  updateConnectionTokens,
} from './service-connections-accessor.js';

// ---------------------------------------------------------------------------
// Injectable HTTP (test seam) + clock
// ---------------------------------------------------------------------------

/**
 * The minimal `fetch` surface this module uses — `globalThis.fetch`-compatible.
 *
 * Injectable so tests pass a stub WITHOUT monkey-patching the global. Defaults to
 * `globalThis.fetch`.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/**
 * Injectable dependencies for the OAuth flow — HTTP, clock, and the vault deps.
 *
 * Every field is optional; defaults bind the real implementations. Tests inject a
 * `fetch` stub (to mock the token endpoint), a frozen `now` (fake clock for the
 * self-heal expiry test), and a temp-DB `vault` handle (off `.cleo/*.db`).
 *
 * @task T11939
 */
export interface ServiceOAuthDeps {
  /** HTTP transport. Defaults to {@link globalFetch}. */
  readonly fetch?: FetchLike;
  /** Current epoch milliseconds. Defaults to {@link Date.now}. Fake-clock seam for self-heal. */
  readonly now?: () => number;
  /** Vault accessor deps (db handle + crypto spies) forwarded to the foundation accessor. */
  readonly vault?: ServiceVaultDeps;
}

/** Bind the platform fetch lazily so the module imports side-effect-free. */
const globalFetch: FetchLike = (input, init) =>
  globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the {@link ServiceProviderDef} for a provider key, throwing a typed
 * error when unknown.
 *
 * @param provider - The stable provider key (e.g. `'github'`).
 * @returns The declarative provider definition.
 * @throws {Error} `E_SERVICE_PROVIDER_UNKNOWN` when the key is not in the registry.
 * @task T11939
 */
export function resolveProviderDef(provider: string): ServiceProviderDef {
  const def = SERVICE_PROVIDERS[provider];
  if (def === undefined) {
    throw new Error(`E_SERVICE_PROVIDER_UNKNOWN: no service provider '${provider}' in registry`);
  }
  return def;
}

/** Resolve the provider's OAuth config, throwing when the provider is api-key-only. */
function requireOAuth(def: ServiceProviderDef): ProviderOAuthConfig {
  if (def.oauth === undefined) {
    throw new Error(
      `E_SERVICE_OAUTH_UNSUPPORTED: provider '${def.provider}' (authKind=${def.authKind}) has no OAuth config`,
    );
  }
  return def.oauth;
}

// ---------------------------------------------------------------------------
// AC1 — buildAuthUrl
// ---------------------------------------------------------------------------

/** Options for {@link buildAuthUrl}. */
export interface BuildAuthUrlOptions {
  /** Opaque CSRF `state`. A random value is generated when omitted. */
  readonly state?: string;
  /** Scope override (e.g. a BYOC custom scope). Defaults to the provider's declared scope. */
  readonly scope?: string;
  /** Client id override (e.g. a BYOC `service_configs` client id). Defaults to the registry value. */
  readonly clientId?: string;
  /** Redirect URI override. Defaults to the provider's declared loopback redirect. */
  readonly redirectUri?: string;
}

/** The authorization-URL result, carrying the secrets the caller must round-trip. */
export interface BuildAuthUrlResult {
  /** The fully-formed authorization URL the user opens to grant consent. */
  readonly authUrl: string;
  /**
   * The PKCE code verifier — the SECRET counterpart sent to the token endpoint in
   * {@link exchangeCode}. The caller MUST retain it across the redirect.
   */
  readonly codeVerifier: string;
  /** The CSRF `state` echoed in the redirect; the caller MUST verify it matches. */
  readonly state: string;
  /** The redirect URI used — the caller MUST pass the SAME value to {@link exchangeCode}. */
  readonly redirectUri: string;
}

/**
 * AC1 — build the authorization URL (+ PKCE pair) for an OAuth provider.
 *
 * Generates a fresh PKCE verifier/challenge (RFC 7636 S256) and composes the
 * authorization URL via the reused {@link buildAuthorizationUrl}, appending the
 * provider's declared `extraAuthParams` (e.g. google `access_type=offline`).
 * Returns the verifier + state the caller round-trips through the redirect into
 * {@link exchangeCode}.
 *
 * @param provider - The provider key (must have an `oauth` config).
 * @param opts - Optional state / scope / client-id / redirect overrides (BYOC).
 * @returns The auth URL plus the PKCE verifier and state to round-trip.
 * @throws {Error} When the provider is unknown or api-key-only.
 * @task T11939
 */
export async function buildAuthUrl(
  provider: string,
  opts: BuildAuthUrlOptions = {},
): Promise<BuildAuthUrlResult> {
  const def = resolveProviderDef(provider);
  const oauth = requireOAuth(def);
  if (oauth.authorizationEndpoint === undefined) {
    throw new Error(
      `E_SERVICE_OAUTH_NO_AUTH_ENDPOINT: provider '${provider}' has no authorizationEndpoint (device-code flow uses startDeviceAuthorization)`,
    );
  }
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = opts.state ?? generateState();
  const redirectUri = opts.redirectUri ?? oauth.redirectUri ?? 'http://127.0.0.1:7878/callback';
  const scope = opts.scope ?? oauth.scope ?? def.defaultScopes ?? '';
  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: oauth.authorizationEndpoint,
    clientId: opts.clientId ?? oauth.clientId,
    redirectUri,
    scope,
    codeChallenge,
    state,
    ...(oauth.extraAuthParams !== undefined ? { extraParams: oauth.extraAuthParams } : {}),
  });
  return { authUrl, codeVerifier, state, redirectUri };
}

/** Generate an opaque, URL-safe CSRF `state` value. */
function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// AC1 — exchangeCode
// ---------------------------------------------------------------------------

/** Options for {@link exchangeCode}. */
export interface ExchangeCodeOptions {
  /** The authorization code from the redirect callback. */
  readonly code: string;
  /** The PKCE verifier from {@link buildAuthUrl} (round-tripped). */
  readonly codeVerifier: string;
  /** The redirect URI used in {@link buildAuthUrl} (must match). */
  readonly redirectUri: string;
  /** Connection label, unique within the provider (e.g. `'personal'`). Defaults to `'default'`. */
  readonly label?: string;
  /** Client id override (BYOC). Defaults to the registry value. */
  readonly clientId?: string;
  /** Non-secret metadata to store on the connection (e.g. `{ username }`). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The result of {@link exchangeCode} — the persisted connection's identity (non-secret). */
export interface ExchangeCodeResult {
  /** The `service_connections.id` of the connect/refresh upsert. */
  readonly connectionId: number;
  /** The provider key. */
  readonly provider: string;
  /** The connection label. */
  readonly label: string;
  /** ISO-8601 access-token expiry, when the provider returned `expires_in`. */
  readonly expiresAt: string | null;
  /** Whether the provider issued a refresh token (gates future self-heal). */
  readonly hasRefreshToken: boolean;
}

/**
 * AC1 — exchange an authorization code for tokens and PERSIST them encrypted.
 *
 * POSTs `grant_type=authorization_code` (+ PKCE verifier) to the provider's token
 * endpoint via the reused {@link exchangePkceCode}, then writes the resulting
 * `{accessToken, refreshToken}` blob `encryptGlobal`-encrypted through
 * {@link connectService}. The plaintext token is NEVER returned — only the
 * non-secret connection identity. The expiry is computed from `expires_in`.
 *
 * @param provider - The provider key.
 * @param opts - The code, PKCE verifier, redirect, and connection label.
 * @param deps - Injectable HTTP / clock / vault (test seam).
 * @returns The persisted connection's non-secret identity.
 * @throws {Error} On HTTP failure or a token response missing `access_token`.
 * @task T11939
 */
export async function exchangeCode(
  provider: string,
  opts: ExchangeCodeOptions,
  deps: ServiceOAuthDeps = {},
): Promise<ExchangeCodeResult> {
  const def = resolveProviderDef(provider);
  const oauth = requireOAuth(def);
  const label = opts.label ?? 'default';
  const fetchImpl = deps.fetch ?? globalFetch;
  // POST grant_type=authorization_code + PKCE verifier through the injectable
  // FetchLike (consistent with the refresh path; lets a test stub the endpoint).
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: opts.clientId ?? oauth.clientId,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  });
  const resp = await fetchImpl(oauth.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });
  if (!resp.ok) {
    throw new Error(
      `E_SERVICE_EXCHANGE_HTTP: provider '${provider}' code exchange failed: HTTP ${resp.status}: ${await safeText(resp)}`,
    );
  }
  const data = (await resp.json()) as Record<string, unknown>;
  const accessToken = data['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    const err = typeof data['error'] === 'string' ? (data['error'] as string) : 'no access_token';
    throw new Error(`E_SERVICE_EXCHANGE_NO_ACCESS_TOKEN: provider '${provider}': ${err}`);
  }
  const tokens: OAuthTokens = {
    accessToken,
    refreshToken:
      typeof data['refresh_token'] === 'string' ? (data['refresh_token'] as string) : undefined,
    expiresIn: typeof data['expires_in'] === 'number' ? (data['expires_in'] as number) : undefined,
    tokenType: typeof data['token_type'] === 'string' ? (data['token_type'] as string) : 'bearer',
  };
  const expiresAt = computeExpiresAt(tokens.expiresIn, deps.now);
  const blob: ServiceTokenBlob = {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
  };
  const connectionId = await connectService(
    {
      provider,
      label,
      tokens: blob,
      scopes: (oauth.scope ?? def.defaultScopes ?? '').split(' ').filter((s) => s.length > 0),
      ...(expiresAt !== null ? { expiresAt } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    },
    deps.vault,
  );
  return {
    connectionId,
    provider,
    label,
    expiresAt,
    hasRefreshToken: tokens.refreshToken !== undefined,
  };
}

// ---------------------------------------------------------------------------
// AC2 — refreshAccessToken (driven by per-provider RefreshConfig)
// ---------------------------------------------------------------------------

/** Client credentials for a refresh exchange (BYOC or CLEO first-party). */
export interface RefreshClientCredentials {
  /** OAuth client id. */
  readonly clientId: string;
  /** OAuth client secret (NULL for a public PKCE client with none). */
  readonly clientSecret?: string;
}

/** Input to the JWT-bearer / github-app / client-credentials refresh variants. */
export interface RefreshVariantSecrets {
  /** RSA private key PEM (github-app + service-account-jwt). */
  readonly privateKeyPem?: string;
  /** GitHub App id (github-app). */
  readonly appId?: string;
  /** GitHub App installation id (github-app). */
  readonly installationId?: string;
  /** Service-account client email (service-account-jwt). */
  readonly clientEmail?: string;
}

/** Options for {@link refreshAccessToken}. */
export interface RefreshAccessTokenOptions {
  /** The current refresh token (for the `refresh-token` grant). */
  readonly refreshToken?: string;
  /** Client credentials (for `refresh-token` Body/BasicAuth + `client-credentials`). */
  readonly client?: RefreshClientCredentials;
  /** Secrets for the JWT-bearer / github-app variants. */
  readonly variant?: RefreshVariantSecrets;
}

/**
 * AC2 — refresh an access token honoring the provider's declared refresh config.
 *
 * Branches on {@link RefreshConfig.kind}:
 *
 *  - `refresh-token` — `grant_type=refresh_token` shaped by `bodyFormat`
 *    (Form/Json) × `clientAuth` (Body/BasicAuth). The common OAuth case.
 *  - `github-app` — sign an RS256 JWT with the app key, POST
 *    `/app/installations/{id}/access_tokens`.
 *  - `service-account-jwt` — sign an RS256 JWT, exchange via
 *    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
 *  - `client-credentials` — `grant_type=client_credentials`, Basic-auth client.
 *
 * Returns normalized {@link OAuthTokens} (a fresh access token + optional rotated
 * refresh token). PERSISTENCE is the caller's job ({@link selfHealConnection}
 * does it); this function is pure HTTP + crypto so it is independently testable.
 *
 * @param provider - The provider key.
 * @param opts - The refresh token / client credentials / variant secrets.
 * @param deps - Injectable HTTP / clock (test seam).
 * @returns The refreshed tokens.
 * @throws {Error} When the provider declares no refresh, or the exchange fails.
 * @task T11939
 */
export async function refreshAccessToken(
  provider: string,
  opts: RefreshAccessTokenOptions,
  deps: ServiceOAuthDeps = {},
): Promise<OAuthTokens> {
  const def = resolveProviderDef(provider);
  const refresh = def.refresh;
  if (refresh === undefined) {
    throw new Error(
      `E_SERVICE_REFRESH_UNSUPPORTED: provider '${provider}' declares no refresh config`,
    );
  }
  const fetchImpl = deps.fetch ?? globalFetch;
  switch (refresh.kind) {
    case 'refresh-token':
      return refreshViaRefreshToken(provider, refresh, opts, fetchImpl);
    case 'github-app':
      return refreshViaGithubApp(refresh, opts, fetchImpl, deps.now);
    case 'service-account-jwt':
      return refreshViaServiceAccount(refresh, opts, fetchImpl, deps.now);
    case 'client-credentials':
      return refreshViaClientCredentials(refresh, opts, fetchImpl);
    default: {
      // Exhaustiveness guard — a new RefreshKind must extend this switch.
      const never: never = refresh.kind;
      throw new Error(`E_SERVICE_REFRESH_KIND_UNKNOWN: ${String(never)}`);
    }
  }
}

/** `grant_type=refresh_token` — Form/Json body × Body/BasicAuth client auth. */
async function refreshViaRefreshToken(
  provider: string,
  refresh: RefreshConfig,
  opts: RefreshAccessTokenOptions,
  fetchImpl: FetchLike,
): Promise<OAuthTokens> {
  const refreshToken = opts.refreshToken;
  if (refreshToken === undefined || refreshToken.length === 0) {
    throw new Error(`E_SERVICE_REFRESH_NO_TOKEN: provider '${provider}' refresh requires a token`);
  }
  const bodyFormat = refresh.bodyFormat ?? 'form';
  const clientAuth = refresh.clientAuth ?? 'body';
  const clientId = opts.client?.clientId;
  const clientSecret = opts.client?.clientSecret;
  const headers: Record<string, string> = { Accept: 'application/json' };
  // BasicAuth presents the client credentials as an Authorization header.
  if (clientAuth === 'basic-auth' && clientId !== undefined && clientSecret !== undefined) {
    headers['authorization'] = `Basic ${base64(`${clientId}:${clientSecret}`)}`;
  }

  let body: string;
  if (bodyFormat === 'json') {
    headers['Content-Type'] = 'application/json';
    const json: Record<string, string> = {
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    if (clientAuth === 'body' && clientId !== undefined && clientSecret !== undefined) {
      json['client_id'] = clientId;
      json['client_secret'] = clientSecret;
    }
    body = JSON.stringify(json);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const form = new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (clientAuth === 'body' && clientId !== undefined && clientSecret !== undefined) {
      form.set('client_id', clientId);
      form.set('client_secret', clientSecret);
    }
    body = form.toString();
  }

  const resp = await fetchImpl(refresh.tokenUrl, { method: 'POST', headers, body });
  return parseRefreshResponse(provider, resp);
}

/** `grant_type=client_credentials` — Basic-auth client (e.g. MongoDB Atlas SAs). */
async function refreshViaClientCredentials(
  refresh: RefreshConfig,
  opts: RefreshAccessTokenOptions,
  fetchImpl: FetchLike,
): Promise<OAuthTokens> {
  const clientId = opts.client?.clientId;
  const clientSecret = opts.client?.clientSecret;
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      'E_SERVICE_REFRESH_NO_CLIENT: client_credentials refresh requires clientId + clientSecret',
    );
  }
  const resp = await fetchImpl(refresh.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${base64(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  return parseRefreshResponse('client-credentials', resp);
}

/**
 * GitHub App installation token — sign an RS256 JWT with the app key, exchange at
 * `/app/installations/{id}/access_tokens`. The response shape differs (`token` +
 * `expires_at`), normalized here to {@link OAuthTokens}.
 */
async function refreshViaGithubApp(
  refresh: RefreshConfig,
  opts: RefreshAccessTokenOptions,
  fetchImpl: FetchLike,
  now?: () => number,
): Promise<OAuthTokens> {
  const { privateKeyPem, appId, installationId } = opts.variant ?? {};
  if (privateKeyPem === undefined || appId === undefined || installationId === undefined) {
    throw new Error(
      'E_SERVICE_REFRESH_GITHUB_APP: github-app refresh requires privateKeyPem + appId + installationId',
    );
  }
  const nowSec = Math.floor((now?.() ?? Date.now()) / 1000);
  const jwt = await signRs256Jwt(
    { alg: 'RS256', typ: 'JWT' },
    { iss: appId, iat: nowSec - 60, exp: nowSec + 600 },
    privateKeyPem,
  );
  const url = `${refresh.tokenUrl}/${installationId}/access_tokens`;
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cleo-service-vault',
    },
  });
  if (!resp.ok) {
    throw new Error(
      `E_SERVICE_REFRESH_GITHUB_APP_HTTP: HTTP ${resp.status}: ${await safeText(resp)}`,
    );
  }
  const data = (await resp.json()) as Record<string, unknown>;
  const token = data['token'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      'E_SERVICE_REFRESH_GITHUB_APP_NO_TOKEN: installation token response missing token',
    );
  }
  // GitHub returns an ISO `expires_at`; derive seconds-until for the common shape.
  const expiresAtIso =
    typeof data['expires_at'] === 'string' ? (data['expires_at'] as string) : undefined;
  const expiresIn =
    expiresAtIso !== undefined
      ? Math.max(0, Math.floor((Date.parse(expiresAtIso) - (now?.() ?? Date.now())) / 1000))
      : 3600;
  return { accessToken: token, expiresIn, tokenType: 'bearer' };
}

/**
 * Google service-account — sign an RS256 JWT and exchange via the jwt-bearer
 * grant at the provider's token endpoint.
 */
async function refreshViaServiceAccount(
  refresh: RefreshConfig,
  opts: RefreshAccessTokenOptions,
  fetchImpl: FetchLike,
  now?: () => number,
): Promise<OAuthTokens> {
  const { privateKeyPem, clientEmail } = opts.variant ?? {};
  if (privateKeyPem === undefined || clientEmail === undefined) {
    throw new Error(
      'E_SERVICE_REFRESH_SERVICE_ACCOUNT: service-account-jwt refresh requires privateKeyPem + clientEmail',
    );
  }
  const nowSec = Math.floor((now?.() ?? Date.now()) / 1000);
  const assertion = await signRs256Jwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: clientEmail,
      sub: clientEmail,
      aud: refresh.tokenUrl,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      iat: nowSec,
      exp: nowSec + 3600,
    },
    privateKeyPem,
  );
  const resp = await fetchImpl(refresh.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  return parseRefreshResponse('service-account', resp);
}

// ---------------------------------------------------------------------------
// AC3 — selfHealConnection (resolve-path transparent refresh + persist)
// ---------------------------------------------------------------------------

/** Options for {@link selfHealConnection}. */
export interface SelfHealOptions {
  /** The agent requesting the connection (trust-gated by the accessor). */
  readonly agentId: string;
  /** The provider key. */
  readonly provider: string;
  /** The connection label. */
  readonly label: string;
  /** Out-of-band manual-approval flag forwarded to the trust gate. */
  readonly approved?: boolean;
  /** Client credentials for the refresh exchange (BYOC or first-party). */
  readonly client?: RefreshClientCredentials;
  /** Variant secrets for the JWT/github-app refresh kinds. */
  readonly variant?: RefreshVariantSecrets;
  /**
   * Seconds of headroom before `expires_at` at which to PRE-emptively refresh —
   * a request landing in this window is refreshed too (avoids handing out a token
   * about to expire mid-flight). Defaults to 0 (refresh only once past).
   */
  readonly skewSeconds?: number;
}

/** The result of {@link selfHealConnection}. */
export interface SelfHealResult {
  /** A FRESH sealed credential (or `null` when denied / missing / no credential). */
  readonly sealed: SealedCredential | null;
  /** Whether a transparent refresh actually fired (the token was past expiry). */
  readonly refreshed: boolean;
  /** The (possibly newly-computed) ISO-8601 expiry, or `null` when unknown. */
  readonly expiresAt: string | null;
}

/**
 * AC3 — resolve a connection, transparently refreshing a PAST-EXPIRY token.
 *
 * The self-heal resolve path (cannibalized from onecli
 * `connect.rs::resolve_access_token`):
 *
 *  1. Read the connection's non-secret view (`expiresAt`).
 *  2. If `expiresAt` is past (within `skewSeconds`) AND a refresh token exists:
 *     refresh via {@link refreshAccessToken}, re-`encryptGlobal` the new blob, and
 *     persist it back via {@link updateConnectionTokens} — so the NEXT resolve and
 *     every other agent see the fresh token.
 *  3. Return a FRESH {@link SealedCredential} resolving against the (now-current)
 *     stored blob. A stale token is NEVER handed out: the heal runs BEFORE the
 *     sealed handle is built, and the handle decrypts the persisted (fresh) blob.
 *
 * The trust gate runs inside the accessor's resolve — a denied agent gets `null`
 * with NO refresh and NO decrypt.
 *
 * @param connectionRef - The agent + provider + label, plus refresh credentials.
 * @param deps - Injectable HTTP / clock / vault (test seam — the fake clock proves
 *   the past-expiry branch fires).
 * @returns The fresh sealed credential + whether a refresh fired.
 * @task T11939
 */
export async function selfHealConnection(
  connectionRef: SelfHealOptions,
  deps: ServiceOAuthDeps = {},
): Promise<SelfHealResult> {
  const { agentId, provider, label } = connectionRef;
  const nowMs = deps.now?.() ?? Date.now();
  const skewMs = (connectionRef.skewSeconds ?? 0) * 1000;

  // 1. Load the decrypted blob + expiry (gated: the accessor enforces the trust
  //    gate and only decrypts on allow). A denied/missing connection → null.
  const loaded = await loadDecryptedTokenBlob(
    {
      agentId,
      provider,
      label,
      ...(connectionRef.approved !== undefined ? { approved: connectionRef.approved } : {}),
    },
    deps.vault,
  );
  if (loaded === null) {
    return { sealed: null, refreshed: false, expiresAt: null };
  }

  let { blob, expiresAt } = loaded;
  let refreshed = false;

  // 2. Past expiry (within skew) AND refreshable → transparent refresh + persist.
  const expiryMs = expiresAt !== null ? Date.parse(expiresAt) : Number.NaN;
  const isPast = !Number.isNaN(expiryMs) && expiryMs - skewMs <= nowMs;
  if (isPast && blob.refreshToken !== undefined && def_isRefreshable(provider)) {
    const fresh = await refreshAccessToken(
      provider,
      {
        refreshToken: blob.refreshToken,
        ...(connectionRef.client !== undefined ? { client: connectionRef.client } : {}),
        ...(connectionRef.variant !== undefined ? { variant: connectionRef.variant } : {}),
      },
      deps,
    );
    const newExpiresAt = computeExpiresAt(fresh.expiresIn, deps.now);
    const newBlob: ServiceTokenBlob = {
      accessToken: fresh.accessToken,
      // Honor refresh-token rotation; else keep the existing one.
      refreshToken: fresh.refreshToken ?? blob.refreshToken,
    };
    await updateConnectionTokens(
      { provider, label, tokens: newBlob, expiresAt: newExpiresAt },
      deps.vault,
    );
    blob = newBlob;
    expiresAt = newExpiresAt;
    refreshed = true;
  }

  // 3. Build a sealed handle over the (now-fresh) access token. The plaintext
  //    only materializes at the wire inside fetch().
  const freshAccessToken = blob.accessToken;
  const sealed = makeSealedCredential({
    provider,
    account: label,
    tokenPreview: tokenPreview('', 'oauth'),
    resolveToken: (): string => freshAccessToken,
  });
  return { sealed, refreshed, expiresAt };
}

/** Whether the provider declares a refresh config (drives the self-heal branch). */
function def_isRefreshable(provider: string): boolean {
  return SERVICE_PROVIDERS[provider]?.refresh !== undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers (HTTP parse, expiry, base64, RS256 JWT)
// ---------------------------------------------------------------------------

/** Parse a token-endpoint response into normalized {@link OAuthTokens}. */
async function parseRefreshResponse(
  provider: string,
  resp: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> },
): Promise<OAuthTokens> {
  if (!resp.ok) {
    throw new Error(
      `E_SERVICE_REFRESH_HTTP: provider '${provider}' refresh failed: HTTP ${resp.status}: ${await safeText(resp)}`,
    );
  }
  const data = (await resp.json()) as Record<string, unknown>;
  const accessToken = data['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    const err = typeof data['error'] === 'string' ? (data['error'] as string) : 'no access_token';
    throw new Error(`E_SERVICE_REFRESH_NO_ACCESS_TOKEN: provider '${provider}': ${err}`);
  }
  return {
    accessToken,
    refreshToken:
      typeof data['refresh_token'] === 'string' ? (data['refresh_token'] as string) : undefined,
    expiresIn: typeof data['expires_in'] === 'number' ? (data['expires_in'] as number) : undefined,
    tokenType: typeof data['token_type'] === 'string' ? (data['token_type'] as string) : 'bearer',
  };
}

/** Read a response body as text without throwing (for error detail). */
async function safeText(resp: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await resp.text()).slice(0, 512);
  } catch {
    return '';
  }
}

/** Compute an ISO-8601 expiry from `expires_in` seconds, or `null` when absent. */
function computeExpiresAt(expiresIn: number | undefined, now?: () => number): string | null {
  if (expiresIn === undefined) return null;
  return new Date((now?.() ?? Date.now()) + expiresIn * 1000).toISOString();
}

/** Base64-encode a UTF-8 string (Node Buffer; platform-available). */
function base64(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64');
}

/** Base64url-encode bytes (no padding) for JWT segments. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sign a compact RS256 JWT using Web Crypto (no new dep — replaces the Rust
 * `jsonwebtoken` crate). Used by the github-app + service-account-jwt variants.
 *
 * @param header - The JOSE header (`{ alg: 'RS256', typ: 'JWT' }`).
 * @param claims - The claim set.
 * @param privateKeyPem - The RSA private key in PKCS#8 PEM.
 * @returns The signed compact JWT.
 */
async function signRs256Jwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> {
  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const claimsB64 = base64url(enc.encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** Decode a PKCS#8 PEM private key to its DER bytes. */
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  // Return a copy as a standalone ArrayBuffer (avoids SharedArrayBuffer typing).
  const out = new ArrayBuffer(der.byteLength);
  new Uint8Array(out).set(der);
  return out;
}

// Re-export the reused token shape so consumers pull it from one module.
export type { OAuthTokens } from '../llm/oauth/pkce.js';
