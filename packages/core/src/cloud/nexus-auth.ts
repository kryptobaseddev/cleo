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
import { NexusDeviceStore, SealedNexusDevice } from './nexus-device.js';

/** Environment override for the default API origin (e.g. staging). */
export const NEXUS_API_URL_ENV = 'CLEO_NEXUS_API_URL';

/** Default time budget for the server-side revocation at logout. */
export const NEXUS_REVOKE_TIMEOUT_MS = 5_000;

/** Default time budget for a live status check. */
export const NEXUS_STATUS_TIMEOUT_MS = 1_500;

/**
 * What a team member does when only the project owner role can create a
 * project's key: cleo-nexus #35 honours `initialKey`, and a first key, only
 * for an organization owner or admin (T13101).
 */
export const NEXUS_PROJECT_KEY_OWNER_REMEDY =
  'an org owner or admin must create the project key from a signed-in session';

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

/** Options for {@link logoutFromNexus}. */
export interface NexusLogoutOptions extends NexusFlowOptions {
  /** Budget for the revocation call; default {@link NEXUS_REVOKE_TIMEOUT_MS}. */
  revokeTimeoutMs?: number;
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
  /**
   * Report device credentials (`nexus-device.json`) too; default `true`,
   * whatever `CLEO_NEXUS_DEVICE` says. A device credential replaces the 9.24
   * session row of the same user on its origin.
   */
  devices?: boolean;
  /** Device store; defaults to `<cleoHome>/nexus-device.json`. */
  deviceStore?: NexusDeviceStore;
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
 * C0/C1 control characters (ESC, CR, LF, CSI, …), any whitespace, bidi
 * embeddings/overrides/isolates (U+202A–202E, U+2066–2069), zero-width
 * characters (U+200B–200D, U+FEFF) and `\` (which WHATWG URL parsing turns
 * into `/`, so the host a user reads could differ from the one opened).
 */
const UNSAFE_URI_CHARS =
  /[\u0000-\u0020\u007f-\u009f\s\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff\\]/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Refuse a server-supplied verification URL unless it is safe to print and to
 * hand to the OS browser opener:
 *
 * - no control characters or whitespace (terminal injection: ESC, CR, LF, CSI);
 * - no leading `-` (option injection into `open` / `xdg-open`);
 * - `https:` (plain `http:` only when the API itself is a loopback http origin);
 * - no `user:pass@`;
 * - the host is the API's web origin or a subdomain of it: the API host minus a
 *   leading `api.` label (`api.cleocode.dev` → `cleocode.dev`,
 *   `api.staging.cleocode.dev` → `staging.cleocode.dev`). A phishing host, a
 *   `file:` URL or a custom scheme never reaches the screen or the opener.
 *
 * @param uri - `verification_uri` or `verification_uri_complete` as received.
 * @param apiUrl - Resolved API origin.
 * @returns The normalised URL (`new URL(uri).href`): the exact form that was
 *   validated, and the only one to print or open.
 * @throws {NexusAccountError} `E_NEXUS_UNTRUSTED_VERIFICATION_URI`.
 */
export function assertTrustedVerificationUri(uri: string, apiUrl: string): string {
  const refuse = (why: string): never => {
    throw new NexusAccountError(
      'E_NEXUS_UNTRUSTED_VERIFICATION_URI',
      `the server sent an untrusted verification URL (${why}); the login was stopped`,
      'check --api-url; only sign in through the Cleo Nexus web app',
    );
  };
  if (UNSAFE_URI_CHARS.test(uri)) refuse('control characters or whitespace');
  if (uri.startsWith('-')) refuse('leading "-"');
  const url = URL.canParse(uri) ? new URL(uri) : refuse('not a URL');
  const api = new URL(apiUrl);
  const loopbackHttp =
    url.protocol === 'http:' &&
    api.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    LOOPBACK_HOSTS.has(api.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) refuse(`scheme ${url.protocol}`);
  if (url.username || url.password) refuse('credentials in the URL');
  const web = api.hostname.startsWith('api.') ? api.hostname.slice(4) : api.hostname;
  if (url.hostname !== web && !url.hostname.endsWith(`.${web}`)) {
    refuse(`host ${url.hostname} is not ${web}`);
  }
  return url.href;
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
  const token = await runNexusDeviceCode(apiUrl, opts);

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
 * The device-code grant against a Nexus origin (contract §3.3 steps 1 to 3):
 * start, validate and show the verification URL, then poll until the user
 * approves. The session token it returns is held in memory only; the caller
 * decides whether to store it (9.24 behaviour) or enrol a device with it.
 *
 * @param apiUrl - Resolved API origin.
 * @param opts - UI hooks and test overrides.
 * @param scope - Optional OAuth `scope` for `/device/code` (`cleo:device` or `cleo:read-only`).
 * @returns The token response (the session token is its only secret).
 * @throws {NexusAccountError} On a start, poll, denial or expiry failure.
 */
export async function runNexusDeviceCode(
  apiUrl: string,
  opts: NexusLoginOptions,
  scope?: string,
): Promise<Awaited<ReturnType<typeof pollForToken>>> {
  const cfg: DeviceCodeConfig = {
    ...nexusDeviceCodeConfig(apiUrl, opts.fetch),
    ...(scope !== undefined ? { scope } : {}),
  };

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
  // Validate, then show and open only the normalised forms that were checked.
  const shown: DeviceCodeStartResponse = {
    ...start,
    verificationUri: assertTrustedVerificationUri(start.verificationUri, apiUrl),
    ...(start.verificationUriComplete !== undefined
      ? {
          verificationUriComplete: assertTrustedVerificationUri(
            start.verificationUriComplete,
            apiUrl,
          ),
        }
      : {}),
  };
  opts.onCode?.(shown);

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
  return token;
}

/**
 * Sign out: delete the session locally FIRST, then revoke it server-side
 * (`POST /api/auth/sign-out` with the bearer token) within
 * {@link NEXUS_REVOKE_TIMEOUT_MS}. A slow or hung server can delay logout by
 * at most that budget and can never keep the token on disk; a failed
 * revocation is reported. The delete only removes the session that was read,
 * so a login that finished concurrently for the same origin survives.
 *
 * @param opts - API URL, store, revoke budget and test overrides.
 * @returns The logout result.
 */
export async function logoutFromNexus(opts: NexusLogoutOptions = {}): Promise<NexusLogoutResult> {
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const store = opts.store ?? new FileNexusTokenStore();
  const session = await store.get(apiUrl);
  if (!session) {
    return { apiUrl, removedLocally: false, revocation: 'skipped', warnings: [] };
  }

  const removedLocally = await store.delete(apiUrl, session);
  const warnings: string[] = [];
  let revocation: NexusLogoutResult['revocation'];
  try {
    revocation = await signOutNexusSessionToken(
      apiUrl,
      session.bearer(),
      opts.revokeTimeoutMs ?? NEXUS_REVOKE_TIMEOUT_MS,
      opts.fetch,
    );
  } catch (err) {
    revocation = 'failed';
    warnings.push(
      `server-side sign-out failed (${err instanceof Error ? err.message : String(err)}); the local token was deleted`,
    );
  }
  return { apiUrl, removedLocally, revocation, warnings };
}

/**
 * `POST /api/auth/sign-out` with a bearer session token, within `timeoutMs`,
 * which deletes the session server-side. Never follows redirects.
 *
 * @param apiUrl - Resolved API origin.
 * @param bearer - The session token (never logged).
 * @param timeoutMs - Time budget for the call.
 * @param fetchImpl - Optional `fetch` override.
 * @returns `revoked`, or `already-invalid` on a 401.
 * @throws On a network error, a timeout or a non-2xx, non-401 answer.
 */
export async function signOutNexusSessionToken(
  apiUrl: string,
  bearer: string,
  timeoutMs: number,
  fetchImpl?: FetchLike,
): Promise<'revoked' | 'already-invalid'> {
  const doFetch = fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const res = await doFetch(`${apiUrl}/api/auth/sign-out`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
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
 * Check one device credential against the API (E2 `GET /v1/whoami`, the call
 * the device contract prefers for status). A 401 (signed out, revoked or
 * expired) reads as `expired`; no answer reads as `unverified`.
 */
async function checkDevice(
  device: SealedNexusDevice,
  bearer: string,
  opts: NexusStatusOptions,
): Promise<NexusAccountStatus> {
  if (opts.live === false) return statusRow(device.origin, 'unverified', null, null);
  const timeoutMs = opts.timeoutMs ?? NEXUS_STATUS_TIMEOUT_MS;
  const base = opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const http = new Http({
    baseUrl: device.origin,
    token: bearer,
    fetch: (input, init) => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    maxAttempts: 1,
  });
  try {
    const me = await http.request('GET', '/v1/whoami', nexusAccountMeSchema);
    return statusRow(device.origin, 'signed-in', null, me);
  } catch (err) {
    if (err instanceof NexusError && err.status === 401) {
      return statusRow(device.origin, 'expired', null, null);
    }
    return statusRow(device.origin, 'unverified', null, null);
  }
}

/**
 * Secret-free status rows for `cleo status` and `cleo auth list`: one per
 * device credential (when device credentials are on) and one per stored 9.24
 * session on an origin no device credential covers, or one "not signed in"
 * row for the default origin. Makes a network call only when a credential is
 * stored. A device that is signed out locally (no current credential) is not
 * signed in.
 *
 * @param opts - Origin filter, stores, liveness and test overrides.
 * @returns Status rows, sorted by origin.
 */
export async function getNexusAccountStatus(
  opts: NexusStatusOptions = {},
): Promise<NexusAccountStatus[]> {
  const store = opts.store ?? new FileNexusTokenStore();
  const only = opts.apiUrl !== undefined ? resolveNexusApiUrl(opts.apiUrl) : null;
  const checks: Promise<NexusAccountStatus>[] = [];
  const extra: NexusAccountStatus[] = [];
  /** `origin\u0000userId` pairs a device credential covers; a session of the same user is a leftover. */
  const covered = new Set<string>();
  // Device credentials are always reported, whatever CLEO_NEXUS_DEVICE says:
  // the switch picks the login flow, and hiding a live credential would let
  // `CLEO_NEXUS_DEVICE=0` users believe they are signed out (review M2).
  if (opts.devices ?? true) {
    try {
      for (const d of await (opts.deviceStore ?? new NexusDeviceStore()).list()) {
        if (only !== null && d.origin !== only) continue;
        if (!(d instanceof SealedNexusDevice)) {
          extra.push({
            apiUrl: d.origin,
            state: 'unverified',
            email: null,
            organization: null,
            expiresAt: null,
            summary: `device entry for user ${d.userId} cannot be opened on this machine (${d.reason}); run \`cleo login nexus\` to enrol this machine`,
          });
          continue;
        }
        // Status reads only the current credential: probing a pending
        // rotation credential would be its first use (§2.5), a write.
        const bearer = d.currentBearer();
        if (bearer === null) continue;
        covered.add(`${d.origin}\u0000${d.userId}`);
        checks.push(checkDevice(d, bearer, opts));
      }
    } catch (err) {
      // A device file that cannot be read never hides the session rows (review M1).
      extra.push({
        apiUrl: only ?? resolveNexusApiUrl(),
        state: 'unverified',
        email: null,
        organization: null,
        expiresAt: null,
        summary: `device credentials unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  for (const s of await store.list()) {
    if (only !== null && s.apiUrl !== only) continue;
    // A leftover 9.24 session of the user a device credential already covers
    // is not shown twice; a session of any other user is (review L3).
    if (s.user !== null && covered.has(`${s.apiUrl}\u0000${s.user.id}`)) continue;
    checks.push(checkSession(s, opts));
  }
  const rows = [...(await Promise.all(checks)), ...extra];
  if (rows.length === 0) {
    return [statusRow(only ?? resolveNexusApiUrl(), 'not-signed-in', null, null)];
  }
  return rows.sort((a, b) => a.apiUrl.localeCompare(b.apiUrl));
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
