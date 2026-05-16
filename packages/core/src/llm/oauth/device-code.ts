/**
 * Generic OAuth 2.0 Device Authorization Grant (RFC 8628) flow runner.
 *
 * Implements the two-step device-code protocol:
 *   1. POST to the device authorization endpoint → receive `device_code`,
 *      `user_code`, `verification_uri`, `expires_in`, `interval`.
 *   2. Poll the token endpoint every `interval` seconds until the user
 *      approves, the code expires, or a non-recoverable error is returned.
 *
 * ## Provider scope
 *
 * Device-code OAuth is used by **kimi-code** only. Anthropic uses RFC 7636
 * PKCE (see `pkce.ts` and `builtin/anthropic.ts`). The `anthropic` preset
 * was removed in T9326 — PKCE is the canonical Anthropic OAuth path per T9302.
 *
 * @module llm/oauth/device-code
 * @task T9321
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for a device-code OAuth flow.
 *
 * All URLs and client credentials are provider-specific; callers can pass
 * a preset from `getDeviceCodeConfig()` or build a custom config for any
 * provider that supports RFC 8628.
 */
export interface DeviceCodeConfig {
  /** Provider name (used only for logging / error messages). */
  provider: 'kimi-code' | string;
  /**
   * Device authorization endpoint (RFC 8628 §3.1).
   *
   * POST with `client_id` (and optionally `scope`) → returns
   * `device_code`, `user_code`, `verification_uri`, etc.
   */
  deviceCodeUrl: string;
  /**
   * Token polling endpoint.
   *
   * POST with `grant_type=urn:ietf:params:oauth:grant-type:device_code`,
   * `client_id`, and `device_code`.
   */
  tokenUrl: string;
  /** OAuth client ID registered with the provider. */
  clientId: string;
  /** Space-separated OAuth scopes to request. Optional. */
  scope?: string;
  /**
   * Additional HTTP headers to include on every request.
   *
   * Used to pass provider-specific versioning headers (e.g. Anthropic's
   * `anthropic-version`).
   */
  defaultHeaders?: Record<string, string>;
}

/**
 * Response from the device authorization endpoint (RFC 8628 §3.2).
 */
export interface DeviceCodeStartResponse {
  /** Opaque device code used when polling the token endpoint. */
  deviceCode: string;
  /**
   * Short, human-readable code the user enters at `verificationUri`.
   *
   * Typically 8 characters (e.g. `ABCD-1234`).
   */
  userCode: string;
  /** URL the user should visit to enter `userCode`. */
  verificationUri: string;
  /**
   * Complete verification URI with the user code pre-filled.
   *
   * Not all providers return this field; falls back to `verificationUri`
   * when absent.
   */
  verificationUriComplete?: string;
  /** Seconds until the device code + user code expire. */
  expiresIn: number;
  /** Minimum polling interval in seconds (RFC 8628 §3.2). */
  interval: number;
}

/**
 * Successful token response from the device-code polling endpoint.
 */
export interface DeviceCodeTokenResponse {
  /** Bearer access token. */
  accessToken: string;
  /**
   * Refresh token (if the provider returns one).
   *
   * Not all providers include a refresh token in the device-code flow.
   * When present, callers SHOULD store it for later token refresh.
   */
  refreshToken?: string;
  /** Seconds until `accessToken` expires. `undefined` when not provided. */
  expiresIn?: number;
  /** Token type (virtually always `'bearer'`). */
  tokenType: string;
}

// ---------------------------------------------------------------------------
// Internal error types
// ---------------------------------------------------------------------------

/**
 * Thrown by `pollForToken` when the device code expires before the user
 * approves the request.
 */
export class DeviceCodeTimeoutError extends Error {
  readonly provider: string;
  readonly elapsed: number;

  constructor(provider: string, elapsed: number) {
    super(
      `Device code authorization timed out after ${elapsed}s waiting for user approval (provider: ${provider})`,
    );
    this.name = 'DeviceCodeTimeoutError';
    this.provider = provider;
    this.elapsed = elapsed;
  }
}

/**
 * Thrown by `pollForToken` when the provider returns an unrecoverable error
 * (anything other than `authorization_pending` or `slow_down`).
 */
export class DeviceCodeAuthError extends Error {
  readonly provider: string;
  readonly errorCode: string;

  constructor(provider: string, errorCode: string, description: string) {
    super(
      `Device code authorization failed (provider: ${provider}): ${errorCode} — ${description}`,
    );
    this.name = 'DeviceCodeAuthError';
    this.provider = provider;
    this.errorCode = errorCode;
  }
}

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

