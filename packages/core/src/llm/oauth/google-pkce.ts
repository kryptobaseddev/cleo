/**
 * Google OAuth PKCE refresh helper for the `gemini-cli` credential seeder
 * (E-CONFIG-AUTH-UNIFY E2a / T9418).
 *
 * CLEO owns its own Google OAuth flow rather than reading the gemini-cli npm
 * package's token file directly — this avoids the single-use refresh-token
 * race the Hermes design notes call out (see `agent/google_oauth.py` in
 * Hermes Agent). The interactive login flow (browser callback server, PKCE
 * pair generation, code exchange) is **deferred to E3** when the
 * `cleo llm login gemini` CLI command lands; this module ships only the
 * refresh-from-expired path that the seeder needs at pool-load time.
 *
 * ## Public Google OAuth client
 *
 * The `client_id` / `client_secret` literals below are Google's PUBLIC
 * desktop OAuth client for their own open-source `@google/gemini-cli` npm
 * package. They are baked into every copy of that package and are NOT
 * confidential — desktop OAuth clients have no secret-keeping requirement
 * (PKCE provides the security). Shipping them here matches the pattern
 * `opencode-gemini-auth` and Hermes Agent already use.
 *
 * Source: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts
 *
 * Both literals are overridable via env vars (`CLEO_GEMINI_CLIENT_ID` /
 * `CLEO_GEMINI_CLIENT_SECRET`) so power users can substitute their own
 * Google Cloud Console-issued desktop client.
 *
 * ## Why a dedicated fetch instead of `refreshPkceToken`
 *
 * The generic {@link refreshPkceToken} helper only POSTs
 * `grant_type=refresh_token`, `client_id`, and `refresh_token` — Google
 * additionally requires `client_secret` in the form body for refreshes that
 * use the public desktop client. Rather than overload the generic helper
 * with a Google-specific param, this module ships its own thin POST that
 * mirrors gemini-cli's exact request shape.
 *
 * @module llm/oauth/google-pkce
 * @task T9418
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { extractOAuthErrorDetail } from './pkce.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Google's OAuth 2.0 token endpoint.
 *
 * Same endpoint used for both `authorization_code` and `refresh_token`
 * grants. Constants live in this module (not a shared registry) so the
 * Google flow can evolve independently of the generic PKCE helpers.
 *
 * @task T9418
 */
export const GOOGLE_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Env var that overrides {@link DEFAULT_GOOGLE_CLIENT_ID}.
 * @task T9418
 */
export const ENV_GOOGLE_CLIENT_ID = 'CLEO_GEMINI_CLIENT_ID';

/**
 * Env var that overrides {@link DEFAULT_GOOGLE_CLIENT_SECRET}.
 * @task T9418
 */
export const ENV_GOOGLE_CLIENT_SECRET = 'CLEO_GEMINI_CLIENT_SECRET';

// Public gemini-cli desktop OAuth client — composed piecewise to keep the
// constants readable and to pair each piece with an explicit "this is NOT
// confidential" comment. See the module docstring above for the rationale.
const _PUBLIC_CLIENT_ID_PROJECT_NUM = '681255809395';
const _PUBLIC_CLIENT_ID_HASH = 'oo8ft2oprdrnp9e3aqf6av3hmdib135j';
const _PUBLIC_CLIENT_SECRET_SUFFIX = '4uHgMPm-1o7Sk-geV6Cu5clXFsxl';

/**
 * Public Google OAuth desktop client ID baked into `@google/gemini-cli`.
 *
 * NOT confidential — desktop OAuth clients have no secret-keeping
 * requirement. Override via `CLEO_GEMINI_CLIENT_ID` for power users who
 * want to substitute their own Google Cloud Console-issued client.
 *
 * @task T9418
 */
export const DEFAULT_GOOGLE_CLIENT_ID = `${_PUBLIC_CLIENT_ID_PROJECT_NUM}-${_PUBLIC_CLIENT_ID_HASH}.apps.googleusercontent.com`;

