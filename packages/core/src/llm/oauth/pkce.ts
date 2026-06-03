/**
 * RFC 7636 PKCE (Proof Key for Code Exchange) OAuth flow implementation.
 *
 * Provides the full PKCE lifecycle:
 *   1. Generate a cryptographically-random code verifier + SHA-256 challenge.
 *   2. Build the authorization URL the user (or CLI) opens in a browser.
 *   3. Exchange the authorization code + verifier for tokens.
 *   4. Refresh an existing access token via the `refresh_token` grant.
 *
 * All HTTP calls use `globalThis.fetch` so they can be intercepted in tests
 * via `vi.spyOn(globalThis, 'fetch')`.
 *
 * Shared types (`OAuthTokens`, `PkceFlowConfig`) live in
 * `@cleocode/contracts/llm/oauth.ts` — the SSoT between core and cleo.
 *
 * @module llm/oauth/pkce
 * @task T9302
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see RFC 7636 https://datatracker.ietf.org/doc/html/rfc7636
 */

import type { OAuthTokens } from '@cleocode/contracts/llm/oauth.js';

// Re-export shared types for convenience — consumers can import from here.
export type { OAuthTokens } from '@cleocode/contracts/llm/oauth.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A PKCE code-verifier / code-challenge pair.
 *
 * The verifier is kept secret and sent only to the token endpoint.
 * The challenge is derived from the verifier and sent to the authorization
 * endpoint in plain text. An attacker who intercepts the challenge cannot
 * reverse it to recover the verifier.
 *
 * @task T9302
 */
export interface PkcePair {
  /**
   * Cryptographically-random base64url-encoded string (43–128 chars, RFC 7636 §4.1).
   *
   * MUST be sent to the token endpoint as `code_verifier` during code exchange.
   * MUST NOT be logged, printed to stdout, or stored in plaintext.
   */
  codeVerifier: string;
  /**
   * BASE64URL(SHA256(ASCII(code_verifier))) per RFC 7636 §4.2.
   *
   * Sent to the authorization endpoint as `code_challenge` with
   * `code_challenge_method=S256`.
   */
  codeChallenge: string;
}

// ---------------------------------------------------------------------------
// PKCE pair generation
// ---------------------------------------------------------------------------

/**
 * Generate a RFC 7636 PKCE code-verifier / code-challenge pair.
 *
 * Uses the Web Crypto API (`crypto.getRandomValues` + `crypto.subtle.digest`)
 * which is available in Node.js ≥ 19, browsers, and Deno. For Node.js < 19
 * the global `crypto` is polyfilled by `globalThis.crypto`.
 *
 * Algorithm (RFC 7636 §4.1 + §4.2):
 * 1. Generate 32 random bytes.
 * 2. base64url-encode them → `codeVerifier` (43 chars from 32 bytes).
 * 3. SHA-256 hash the ASCII bytes of `codeVerifier`.
 * 4. base64url-encode the hash → `codeChallenge`.
 *
 * @returns A fresh PKCE pair. Each call returns a unique pair.
 * @task T9302
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64urlEncode(randomBytes);

  const verifierBytes = new TextEncoder().encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', verifierBytes);
  const codeChallenge = base64urlEncode(new Uint8Array(hashBuffer));

  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Authorization URL builder
// ---------------------------------------------------------------------------

/**
 * Parameters for building the OAuth authorization URL.
 *
 * @task T9302
 */
export interface BuildAuthorizationUrlParams {
  /** OAuth authorization endpoint. */
  authorizationEndpoint: string;
  /** OAuth 2.0 client ID. */
  clientId: string;
  /** Redirect URI where the provider sends the authorization response. */
  redirectUri: string;
  /** Space-separated OAuth scopes. */
  scope: string;
  /** PKCE code challenge (from {@link generatePkcePair}). */
  codeChallenge: string;
  /** Opaque CSRF-prevention state value. Must be round-tripped through the redirect. */
  state: string;
  /**
   * Provider-specific extra query parameters appended after the RFC-required
   * ones (e.g. OpenAI/Codex `id_token_add_organizations`,
   * `codex_cli_simplified_flow`, `originator`). Omitted by Anthropic.
   */
  extraParams?: Readonly<Record<string, string>>;
}

/**
 * Build the authorization URL the user opens to grant consent.
 *
 * Encodes `response_type=code`, `code_challenge_method=S256`, and all
 * required parameters per RFC 7636 §4.3.
 *
 * @param params - URL components.
 * @returns Fully-formed authorization URL string.
 * @task T9302
 */
