/**
 * Cleo Nexus account engine: device-code login, logout and session status.
 *
 * The Nexus API is a better-auth app (cleo-nexus `apps/api/src/auth.ts`):
 *
 * - `POST /api/auth/device/code` and `POST /api/auth/device/token` run the
 *   RFC 8628 grant for the single allowed client id `cleo-cli`, with RFC form
 *   bodies (cleo-nexus #11). The access token it returns is a better-auth
 *   session token.
 * - The bearer plugin accepts that token as `Authorization: Bearer <token>` on
 *   every `/v1` route and on `POST /api/auth/sign-out`, which deletes the
 *   session server-side.
 * - `GET /v1/account/me` names the user and their organizations; a dead
 *   session answers 401 `E_UNAUTHENTICATED`.
 *
 * The device-code protocol itself is NOT implemented here: it is the shared
 * runner in `../llm/oauth/device-code.ts` (also used by the kimi-code LLM
 * login). This module adds the Nexus endpoints, token storage and account
 * lookup. The CLI (`cleo login nexus`, `cleo logout`, `cleo status`) and the
 * `nexus-account` setup section are thin callers.
 *
 * No function here logs, and no result carries the token.
 *
 * @task T12712
 * @epic T12322
 */

import {
  NEXUS_CLI_CLIENT_ID,
  NEXUS_DEFAULT_API_URL,
  type NexusAccountErrorCode,
  type NexusAccountMe,
  type NexusAccountOrganization,
  type NexusAccountStatus,
  type NexusLoginResult,
  type NexusLogoutResult,
  nexusAccountMeSchema,
} from '@cleocode/contracts';
import {
  DeviceCodeAuthError,
  type DeviceCodeConfig,
  type DeviceCodeStartResponse,
  DeviceCodeTimeoutError,
  pollForToken,
  startDeviceCodeFlow,
} from '../llm/oauth/device-code.js';
import { type FetchLike, Http, isSecureUrl, NexusError } from './http.js';
import {
  FileNexusTokenStore,
  type NexusTokenStore,
  type SealedNexusSession,
} from './nexus-credentials.js';

/** Environment override for the default API origin (e.g. staging). */
export const NEXUS_API_URL_ENV = 'CLEO_NEXUS_API_URL';

/** Default time budget for a live status check. */
export const NEXUS_STATUS_TIMEOUT_MS = 1_500;

/** A Nexus account flow failure with a stable code. Never carries a token. */
export class NexusAccountError extends Error {
  /**
   * @param code - Stable error code.
   * @param message - Human message.
   * @param fix - Optional remedy for the user.
   */
  constructor(
    readonly code: NexusAccountErrorCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'NexusAccountError';
  }
}

/** Dependencies shared by every flow; all optional (tests inject them). */
export interface NexusFlowOptions {
  /** API URL; defaults to `$CLEO_NEXUS_API_URL`, then {@link NEXUS_DEFAULT_API_URL}. */
  apiUrl?: string;
  /** Token store; defaults to the 0600 file store. */
  store?: NexusTokenStore;
  /** `fetch` override. */
  fetch?: FetchLike;
}

/** Options for {@link loginToNexus}. */
export interface NexusLoginOptions extends NexusFlowOptions {
  /** Called once with the user code and verification URL to show the user. */
  onCode?: (code: DeviceCodeStartResponse) => void;
  /** Called on every pending poll with elapsed and total seconds. */
  onPending?: (elapsed: number, expiresIn: number) => void;
  /** Cancels polling. */
  signal?: AbortSignal;
  /** Wait override for polling (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Options for {@link getNexusAccountStatus}. */
export interface NexusStatusOptions {
  /** Report only this origin. Default: every stored origin, else the default origin. */
  apiUrl?: string;
  /** Token store. */
  store?: NexusTokenStore;
  /** `fetch` override. */
  fetch?: FetchLike;
  /** Check each session against the API (default `true`). */
  live?: boolean;
  /** Time budget per live check. */
  timeoutMs?: number;
}

/**
 * Resolve and validate the API URL to its origin.
 *
 * @param raw - `--api-url`, or `undefined` for `$CLEO_NEXUS_API_URL` / the default.
 * @returns The origin, e.g. `https://api.cleocode.dev`.
 * @throws {NexusAccountError} `E_NEXUS_INVALID_API_URL` for anything but an
 *   https URL (http only on loopback) without credentials in it.
 */
export function resolveNexusApiUrl(raw?: string): string {
  const candidate = (raw ?? process.env[NEXUS_API_URL_ENV] ?? NEXUS_DEFAULT_API_URL).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new NexusAccountError('E_NEXUS_INVALID_API_URL', `invalid Nexus API URL: ${candidate}`);
  }
  if (url.username || url.password || !isSecureUrl(url.origin)) {
    throw new NexusAccountError(
      'E_NEXUS_INVALID_API_URL',
      'the Nexus API URL must be https:// (http:// only for localhost) with no user:password',
    );
  }
  return url.origin;
}

