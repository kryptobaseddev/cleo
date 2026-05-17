/**
 * Credential seeder for the CLEO-owned Google PKCE token
 * (E-CONFIG-AUTH-UNIFY E2a / T9418).
 *
 * Per spec OQ-4 (resolved in the T9418 task brief): CLEO does NOT read
 * gemini-cli's npm package token file directly — sharing a refresh token
 * across two clients causes single-use `refresh_token_reused` race
 * failures. Instead CLEO runs its own Google OAuth PKCE flow against the
 * public gemini-cli desktop client and stores tokens at
 * `${getCleoHome()}/google_oauth.json`.
 *
 * The interactive login flow (browser callback server, code exchange) is
 * deferred to E3's `cleo llm login gemini` command. This seeder ships only
 * the **read + refresh** path the pool needs at load time.
 *
 * ## File path & shape
 *
 * `${getCleoHome()}/google_oauth.json`, chmod 0o600 (writer is the
 * interactive login flow — out of scope here):
 *
 * ```json
 * {
 *   "access_token": "ya29...",
 *   "refresh_token": "1//...",
 *   "expires_at": 1744848000000,   // unix MILLIseconds
 *   "email": "user@example.com"
 * }
 * ```
 *
 * The shape is intentionally flatter than Hermes' "packed refresh" format
 * because CLEO does not need to carry GCP project IDs through the token
 * file — the Gemini transport reads project context from
 * `~/.cleo/config.json` instead. Extra keys (e.g. a stale `project_id`)
 * are tolerated and ignored.
 *
 * ## Refresh-on-expiry
 *
 * When `expires_at` is in the past (or within the 60-second clock-skew
 * buffer), the seeder calls {@link refreshGoogleAccessToken} to mint a
 * fresh access token. **The refreshed token file is NOT written back to
 * disk by this seeder** — the credential store keeps the canonical copy
 * and the interactive login flow (E3) owns disk writes. The seeder simply
 * emits the freshly-refreshed entry so the pool starts the session with a
 * live token.
 *
 * When refresh fails (revoked token, network out, etc.) the seeder emits
 * the stored entry as-is with a warning; the credential pool's mark-bad
 * machinery will quarantine it on the first 401 response.
 *
 * @module llm/credential-seeders/gemini-cli-seeder
 * @task T9418
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import { refreshGoogleAccessToken } from '../oauth/google-pkce.js';
import type { CredentialSeeder, SeederCredentialEntry, SeederResult } from './index.js';

/**
 * Clock-skew buffer (ms) before `expires_at` at which we proactively
 * refresh. 60 seconds matches Hermes' default and gives the first
 * downstream LLM call enough headroom to complete.
 *
 * @internal
 * @task T9418
 */
const REFRESH_SKEW_MS = 60_000;

/**
 * Resolve the CLEO-owned Google OAuth token path.
 *
 * Routed through `getCleoHome()` so the `CLEO_HOME` env override and
 * platform-aware XDG resolution apply uniformly (T9403 / T9405). Exposed
 * for tests.
 *
 * @internal
 * @task T9418
 */
export function getGoogleOauthPath(): string {
  return join(getCleoHome(), 'google_oauth.json');
}

/**
 * On-disk shape of `google_oauth.json`.
 *
 * `expires_at` is unix epoch **milliseconds** — same unit as
 * `StoredCredential.expiresAt`, no conversion required. Optional fields
 * are tolerated as `undefined`; missing `access_token` or `refresh_token`
 * makes the file un-usable and the seeder skips it.
 *
 * @internal
 * @task T9418
 */
interface GoogleOauthFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  email?: string;
}

/**
 * Parse the on-disk JSON into a narrowed shape. Returns `null` when the
 * file is malformed (extras tolerated, missing required fields rejected).
 *
 * @internal
 * @task T9418
 */