export function buildAuthorizationUrl(params: BuildAuthorizationUrlParams): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  // Provider-specific extras (e.g. OpenAI/Codex id_token_add_organizations,
  // codex_cli_simplified_flow, originator). Set last so they cannot clobber
  // the RFC-required params above.
  if (params.extraParams) {
    for (const [k, v] of Object.entries(params.extraParams)) {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Code exchange
// ---------------------------------------------------------------------------

/**
 * Parameters for the PKCE authorization code exchange.
 *
 * @task T9302
 */
export interface ExchangePkceCodeParams {
  /** Provider name (used in error messages only). */
  provider: string;
  /** OAuth 2.0 client ID. */
  clientId: string;
  /** Authorization code returned in the redirect callback. */
  code: string;
  /** PKCE code verifier — the secret counterpart to `codeChallenge`. */
  codeVerifier: string;
  /** Redirect URI used in the original authorization request. */
  redirectUri: string;
  /** Token endpoint URL. */
  tokenEndpoint: string;
  /** Extra headers (e.g. provider-specific beta flags). */
  extraHeaders?: Readonly<Record<string, string>>;
}

/**
 * Exchange an authorization code + PKCE verifier for access and refresh tokens.
 *
 * POSTs `grant_type=authorization_code` to `params.tokenEndpoint` per
 * RFC 6749 §4.1.3 + RFC 7636 §4.5.
 *
 * @param params - Exchange parameters.
 * @returns Normalized token response.
 * @throws {Error} On HTTP errors or missing `access_token` in the response.
 * @task T9302
 */
export async function exchangePkceCode(params: ExchangePkceCodeParams): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });

  const resp = await globalThis.fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...params.extraHeaders,
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const detail = await extractErrorDetail(resp);
    throw new Error(
      `PKCE code exchange failed for provider '${params.provider}': HTTP ${resp.status}${detail}`,
    );
  }

  return parseTokenResponse(params.provider, await resp.json());
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Parameters for the PKCE token refresh grant.
 *
 * @task T9302
 */
export interface RefreshPkceTokenParams {
  /** Provider name (used in error messages only). */
  provider: string;
  /** OAuth 2.0 client ID. */
  clientId: string;
  /** Refresh token obtained from a previous code exchange or refresh. */
  refreshToken: string;
  /** Token endpoint URL. */
  tokenEndpoint: string;
  /** Extra headers (e.g. provider-specific beta flags). */
  extraHeaders?: Readonly<Record<string, string>>;
}

/**
 * Refresh an access token using the `refresh_token` grant (RFC 6749 §6).
 *
 * Uses the same token endpoint as code exchange. On success, a new access
 * token (and optionally a new refresh token) is returned. The caller is
 * responsible for persisting the updated tokens.
 *
 * @param params - Refresh parameters.
 * @returns Normalized token response with fresh `accessToken`.
 * @throws {Error} On HTTP errors or missing `access_token` in the response.
 * @task T9302
 */
export async function refreshPkceToken(params: RefreshPkceTokenParams): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  });

  const resp = await globalThis.fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...params.extraHeaders,
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const detail = await extractErrorDetail(resp);
    throw new Error(
      `PKCE token refresh failed for provider '${params.provider}': HTTP ${resp.status}${detail}`,
    );
  }

  return parseTokenResponse(params.provider, await resp.json());
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * base64url-encode a byte array (RFC 4648 §5, no padding).
 *
 * Uses `btoa` for browser/Node.js compatibility; replaces `+` with `-`,
 * `/` with `_`, and strips trailing `=` padding per RFC 7636 §Appendix A.
 *
 * @internal
 */
function base64urlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parse a raw token endpoint JSON body into a normalized {@link OAuthTokens}.
 *
 * @throws {Error} When `access_token` is absent or not a string.
 * @internal
 */
function parseTokenResponse(provider: string, data: unknown): OAuthTokens {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Token endpoint for '${provider}' returned non-object response`);
  }
  const d = data as Record<string, unknown>;

  const accessToken = d['access_token'];
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error(`Token endpoint for '${provider}' returned response without access_token`);
  }

  return {
    accessToken,
    refreshToken: typeof d['refresh_token'] === 'string' ? d['refresh_token'] : undefined,
    expiresIn: typeof d['expires_in'] === 'number' ? d['expires_in'] : undefined,
    tokenType: typeof d['token_type'] === 'string' ? d['token_type'] : 'bearer',
  };
}

/**
 * Extract a human-readable error detail string from a non-OK HTTP response.
 *
 * Tries to parse JSON body for `error_description` or `error`; falls back to
 * empty string on parse failure.
 *
 * @internal
 */
async function extractErrorDetail(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as Record<string, unknown>;
    const desc = body['error_description'] ?? body['error'];
    return desc ? ` — ${String(desc)}` : '';
  } catch {
    return '';
  }
}