/**
 * The shared device-code runner's config for a Nexus origin.
 *
 * @param apiUrl - Resolved API origin.
 * @param fetchImpl - Optional `fetch` override.
 * @returns A {@link DeviceCodeConfig} for the better-auth device endpoints.
 */
export function nexusDeviceCodeConfig(apiUrl: string, fetchImpl?: FetchLike): DeviceCodeConfig {
  return {
    provider: 'cleo-nexus',
    deviceCodeUrl: `${apiUrl}/api/auth/device/code`,
    tokenUrl: `${apiUrl}/api/auth/device/token`,
    clientId: NEXUS_CLI_CLIENT_ID,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

/**
 * The organization to show for an account: the personal one, else the first.
 *
 * @param me - Parsed `/v1/account/me`.
 * @returns The primary organization, or `null`.
 */
export function primaryNexusOrganization(me: NexusAccountMe): NexusAccountOrganization | null {
  return me.organizations.find((o) => o.personal) ?? me.organizations[0] ?? null;
}

/** `GET /v1/account/me` with a bearer token. */
async function fetchAccountMe(
  apiUrl: string,
  token: string,
  opts: { fetch?: FetchLike; maxAttempts?: number } = {},
): Promise<NexusAccountMe> {
  const http = new Http({
    baseUrl: apiUrl,
    token,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    maxAttempts: opts.maxAttempts ?? 2,
  });
  return http.request('GET', '/v1/account/me', nexusAccountMeSchema);
}

/** Map a device-code runner failure to a Nexus error. */
function toLoginError(err: unknown): NexusAccountError {
  if (err instanceof DeviceCodeTimeoutError) {
    return new NexusAccountError(
      'E_NEXUS_DEVICE_CODE_EXPIRED',
      'the device code expired before it was approved',
      'run `cleo login nexus` again and approve the code sooner',
    );
  }
  if (err instanceof DeviceCodeAuthError) {
    if (err.errorCode === 'expired_token') {
      return new NexusAccountError(
        'E_NEXUS_DEVICE_CODE_EXPIRED',
        'the device code expired before it was approved',
        'run `cleo login nexus` again and approve the code sooner',
      );
    }
    if (err.errorCode === 'access_denied') {
      return new NexusAccountError(
        'E_NEXUS_ACCESS_DENIED',
        'the sign-in request was denied in the browser',
      );
    }
    return new NexusAccountError('E_NEXUS_DEVICE_CODE_FAILED', err.message);
  }
  return new NexusAccountError(
    'E_NEXUS_DEVICE_CODE_FAILED',
    `polling for the Nexus token failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * Sign in to a Cleo Nexus account with the device-code grant and store the
 * session token (0600, keyed by API origin).
 *
 * @param opts - API URL, store, UI hooks and test overrides.
 * @returns The secret-free login result.
 * @throws {NexusAccountError} On a start, poll, denial or expiry failure.
 */
export async function loginToNexus(opts: NexusLoginOptions = {}): Promise<NexusLoginResult> {
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const store = opts.store ?? new FileNexusTokenStore();
  const cfg = nexusDeviceCodeConfig(apiUrl, opts.fetch);

  let start: DeviceCodeStartResponse;
  try {
    start = await startDeviceCodeFlow(cfg);
  } catch (err) {
    throw new NexusAccountError(
      'E_NEXUS_DEVICE_CODE_START_FAILED',
      `could not start the Nexus sign-in at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
      'check the API URL and your network, then retry',
    );
  }
  opts.onCode?.(start);

  let token: Awaited<ReturnType<typeof pollForToken>>;
  try {
    token = await pollForToken(cfg, start, {
      ...(opts.onPending ? { onPending: opts.onPending } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  } catch (err) {
    throw toLoginError(err);
  }

  const warnings: string[] = [];
  let me: NexusAccountMe | null = null;
  try {
    me = await fetchAccountMe(apiUrl, token.accessToken, opts.fetch ? { fetch: opts.fetch } : {});
  } catch (err) {
    warnings.push(
      `signed in, but the account lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const organization = me ? primaryNexusOrganization(me) : null;
  const expiresAt =
    typeof token.expiresIn === 'number'
      ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
      : null;

  await store.put(apiUrl, {
    token: token.accessToken,
    tokenType: token.tokenType,
    expiresAt,
    user: me?.user ?? null,
    organization,
  });

  return {
    apiUrl,
    user: me?.user ?? null,
    organization,
    expiresAt,
    credentialsPath: store.location,
    warnings,
  };
}

/**
 * Sign out: revoke the session server-side (`POST /api/auth/sign-out` with the
 * bearer token), then delete it locally. The local token is deleted even when
 * revocation fails, and the failure is reported.
 *
 * @param opts - API URL, store and test overrides.
 * @returns The logout result.
 */
export async function logoutFromNexus(opts: NexusFlowOptions = {}): Promise<NexusLogoutResult> {
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const store = opts.store ?? new FileNexusTokenStore();
  const session = await store.get(apiUrl);
  if (!session) {
    return { apiUrl, removedLocally: false, revocation: 'skipped', warnings: [] };
  }

  const warnings: string[] = [];
  let revocation: NexusLogoutResult['revocation'];
  try {
    revocation = await revokeSession(apiUrl, session, opts.fetch);
  } catch (err) {
    revocation = 'failed';
    warnings.push(
      `server-side sign-out failed (${err instanceof Error ? err.message : String(err)}); the local token was deleted`,
    );
  }
  const removedLocally = await store.delete(apiUrl);
  return { apiUrl, removedLocally, revocation, warnings };
}

/** `POST /api/auth/sign-out` with the bearer token. Never follows redirects. */
async function revokeSession(
  apiUrl: string,
  session: SealedNexusSession,
  fetchImpl?: FetchLike,
): Promise<'revoked' | 'already-invalid'> {
  const doFetch = fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const res = await doFetch(`${apiUrl}/api/auth/sign-out`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.bearer()}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: '{}',
    redirect: 'error',
  });
  if (res.status === 401) return 'already-invalid';
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return 'revoked';
}

/** Build one status row from a stored session and an optional live check. */
function statusRow(
  apiUrl: string,
  state: NexusAccountStatus['state'],
  session: SealedNexusSession | null,
  me: NexusAccountMe | null,
): NexusAccountStatus {
  const email = me?.user.email ?? session?.user?.email ?? null;
  const org = (me ? primaryNexusOrganization(me) : session?.organization)?.name ?? null;
  const who = `${email ?? 'unknown user'}${org ? ` (${org})` : ''}`;
  const summary =
    state === 'signed-in'
      ? `signed in as ${who}`
      : state === 'unverified'
        ? `signed in as ${who}; not verified (API unreachable)`
        : state === 'expired'
          ? 'session expired; run `cleo login nexus`'
          : 'not signed in';
  return {
    apiUrl,
    state,
    email: state === 'not-signed-in' ? null : email,
    organization: state === 'not-signed-in' ? null : org,
    expiresAt: session?.expiresAt ?? null,
    summary,
  };
}

/** Check one stored session against the API. 401 means expired, never a crash. */
async function checkSession(
  session: SealedNexusSession,
  opts: NexusStatusOptions,
): Promise<NexusAccountStatus> {
  if (opts.live === false) return statusRow(session.apiUrl, 'unverified', session, null);
  const timeoutMs = opts.timeoutMs ?? NEXUS_STATUS_TIMEOUT_MS;
  const base = opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const timed: FetchLike = (input, init) =>
    base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  try {
    const me = await fetchAccountMe(session.apiUrl, session.bearer(), {
      fetch: timed,
      maxAttempts: 1,
    });
    return statusRow(session.apiUrl, 'signed-in', session, me);
  } catch (err) {
    if (err instanceof NexusError && err.status === 401) {
      return statusRow(session.apiUrl, 'expired', session, null);
    }
    return statusRow(session.apiUrl, 'unverified', session, null);
  }
}

/**
 * Secret-free status rows for `cleo status` and `cleo auth list`: one per
 * stored session, or one "not signed in" row for the default origin. Makes a
 * network call only when a token is stored.
 *
 * @param opts - Origin filter, store, liveness and test overrides.
 * @returns Status rows, sorted by origin.
 */
export async function getNexusAccountStatus(
  opts: NexusStatusOptions = {},
): Promise<NexusAccountStatus[]> {
  const store = opts.store ?? new FileNexusTokenStore();
  const only = opts.apiUrl !== undefined ? resolveNexusApiUrl(opts.apiUrl) : null;
  const sessions = (await store.list()).filter((s) => only === null || s.apiUrl === only);
  if (sessions.length === 0) {
    return [statusRow(only ?? resolveNexusApiUrl(), 'not-signed-in', null, null)];
  }
  return Promise.all(sessions.map((s) => checkSession(s, opts)));
}

/**
 * The stored session for an origin, or a `E_NEXUS_NOT_SIGNED_IN` error.
 *
 * @param apiUrl - Resolved API origin.
 * @param store - Token store.
 * @returns The sealed session.
 * @throws {NexusAccountError} When no session is stored.
 */
export async function requireNexusSession(
  apiUrl: string,
  store: NexusTokenStore,
): Promise<SealedNexusSession> {
  const session = await store.get(apiUrl);
  if (!session) {
    throw new NexusAccountError(
      'E_NEXUS_NOT_SIGNED_IN',
      `not signed in to Cleo Nexus at ${apiUrl}`,
      apiUrl === NEXUS_DEFAULT_API_URL
        ? 'run `cleo login nexus`'
        : `run \`cleo login nexus --api-url ${apiUrl}\``,
    );
  }
  return session;
}