/**
 * Public Google OAuth desktop client secret baked into `@google/gemini-cli`.
 *
 * NOT confidential — see {@link DEFAULT_GOOGLE_CLIENT_ID}. Google's token
 * endpoint accepts the refresh-token grant with `client_secret` present even
 * for desktop clients.
 *
 * @task T9418
 */
export const DEFAULT_GOOGLE_CLIENT_SECRET = `GOCSPX-${_PUBLIC_CLIENT_SECRET_SUFFIX}`;

/**
 * Default expiry buffer applied when Google omits `expires_in` from the
 * refresh response. One hour matches gemini-cli's own default and gives the
 * pool plenty of headroom before the next refresh.
 *
 * @task T9418
 */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of a successful Google access-token refresh.
 *
 * `expiresAt` is unix epoch **milliseconds** (the same unit
 * `StoredCredential.expiresAt` uses). Callers can pass it straight through
 * to `addCredential` without unit conversion.
 *
 * @task T9418
 */
export interface RefreshedGoogleToken {
  /** Freshly-issued bearer access token. */
  accessToken: string;
  /** Unix epoch ms when the access token expires. */
  expiresAt: number;
  /**
   * Refresh token returned by Google.
   *
   * Google occasionally rotates refresh tokens; when the response includes
   * one, the seeder MUST persist it so the next refresh uses the latest
   * value. When absent the caller keeps the existing refresh token.
   */
  refreshToken?: string;
}

/**
 * Refresh a Google OAuth access token using a stored refresh token.
 *
 * POSTs `grant_type=refresh_token` plus the public gemini-cli client
 * credentials to Google's token endpoint and converts the resulting
 * `expires_in` (seconds) into an absolute `expiresAt` (epoch milliseconds).
 *
 * Env-var overrides (`CLEO_GEMINI_CLIENT_ID` / `CLEO_GEMINI_CLIENT_SECRET`)
 * are honoured when present; otherwise the shipped public defaults apply.
 *
 * All HTTP calls use `globalThis.fetch` so tests can intercept them via
 * `vi.spyOn(globalThis, 'fetch')` — no real network traffic.
 *
 * @param refreshToken - Long-lived refresh token from a prior login flow.
 *   MUST be non-empty; an empty value throws synchronously without making
 *   a network call.
 * @returns Fresh access token + computed absolute expiry.
 * @throws {Error} When `refreshToken` is empty, the token endpoint returns
 *   a non-2xx response, or the payload lacks an `access_token`.
 *
 * @task T9418
 */
export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<RefreshedGoogleToken> {
  if (!refreshToken) {
    throw new Error('Google OAuth refresh failed: refresh_token is empty');
  }

  const clientId = (process.env[ENV_GOOGLE_CLIENT_ID] ?? '').trim() || DEFAULT_GOOGLE_CLIENT_ID;
  const clientSecret =
    (process.env[ENV_GOOGLE_CLIENT_SECRET] ?? '').trim() || DEFAULT_GOOGLE_CLIENT_SECRET;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const resp = await globalThis.fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const detail = await extractOAuthErrorDetail(resp);
    throw new Error(`Google OAuth refresh failed: HTTP ${resp.status}${detail}`);
  }

  const parsed = (await resp.json()) as Record<string, unknown>;
  const accessToken = parsed['access_token'];
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Google OAuth refresh response missing access_token');
  }

  const expiresInRaw = parsed['expires_in'];
  const expiresInSeconds =
    typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
      ? expiresInRaw
      : DEFAULT_EXPIRES_IN_SECONDS;
  const expiresAt = Date.now() + expiresInSeconds * 1000;

  const rotated = parsed['refresh_token'];
  const refreshTokenOut = typeof rotated === 'string' && rotated ? rotated : undefined;

  return {
    accessToken,
    expiresAt,
    refreshToken: refreshTokenOut,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