function parseGoogleOauthFile(raw: string): GoogleOauthFile | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return null;
  }
  const obj = json as Record<string, unknown>;
  const out: GoogleOauthFile = {};
  if (typeof obj['access_token'] === 'string') out.access_token = obj['access_token'];
  if (typeof obj['refresh_token'] === 'string') out.refresh_token = obj['refresh_token'];
  if (typeof obj['expires_at'] === 'number' && Number.isFinite(obj['expires_at'])) {
    out.expires_at = obj['expires_at'];
  }
  if (typeof obj['email'] === 'string') out.email = obj['email'];
  return out;
}

/**
 * Credential seeder for the CLEO-owned Google PKCE token store.
 *
 * @task T9418
 */
export class GeminiCliSeeder implements CredentialSeeder {
  readonly sourceId = 'gemini-cli' as const;
  // Provider is `'gemini'` — the canonical id in `ENV_VARS` /
  // `ModelTransport`. `'google'` is the upstream OAuth issuer, not the
  // LLM transport.
  readonly provider = 'gemini';

  /**
   * Read `google_oauth.json` and emit a seeded credential entry,
   * refreshing the access token first when it is expired or near expiry.
   *
   * Never throws — every failure path resolves to `{ entries: [], warnings? }`.
   *
   * @returns Zero or one entry plus optional warnings.
   * @task T9418
   */
  async seed(): Promise<SeederResult> {
    const path = getGoogleOauthPath();
    if (!existsSync(path)) {
      return { entries: [] };
    }

    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      return {
        entries: [],
        warnings: [`gemini-cli: failed to read ${path}: ${(err as Error).message}`],
      };
    }

    const parsed = parseGoogleOauthFile(raw);
    if (!parsed) {
      return {
        entries: [],
        warnings: [`gemini-cli: ${path} is not valid JSON / not an object`],
      };
    }
    if (!parsed.access_token) {
      return {
        entries: [],
        warnings: [`gemini-cli: ${path} is missing access_token`],
      };
    }

    const now = Date.now();
    const needsRefresh =
      typeof parsed.expires_at === 'number' && parsed.expires_at - REFRESH_SKEW_MS <= now;

    // Refresh path — only attempted when we have both an expiry hint and
    // a refresh_token. Without a refresh_token we can only return the
    // existing access token and let the pool's mark-bad machinery
    // quarantine it on the first 401 response.
    if (needsRefresh && parsed.refresh_token) {
      try {
        const refreshed = await refreshGoogleAccessToken(parsed.refresh_token);
        const entry: SeederCredentialEntry = {
          provider: 'gemini',
          label: 'gemini-pkce',
          authType: 'oauth',
          accessToken: refreshed.accessToken,
          expiresAt: refreshed.expiresAt,
          source: 'gemini-cli',
          refreshToken: refreshed.refreshToken ?? parsed.refresh_token,
          ...(parsed.email ? { metadata: { email: parsed.email } } : {}),
        };
        return { entries: [entry] };
      } catch (err) {
        // Refresh failed — fall through to emit the stored (likely-stale)
        // entry with a diagnostic. The pool's first 401 will quarantine
        // it cleanly.
        return {
          entries: [
            {
              provider: 'gemini',
              label: 'gemini-pkce',
              authType: 'oauth',
              accessToken: parsed.access_token,
              expiresAt: parsed.expires_at ?? null,
              source: 'gemini-cli',
              ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}),
              ...(parsed.email ? { metadata: { email: parsed.email } } : {}),
            },
          ],
          warnings: [
            `gemini-cli: refresh failed, using stored access_token (${(err as Error).message})`,
          ],
        };
      }
    }

    // No refresh needed (or no refresh_token on file) — emit as-is.
    const entry: SeederCredentialEntry = {
      provider: 'gemini',
      label: 'gemini-pkce',
      authType: 'oauth',
      accessToken: parsed.access_token,
      expiresAt: parsed.expires_at ?? null,
      source: 'gemini-cli',
      ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}),
      ...(parsed.email ? { metadata: { email: parsed.email } } : {}),
    };
    return { entries: [entry] };
  }
}

/**
 * Module-level singleton registered into `BUILTIN_SEEDERS`.
 *
 * @task T9418
 */
export const geminiCliSeeder: CredentialSeeder = new GeminiCliSeeder();