/**
 * Build a `DeviceCodeConfig` for a named provider.
 *
 * Currently only `'kimi-code'` is wired. Anthropic uses PKCE, not
 * device-code — see `pkce.ts` and `builtin/anthropic.ts`.
 *
 * @throws {Error} When `provider` is not a known preset.
 */
export function getDeviceCodeConfig(provider: 'kimi-code' | string): DeviceCodeConfig {
  if (provider === 'kimi-code') {
    return getKimiCodeDeviceCodeConfig();
  }
  throw new Error(
    `No device-code config preset for provider '${provider}'. ` +
      `Pass a full DeviceCodeConfig object to startDeviceCodeFlow() directly.`,
  );
}

/**
 * Build the `DeviceCodeConfig` for Kimi Code (kimi.com/code).
 *
 * Authentication endpoints are hosted at `auth.kimi.com` (override via
 * `KIMI_CODE_OAUTH_HOST` env var). The shared community client ID is reused
 * by kimi-cli and other integrations — no private registration required.
 *
 * Token lifecycle:
 *   - Access token: ~15 minutes
 *   - Refresh token: ~30 days
 *   - Recommended refresh strategy: 50% of lifetime or 300s, whichever is larger
 *
 * After OAuth completes, the resulting bearer token targets
 * `https://api.kimi.com/coding` (Anthropic Messages protocol). The six
 * mandatory `X-Msh-*` headers — built by {@link getKimiCodeMshHeaders} — MUST
 * be merged into every chat request alongside the bearer token.
 *
 * @returns Device-code configuration for Kimi Code OAuth.
 *
 * @task T9321
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see https://github.com/gsd-build/gsd-2/issues/4642 — design reference
 * @see MoonshotAI/kimi-cli `src/kimi_cli/auth/oauth.py` — protocol reference
 */
export function getKimiCodeDeviceCodeConfig(): DeviceCodeConfig {
  const host = process.env['KIMI_CODE_OAUTH_HOST'] ?? 'https://auth.kimi.com';
  return {
    provider: 'kimi-code',
    deviceCodeUrl: `${host}/api/oauth/device_authorization`,
    tokenUrl: `${host}/api/oauth/token`,
    // Public client ID shared by kimi-cli and community integrations.
    // The Kimi backend does NOT require a per-app client registration for
    // the device-code grant.
    clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
    // Scope is returned by the server as `kimi-code` but is not sent on the
    // device-authorization request per RFC 8628 §3.1 (optional). Including
    // it has no effect; the server ignores unknown scopes.
  };
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

/** Maximum number of consecutive network-error retries during polling. */
const MAX_NETWORK_RETRIES = 3;

/** Cap on the polling interval (seconds), regardless of `slow_down` growth. */
const POLL_INTERVAL_CAP_SECONDS = 30;

/**
 * Build the base headers for a device-code request.
 *
 * Merges `Content-Type` with provider-specific `defaultHeaders`.
 */
function buildHeaders(cfg: DeviceCodeConfig): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    ...cfg.defaultHeaders,
  };
}

/**
 * Encode a plain record as `application/x-www-form-urlencoded`.
 */
function encodeForm(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the device-code OAuth flow.
 *
 * POSTs to `cfg.deviceCodeUrl` with the client ID and optional scope. On
 * success returns the structured response that the CLI prints to the user
 * (`userCode`, `verificationUri`, etc.) and that `pollForToken` needs to
 * poll with.
 *
 * @throws {Error} On HTTP errors or a response that is missing required fields.
 */
export async function startDeviceCodeFlow(cfg: DeviceCodeConfig): Promise<DeviceCodeStartResponse> {
  const body: Record<string, string> = { client_id: cfg.clientId };
  if (cfg.scope) body['scope'] = cfg.scope;

  const resp = await fetch(cfg.deviceCodeUrl, {
    method: 'POST',
    headers: buildHeaders(cfg),
    body: encodeForm(body),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = (await resp.json()) as Record<string, unknown>;
      detail = ` — ${String(errBody['error_description'] ?? errBody['error'] ?? '')}`;
    } catch {
      /* ignore — non-JSON body */
    }
    throw new Error(
      `Device code request failed for provider '${cfg.provider}': HTTP ${resp.status}${detail}`,
    );
  }

  const data = (await resp.json()) as Record<string, unknown>;

  const deviceCode = data['device_code'];
  const userCode = data['user_code'];
  const verificationUri = data['verification_uri'];
  const expiresIn = data['expires_in'];
  const interval = data['interval'];

  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    typeof expiresIn !== 'number' ||
    typeof interval !== 'number'
  ) {
    throw new Error(
      `Device code response from '${cfg.provider}' missing required fields. ` +
        `Got: ${JSON.stringify(Object.keys(data))}`,
    );
  }

  const verificationUriComplete =
    typeof data['verification_uri_complete'] === 'string'
      ? data['verification_uri_complete']
      : undefined;

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn,
    interval,
  };
}

