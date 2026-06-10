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
// Authorization-response input parsing
// ---------------------------------------------------------------------------

/**
 * Parse a user-pasted authorization response into `{ code, state }`.
 *
 * Accepts every form a provider's callback page can hand the user
 * (mirrors pi-ai's `parseAuthorizationInput`):
 * - a full redirect URL — `https://…/callback?code=…&state=…`
 * - the `code#state` pair Anthropic's hosted callback page displays
 * - a bare query string — `code=…&state=…`
 * - a bare authorization code
 *
 * Callers MUST validate a returned `state` against the authorize-time state
 * (CSRF check, RFC 6749 §10.12) before exchanging the code.
 *
 * @param input - Raw pasted text from the user.
 * @returns Extracted `code` and `state` (either may be `undefined`).
 * @task T11958
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // not a URL — fall through to the bare forms
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code: code || undefined, state: state || undefined };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }
  return { code: value };
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
  /**
   * The `state` value from the original authorization request.
   *
   * Only sent when `bodyFormat` is `'json'` — Anthropic's token endpoint
   * validates the (code, state) pair bound at authorize time and rejects the
   * exchange without it. RFC-compliant form-encoded endpoints do not define
   * `state` on the token request, so it is omitted there.
   */
  state?: string;
  /**
   * Token request body encoding. `'form'` (RFC 6749 default) or `'json'`
   * (Anthropic). See `ProviderOAuthConfig.tokenBodyFormat`.
   *
   * @default 'form'
   */
  bodyFormat?: 'form' | 'json';
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
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  };
  // Anthropic (json) requires the authorize-time state echoed in the exchange;
  // form-encoded RFC endpoints do not define it on the token request.
  if (params.bodyFormat === 'json' && params.state) {
    fields['state'] = params.state;
  }

  const resp = await postTokenRequest(params.tokenEndpoint, fields, params);

  if (!resp.ok) {
    const detail = await extractOAuthErrorDetail(resp);
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
  /**
   * Token request body encoding. `'form'` (RFC 6749 default) or `'json'`
   * (Anthropic). See `ProviderOAuthConfig.tokenBodyFormat`.
   *
   * @default 'form'
   */
  bodyFormat?: 'form' | 'json';
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
  const fields: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  };

  const resp = await postTokenRequest(params.tokenEndpoint, fields, params);

  if (!resp.ok) {
    const detail = await extractOAuthErrorDetail(resp);
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
 * POST a token-endpoint request (code exchange or refresh grant).
 *
 * Single home for the body-encoding split shared by {@link exchangePkceCode}
 * and {@link refreshPkceToken}: `'form'` (RFC 6749 default,
 * `application/x-www-form-urlencoded`) vs `'json'` (Anthropic's non-RFC
 * `application/json` token endpoint). See
 * `ProviderOAuthConfig.tokenBodyFormat`.
 *
 * @internal
 */
function postTokenRequest(
  tokenEndpoint: string,
  fields: Record<string, string>,
  opts: Pick<ExchangePkceCodeParams, 'bodyFormat' | 'extraHeaders'>,
): Promise<Response> {
  return globalThis.fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type':
        opts.bodyFormat === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...opts.extraHeaders,
    },
    body:
      opts.bodyFormat === 'json' ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
  });
}

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
 * Extract a human-readable error detail string from a non-OK OAuth HTTP
 * response.
 *
 * The single shared extractor for every OAuth surface in the LLM layer
 * (`pkce.ts`, `google-pkce.ts`, `device-code.ts`) — local copies drifted and
 * re-introduced the `[object Object]` masking of DHQ-075 (T11958).
 *
 * Strategy:
 * 1. Clone the response so the body stream is not consumed by the primary
 *    error path (callers may need the body for further inspection).
 * 2. Parse as JSON; use `error_description` or `error` fields (RFC 6749 §5.2).
 *    When the field is an object (Anthropic nests
 *    `{"error": {"type", "message"}}`), extract `message`/`type` — never
 *    `String(object)`.
 * 3. Fall back to the raw text body when JSON parsing fails (e.g. HTML pages
 *    returned by a WAF or a misconfigured reverse proxy). Truncate at 512 chars
 *    so a multi-kilobyte HTML page does not flood the error message.
 * 4. Return `''` only when all fallbacks are exhausted.
 *
 * This ensures the caller never sees `[object Object]` in the thrown message
 * and always surfaces the actual HTTP response body for debugging.
 *
 * @task T11958
 */
export async function extractOAuthErrorDetail(resp: Response): Promise<string> {
  // Clone before reading so the caller's Response is not drained.
  const clone = resp.clone();
  try {
    const body = (await clone.json()) as Record<string, unknown>;
    const desc = body['error_description'] ?? body['error'];
    if (typeof desc === 'string' && desc) return ` — ${desc}`;
    // Anthropic nests the detail: {"error": {"type": "...", "message": "..."}}.
    // `String(object)` here is what produced the undebuggable
    // "[object Object]" of DHQ-075 — extract message/type, else stringify.
    if (desc !== null && typeof desc === 'object') {
      const d = desc as Record<string, unknown>;
      const message = typeof d['message'] === 'string' ? d['message'] : undefined;
      const type = typeof d['type'] === 'string' ? d['type'] : undefined;
      if (message) return ` — ${type ? `${type}: ` : ''}${message}`;
      return ` — ${JSON.stringify(desc).slice(0, 512)}`;
    }
    // JSON parsed but had no recognized field: fall through to raw-text path.
    const text = JSON.stringify(body);
    return ` — ${text.slice(0, 512)}`;
  } catch {
    // Not valid JSON — try reading as plain text (HTML, plain-text errors, etc.)
    try {
      const text = (await resp.text()).trim();
      return text ? ` — ${text.slice(0, 512)}` : '';
    } catch {
      return '';
    }
  }
}