/**
 * Poll the token endpoint until the user approves, the code expires, or an
 * unrecoverable error is received (RFC 8628 §3.4).
 *
 * Handles the two recoverable error codes:
 *   - `authorization_pending` — user has not yet approved; continue polling.
 *   - `slow_down` — increase the polling interval by 1 second, then continue.
 *
 * Network errors are retried up to `MAX_NETWORK_RETRIES` times before being
 * re-thrown.
 *
 * @param cfg - Device-code flow configuration (same object as passed to
 *   `startDeviceCodeFlow`).
 * @param startResp - The response returned by `startDeviceCodeFlow`.
 * @param options.onPending - Optional callback invoked on each pending poll
 *   iteration with `(elapsedSeconds, totalExpiresIn)`. Used by the CLI to
 *   print a live progress counter.
 * @param options.signal - Optional `AbortSignal` for cooperative cancellation.
 *
 * @throws {DeviceCodeTimeoutError} When `expiresIn` is reached without approval.
 * @throws {DeviceCodeAuthError} When the provider returns a non-recoverable error.
 * @throws {Error} When network retries are exhausted.
 */
export async function pollForToken(
  cfg: DeviceCodeConfig,
  startResp: DeviceCodeStartResponse,
  options?: {
    onPending?: (elapsed: number, expiresIn: number) => void;
    signal?: AbortSignal;
  },
): Promise<DeviceCodeTokenResponse> {
  const { deviceCode, expiresIn, interval } = startResp;
  const { onPending, signal } = options ?? {};

  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = Math.max(1, Math.min(interval, POLL_INTERVAL_CAP_SECONDS));
  let consecutiveNetworkErrors = 0;
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error(`Device code polling aborted for provider '${cfg.provider}'`);
    }

    let resp: Response;
    try {
      resp = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: buildHeaders(cfg),
        body: encodeForm({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: cfg.clientId,
          device_code: deviceCode,
        }),
        signal,
      });
      // Reset retry counter on any HTTP response (even error responses).
      consecutiveNetworkErrors = 0;
    } catch (err) {
      consecutiveNetworkErrors++;
      if (consecutiveNetworkErrors > MAX_NETWORK_RETRIES) {
        throw err;
      }
      // Transient network error — wait one interval then retry.
      await sleep(currentInterval * 1000);
      continue;
    }

    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>;
      const accessToken = data['access_token'];
      if (typeof accessToken !== 'string' || !accessToken) {
        throw new Error(
          `Token endpoint for '${cfg.provider}' returned HTTP 200 but no access_token`,
        );
      }
      return {
        accessToken,
        refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : undefined,
        expiresIn: typeof data['expires_in'] === 'number' ? data['expires_in'] : undefined,
        tokenType: typeof data['token_type'] === 'string' ? data['token_type'] : 'bearer',
      };
    }

    // Non-200 — parse the error payload.
    let errorPayload: Record<string, unknown>;
    try {
      errorPayload = (await resp.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body — treat as unrecoverable.
      throw new Error(
        `Token endpoint for '${cfg.provider}' returned HTTP ${resp.status} with non-JSON body`,
      );
    }

    const errorCode = String(errorPayload['error'] ?? '');
    const errorDescription = String(
      errorPayload['error_description'] ?? 'Unknown authorization error',
    );

    if (errorCode === 'authorization_pending') {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      onPending?.(elapsed, expiresIn);
      await sleep(currentInterval * 1000);
      continue;
    }

    if (errorCode === 'slow_down') {
      // RFC 8628 §3.4: increase interval by at least 5 seconds.
      currentInterval = Math.min(currentInterval + 5, POLL_INTERVAL_CAP_SECONDS);
      await sleep(currentInterval * 1000);
      continue;
    }

    // Any other error code is unrecoverable.
    throw new DeviceCodeAuthError(cfg.provider, errorCode, errorDescription);
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  throw new DeviceCodeTimeoutError(cfg.provider, elapsed);
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep helper (wraps `setTimeout`).
 *
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
