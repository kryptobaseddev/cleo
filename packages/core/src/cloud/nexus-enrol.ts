/**
 * Cleo Nexus device enrolment: the device half of `cleo login nexus` and the
 * one-time upgrade of a 9.24 bearer session (cleo-nexus device contract v2.9,
 * §3.3 steps 4 to 10, §3.4). Everything here runs only behind
 * `CLEO_NEXUS_DEVICE=1` ({@link isNexusDeviceEnabled}); with the switch off
 * the CLI keeps the 9.24 session flow in `nexus-auth.ts` untouched.
 *
 * Lock discipline (v2.9). `nexus-device.json`'s lock is held only around local
 * read-modify-writes, never across a network call:
 *
 * 1. under the lock: re-read, check, persist the identity and the E1 intent;
 * 2. release the lock, send the request with a plain timeout;
 * 3. re-take the lock and re-check with a compare-and-swap before storing.
 *
 * Racing logins on one home (step 7). When the file already holds a different
 * credential for the same (origin, user), E2 (`/v1/whoami`) is asked about
 * each credential and the one that answers 200 is kept; the other is dropped
 * with no E9 and no `pendingSignOut` (the server already refused it). Both
 * 200: the later `createdAt` wins and a `W_NEXUS_LOGIN_RACE_BOTH_LIVE`
 * warning is added. Both 401: neither is kept and a login is required. A
 * network error or 5xx leaves the file as it is.
 *
 * No function here logs, no result or error carries a token or key, and no
 * guarded entry is ever spread: every entry change goes through the store's
 * `apply*` transitions.
 *
 * @task T12868
 * @epic T12323
 */

import { randomBytes } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import {
  type NexusAccountOrganization,
  type NexusAccountUser,
  type NexusLoginResult,
  nexusAccountOrganizationSchema,
} from '@cleocode/contracts';
import { z } from 'zod';
import type { DeviceCodeStartResponse } from '../llm/oauth/device-code.js';
import { generateEd25519, generateX25519, signEd25519 } from './crypto.js';
import { type FetchLike, Http, NexusError } from './http.js';
import {
  NEXUS_REVOKE_TIMEOUT_MS,
  NexusAccountError,
  type NexusLoginOptions,
  resolveNexusApiUrl,
  runNexusDeviceCode,
  signOutNexusSessionToken,
} from './nexus-auth.js';
import {
  FileNexusTokenStore,
  type NexusTokenStore,
  nexusOriginKey,
  type SealedNexusSession,
} from './nexus-credentials.js';
import {
  applyClearEnrolIntent,
  applyDropCurrent,
  applyDropRaceCandidate,
  applyEnrolIntent,
  applyEnrolment,
  applyRefreshEnrolIntent,
  applySetRaceCandidate,
  assertEnrolmentAllowed,
  guardNexusDeviceSecrets,
  NEXUS_DEVICE_CREDENTIAL_PATTERN,
  NEXUS_DEVICE_PROFILES,
  NEXUS_DEVICE_SCOPES,
  type NexusDeviceEnrolIntent,
  NexusDeviceEnrolment,
  type NexusDeviceKeys,
  type NexusDeviceProfile,
  type NexusDeviceScope,
  NexusDeviceStore,
  NexusDeviceStoreError,
  type NexusDeviceTransaction,
  type SealedNexusDevice,
  UnreadableNexusDevice,
} from './nexus-device.js';
import { deviceEnrollmentMessage } from './signing.js';
import { uuidv7 } from './uuidv7.js';

/**
 * E1's request timeout. An upgrade intent older than this is stale: the
 * process that wrote it has given up or died (§3.4 step 1).
 */
export const NEXUS_ENROL_TIMEOUT_MS = 30_000;

/** Timeout of one E2 (`/v1/whoami`) call. */
export const NEXUS_WHOAMI_TIMEOUT_MS = 15_000;

/** How long an upgrade waits for another process's live upgrade intent (the ~60 s lock budget). */
export const NEXUS_UPGRADE_WAIT_MS = 60_000;

/** Interval between locked re-reads while waiting for another process's upgrade. */
export const NEXUS_UPGRADE_POLL_MS = 250;

/** Slack added to the stale age of an E1 intent, over its owner's E2 and E1 timeouts. */
export const NEXUS_INTENT_MARGIN_MS = 15_000;

/**
 * Age after which another process's E1 intent is stale (§3.4 step 1). A live
 * owner can be E2 plus E1 past `startedAt` (it also refreshes `startedAt`
 * right before E1), so the threshold is derived from both timeouts plus a
 * margin, never E1's timeout alone (security review M1).
 */
export const NEXUS_INTENT_STALE_MS =
  NEXUS_WHOAMI_TIMEOUT_MS + NEXUS_ENROL_TIMEOUT_MS + NEXUS_INTENT_MARGIN_MS;

/** Warning code: two racing logins both held a live credential (§3.3 step 7, ruling A). */
export const W_NEXUS_LOGIN_RACE_BOTH_LIVE = 'W_NEXUS_LOGIN_RACE_BOTH_LIVE';

/** Warning code: the chosen device name is this machine's hostname (L8). */
export const W_NEXUS_DEVICE_NAME_IS_HOSTNAME = 'W_NEXUS_DEVICE_NAME_IS_HOSTNAME';

/** The remedy for any failure that needs a fresh, human, browser login. */
const BROWSER_LOGIN_FIX =
  'run `cleo login nexus` (needs a browser: on a headless machine a human must complete the login)';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const profileSchema = z.enum(NEXUS_DEVICE_PROFILES);

/** The subset of `DeviceView` (§4.1) the CLI reads. */
const deviceViewSchema = z.object({
  deviceId: uuid,
  name: z.string(),
  state: z.string(),
  profile: profileSchema.nullable().optional(),
});

/** The subset of `Whoami` (E2, §4.1) the CLI reads. Unknown fields are ignored. */
const whoamiSchema = z.object({
  serverTime: z.string().optional(),
  user: z.object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string().nullable().optional(),
  }),
  organizations: z.array(nexusAccountOrganizationSchema).default([]),
  credential: z
    .object({
      kind: z.enum(['device', 'session']),
      credentialId: z.string().nullable().optional(),
      profile: profileSchema.nullable().optional(),
      scopes: z.array(z.string()).default([]),
    })
    .optional(),
  device: deviceViewSchema.nullable().optional(),
});

/** Parsed E2 answer. */
type Whoami = z.infer<typeof whoamiSchema>;

/** `EnrollDeviceResult` (E1, §4.1), as far as the CLI reads it. */
const enrollResultSchema = z.object({
  device: deviceViewSchema,
  credential: z.object({
    credentialId: uuid,
    token: z.string().regex(NEXUS_DEVICE_CREDENTIAL_PATTERN),
    profile: profileSchema,
    scopes: z.array(z.string()),
    createdAt: z.iso.datetime(),
  }),
  created: z.boolean(),
});

/** Parsed E1 answer. Holds the new token: never print it. */
type EnrollResult = z.infer<typeof enrollResultSchema>;

/** Dependencies of the device flows; all optional (tests inject them). */
export interface NexusDeviceFlowOptions {
  /** API URL; defaults to `$CLEO_NEXUS_API_URL`, then production. */
  apiUrl?: string;
  /** `fetch` override. */
  fetch?: FetchLike;
  /** The device store; defaults to `<cleoHome>/nexus-device.json`. */
  deviceStore?: NexusDeviceStore;
  /** The 9.24 session store (`nexus-credentials.json`). */
  store?: NexusTokenStore;
  /** Clock (intent ages, `createdAt`). */
  now?: () => Date;
  /** Wait between locked re-reads (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** E1 timeout; also the staleness threshold of an upgrade intent. */
  enrolTimeoutMs?: number;
  /** E2 timeout. */
  whoamiTimeoutMs?: number;
  /** Budget for waiting on another process's upgrade. */
  upgradeWaitMs?: number;
  /** Interval between re-reads while waiting. */
  upgradePollMs?: number;
  /** Margin over E2 + E1 timeouts before an intent is stale; default {@link NEXUS_INTENT_MARGIN_MS}. */
  intentMarginMs?: number;
  /** CLEO version sent as `cliVersion`; defaults to the installed one. */
  cliVersion?: string;
}

/** Options for {@link loginToNexusDevice}. */
export interface NexusDeviceLoginOptions extends NexusDeviceFlowOptions {
  /** Enrol with the `read-only` profile (`--read-only`). */
  readOnly?: boolean;
  /** Device name (`--name`); defaults to a generic name without the hostname. */
  name?: string;
  /** Called once with the user code and verification URL to show the user. */
  onCode?: (code: DeviceCodeStartResponse) => void;
  /** Called on every pending poll with elapsed and total seconds. */
  onPending?: (elapsed: number, expiresIn: number) => void;
  /** Cancels polling. */
  signal?: AbortSignal;
  /** Wait override for device-code polling (tests). */
  pollSleep?: (ms: number) => Promise<void>;
}

/** Result of {@link upgradeNexusSession}. Holds no secret. */
export interface NexusSessionUpgradeResult {
  /**
   * - `upgraded`: this process enrolled the device from the 9.24 session;
   * - `already-enrolled`: a device credential already existed (another
   *   process upgraded, or a login ran); the leftover session was removed;
   * - `no-session`: there was no 9.24 session for the origin.
   */
  readonly outcome: 'upgraded' | 'already-enrolled' | 'no-session';
  /** The device entry now holding the credential, or `null` for `no-session`. */
  readonly device: SealedNexusDevice | null;
  /** Non-fatal problems. */
  readonly warnings: readonly string[];
}

/** Result of {@link ensureNexusDeviceCredential}. Holds no secret in any enumerable field. */
export interface NexusDeviceCredentialHandle {
  /** The entry; `currentBearer()` builds the `Authorization` header. */
  readonly device: SealedNexusDevice;
  /** `true` when a 9.24 session was upgraded to reach it. */
  readonly upgraded: boolean;
  /** Non-fatal problems. */
  readonly warnings: readonly string[];
}

/** Resolved flow dependencies. */
interface Ctx {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly devices: NexusDeviceStore;
  readonly sessions: NexusTokenStore;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly enrolTimeoutMs: number;
  /** Age after which another process's intent is stale: E2 + E1 timeouts + margin. */
  readonly intentStaleMs: number;
  readonly whoamiTimeoutMs: number;
  readonly upgradeWaitMs: number;
  readonly upgradePollMs: number;
  readonly cliVersion: () => Promise<string>;
}

function context(opts: NexusDeviceFlowOptions): Ctx {
  const base: FetchLike =
    opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  return {
    apiUrl: resolveNexusApiUrl(opts.apiUrl),
    fetch: base,
    devices: opts.deviceStore ?? new NexusDeviceStore(),
    sessions: opts.store ?? new FileNexusTokenStore(),
    now: opts.now ?? (() => new Date()),
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    enrolTimeoutMs: opts.enrolTimeoutMs ?? NEXUS_ENROL_TIMEOUT_MS,
    intentStaleMs:
      (opts.whoamiTimeoutMs ?? NEXUS_WHOAMI_TIMEOUT_MS) +
      (opts.enrolTimeoutMs ?? NEXUS_ENROL_TIMEOUT_MS) +
      (opts.intentMarginMs ?? NEXUS_INTENT_MARGIN_MS),
    whoamiTimeoutMs: opts.whoamiTimeoutMs ?? NEXUS_WHOAMI_TIMEOUT_MS,
    upgradeWaitMs: opts.upgradeWaitMs ?? NEXUS_UPGRADE_WAIT_MS,
    upgradePollMs: opts.upgradePollMs ?? NEXUS_UPGRADE_POLL_MS,
    cliVersion: async () => {
      if (opts.cliVersion !== undefined) return opts.cliVersion;
      const { getCleoVersion } = await import('../scaffold/ensure-config.js');
      return getCleoVersion();
    },
  };
}

/** One HTTP client for one bearer: one attempt, a plain timeout (no lock is held). */
function client(ctx: Ctx, bearer: string, timeoutMs: number): Http {
  const timed: FetchLike = (input, init) =>
    ctx.fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return new Http({ baseUrl: ctx.apiUrl, token: bearer, fetch: timed, maxAttempts: 1 });
}

/** A fresh 32-hex intent owner id. */
function newOwner(): string {
  return randomBytes(16).toString('hex');
}

// ---------- error mapping (§4.0.4) ----------

/** The `details.reason` of an API error, when it is a string. */
function reasonOf(err: NexusError): string | undefined {
  const reason = err.details?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** True when the request got no usable answer (network, timeout) or a 5xx. */
function isUnanswered(err: unknown): boolean {
  return err instanceof NexusError && (err.code === 'E_NETWORK' || err.status >= 500);
}

/**
 * Map an API failure to the CLI's error codes (device contract §4.0.4). The
 * reasons handled internally by the enrolment and rotation flows
 * (`device-revoked` and `device-other-account` on E1, `device-id-taken`,
 * `device-keys-changed`, `project-id-taken`) are mapped by their callers
 * first; anything reaching this function is reported.
 *
 * @param err - The thrown error.
 * @returns A {@link NexusAccountError} with a stable code, or `err` itself
 *   when it is not an API failure.
 */
export function nexusApiErrorToAccountError(err: unknown): Error {
  if (err instanceof NexusAccountError || !(err instanceof NexusError)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const reason = reasonOf(err);
  const remedy = typeof err.details?.['remedy'] === 'string' ? err.details['remedy'] : undefined;
  if (err.code === 'E_NETWORK') {
    return new NexusAccountError(
      'E_NEXUS_UNREACHABLE',
      `Cleo Nexus did not answer: ${err.message}`,
      'check your network and retry',
    );
  }
  if (err.status === 401) {
    switch (reason) {
      case 'credential-revoked':
        if (err.details?.['revokedReason'] === 'reenrolled') {
          // Replaced by a newer login of this device, not stolen: a login
          // fixes it, and the device id stays (security review M2b).
          return new NexusAccountError(
            'E_NEXUS_NOT_SIGNED_IN',
            "this device's credential was replaced by a newer login of the same device",
            'run `cleo login nexus`',
          );
        }
        return new NexusAccountError(
          'E_NEXUS_CREDENTIAL_COMPROMISED',
          "this device's credential was replaced or revoked elsewhere, possibly used from another machine",
          'revoke this device on cleocode.dev and sign in again with `cleo login nexus`',
        );
      case 'credential-expired':
        return new NexusAccountError(
          'E_NEXUS_SESSION_EXPIRED',
          'the device credential expired after 90 days without use',
          'run `cleo login nexus`',
        );
      case 'device-signed-out':
        return new NexusAccountError(
          'E_NEXUS_DEVICE_SIGNED_OUT',
          'this device was signed out',
          'run `cleo login nexus`',
        );
      case 'device-revoked':
        return new NexusAccountError(
          'E_NEXUS_DEVICE_REVOKED',
          'this device was revoked',
          'run `cleo login nexus` to enrol this machine as a new device',
        );
      case 'session-bearer-retired':
        return new NexusAccountError(
          'E_NEXUS_SESSION_EXPIRED',
          'bearer sessions are no longer accepted',
          'run `cleo login nexus` with the current CLI',
        );
      default:
        return new NexusAccountError(
          'E_NEXUS_NOT_SIGNED_IN',
          'not signed in to Cleo Nexus (the credential is missing or invalid)',
          'run `cleo login nexus`',
        );
    }
  }
  if (err.status === 403) {
    if (reason === 'insufficient-scope') {
      return new NexusAccountError(
        'E_NEXUS_INSUFFICIENT_SCOPE',
        `this device's credential lacks the scope for that request${typeof err.details?.['requiredScope'] === 'string' ? ` (${err.details['requiredScope']})` : ''}`,
        'run `cleo login nexus` without --read-only to enrol with the full device profile',
      );
    }
    if (reason === 'bearer-session-required' || reason === 'session-not-fresh') {
      return new NexusAccountError(
        'E_NEXUS_SESSION_EXPIRED',
        'the session is too old to enrol this device',
        BROWSER_LOGIN_FIX,
      );
    }
    if (reason === 'device-limit') {
      return new NexusAccountError(
        'E_NEXUS_REQUEST_FAILED',
        'the account has reached its device limit',
        remedy ?? 'revoke unused devices on cleocode.dev, then retry',
      );
    }
  }
  if (err.status === 409 && reason === 'replica-copied') {
    return new NexusAccountError(
      'E_NEXUS_REPLICA_COPIED',
      'this project store is attached from another device (a copied store)',
      remedy,
    );
  }
  const retry = err.status === 429 || err.status >= 500 ? ' (retryable)' : '';
  return new NexusAccountError('E_NEXUS_REQUEST_FAILED', `${err.message}${retry}`, remedy);
}

/** Map a device-store failure to a CLI error, keeping its message (never a secret). */
function storeErrorToAccountError(err: unknown): Error {
  if (!(err instanceof NexusDeviceStoreError))
    return err instanceof Error ? err : new Error(String(err));
  if (err.code === 'E_NEXUS_DEVICE_REVOKE_PENDING') {
    return new NexusAccountError(
      'E_NEXUS_REVOKE_PENDING',
      'a revoke of this device is not yet confirmed by the server, so logging in would undo it',
      'finish the revoke (`cleo logout nexus --revoke` retries it) or cancel it, then log in',
    );
  }
  if (err.code === 'E_NEXUS_DEVICE_BUSY' || err.code === 'E_NEXUS_DEVICE_LOCK_COMPROMISED') {
    return new NexusAccountError('E_NEXUS_BUSY', err.message, 'retry the command');
  }
  return new NexusAccountError('E_NEXUS_REQUEST_FAILED', err.message);
}

// ---------- device identity ----------

/** Fresh X25519 and Ed25519 key pairs (node:crypto), base64 raw 32 bytes each. */
function freshKeys(): NexusDeviceKeys {
  const enc = generateX25519();
  const sig = generateEd25519();
  return {
    encryption: {
      publicKey: enc.publicKey.toString('base64'),
      privateKey: enc.privateKey.toString('base64'),
    },
    signing: {
      publicKey: sig.publicKey.toString('base64'),
      privateKey: sig.privateKey.toString('base64'),
    },
  };
}

/** `process.platform` mapped to the contract's `Platform`. */
function platformOf(p: NodeJS.Platform): 'darwin' | 'linux' | 'win32' | 'other' {
  return p === 'darwin' || p === 'linux' || p === 'win32' ? p : 'other';
}

/** `process.arch` mapped to the contract's `Arch`. */
function archOf(a: string): 'x64' | 'arm64' | 'other' {
  return a === 'x64' || a === 'arm64' ? a : 'other';
}

/**
 * The default device name (§3.2): `<OS label> <arch> · <first 4 hex of the
 * device id>`. The hostname is never used.
 *
 * @param deviceId - The Nexus device id.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns For example `macOS arm64 · 01f3`.
 */
export function defaultNexusDeviceName(
  deviceId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const labels: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  return `${labels[platform] ?? 'Other'} ${archOf(arch)} · ${deviceId.replace(/-/g, '').slice(0, 4)}`;
}

/** The scopes of an E1 answer this CLI knows (unknown ones are dropped, never stored). */
function knownScopes(scopes: readonly string[]): NexusDeviceScope[] {
  const known: readonly string[] = NEXUS_DEVICE_SCOPES;
  return scopes.filter((s): s is NexusDeviceScope => known.includes(s));
}

// ---------- the enrolment core (steps 5 to 7) ----------

/** What step 5 persisted, carried to steps 6 and 7. Holds keys: never print it. */
interface Prepared {
  readonly deviceId: string;
  readonly keys: NexusDeviceKeys;
  /** `true` when step 5 generated keys for a device id the server may already know. */
  readonly regeneratedKeys: boolean;
  /** `current.credentialId` as step 5 saw it: the CAS base for step 7. */
  readonly baseline: string | null;
}

/** How to enrol. */
interface EnrolInput {
  readonly userId: string;
  readonly session: string;
  readonly profile: NexusDeviceProfile;
  readonly kind: NexusDeviceEnrolIntent['kind'];
  readonly owner: string;
  /** Explicit `--name`, or `undefined` for the default name. */
  readonly name?: string;
}

/** A finished enrolment, secret-free. */
interface Enrolled {
  readonly device: SealedNexusDevice;
  readonly view: { deviceId: string; name: string; state: string; profile: string | null };
  readonly created: boolean | null;
  readonly warnings: string[];
}

/**
 * Discard an entry this machine's key cannot open, so a login or upgrade can
 * enrol afresh (§2.2 "a lost machine key"). The unreadable entry's device id
 * is read from the lock-free listing; the discard is a CAS on it.
 */
async function unreadableDeviceId(ctx: Ctx, userId: string): Promise<string | null> {
  const origin = nexusOriginKey(ctx.apiUrl);
  const listed = await ctx.devices.list();
  const hit = listed.find(
    (d): d is UnreadableNexusDevice =>
      d instanceof UnreadableNexusDevice && d.origin === origin && d.userId === userId,
  );
  return hit?.deviceId ?? null;
}

/** Inside a transaction: discard the unreadable entry, if it is still the one listed. */
function discardIfUnreadable(
  tx: NexusDeviceTransaction,
  ctx: Ctx,
  userId: string,
  unreadable: string | null,
): void {
  if (unreadable === null) return;
  tx.discardUnreadable(ctx.apiUrl, userId, { deviceId: unreadable });
}

/**
 * Step 5 inside a transaction: refuse while a revoke is pending, then load or
 * mint the identity and persist it with the E1 intent. `replaceIdentity`
 * mints a new device (after a 409 that burns the current id).
 */
function prepareInTx(
  tx: NexusDeviceTransaction,
  ctx: Ctx,
  input: EnrolInput,
  replaceIdentity: boolean,
): Prepared {
  const entry = tx.get(ctx.apiUrl, input.userId);
  if (entry !== null) assertEnrolmentAllowed(entry, entry.deviceId);
  const now = ctx.now();
  const reuse = entry !== null && !replaceIdentity;
  const deviceId = reuse ? entry.deviceId : uuidv7(now.getTime());
  const keys = reuse && entry.keys !== null ? entry.keys : freshKeys();
  const intent: NexusDeviceEnrolIntent = {
    deviceId,
    kind: input.kind,
    owner: input.owner,
    startedAt: now.toISOString(),
  };
  tx.set(ctx.apiUrl, input.userId, applyEnrolIntent(entry, { deviceId, keys, intent }, now));
  // Guarded: the private keys never print (security review L7).
  return guardNexusDeviceSecrets({
    deviceId,
    keys: structuredClone(keys),
    regeneratedKeys: reuse && entry.keys === null,
    baseline: reuse ? (entry.current?.credentialId ?? null) : null,
  });
}

/** Step 5: take the lock, discard an unreadable entry, persist identity and intent, release. */
async function prepare(
  ctx: Ctx,
  input: EnrolInput,
  replaceIdentity: boolean,
  warnings: string[],
): Promise<Prepared> {
  const unreadable = await unreadableDeviceId(ctx, input.userId);
  return ctx.devices.update((tx) => {
    discardIfUnreadable(tx, ctx, input.userId, unreadable);
    const prepared = prepareInTx(tx, ctx, input, replaceIdentity);
    warnings.push(...tx.warnings);
    return prepared;
  });
}

/** Refresh this process's E1 intent under the lock; `false` when it is no longer ours. */
async function refreshIntent(ctx: Ctx, input: EnrolInput, prepared: Prepared): Promise<boolean> {
  return ctx.devices.update((tx) => {
    const entry = tx.get(ctx.apiUrl, input.userId);
    if (entry === null || entry.deviceId !== prepared.deviceId) return false;
    const next = applyRefreshEnrolIntent(entry, input.owner, ctx.now());
    if (next === null) return false;
    tx.set(ctx.apiUrl, input.userId, next);
    return true;
  });
}

/** Step 6: E1 with the session, proof signed with the device's Ed25519 key. */
async function sendEnrol(
  ctx: Ctx,
  input: EnrolInput,
  prepared: Prepared,
): Promise<{ result: EnrollResult; status: number }> {
  const encPub = Buffer.from(prepared.keys.encryption.publicKey, 'base64');
  const sigPub = Buffer.from(prepared.keys.signing.publicKey, 'base64');
  const message = deviceEnrollmentMessage({
    userId: input.userId,
    deviceId: prepared.deviceId,
    encryptionPublicKeyHex: encPub.toString('hex'),
    signingPublicKeyHex: sigPub.toString('hex'),
    profile: input.profile,
  });
  const proof = signEd25519(
    { publicKey: sigPub, privateKey: Buffer.from(prepared.keys.signing.privateKey, 'base64') },
    message,
  );
  const body = {
    deviceId: prepared.deviceId,
    name: input.name ?? defaultNexusDeviceName(prepared.deviceId),
    platform: platformOf(process.platform),
    arch: archOf(process.arch),
    cliVersion: (await ctx.cliVersion()).slice(0, 40),
    encryptionPublicKey: prepared.keys.encryption.publicKey,
    signingPublicKey: prepared.keys.signing.publicKey,
    profile: input.profile,
    proof: proof.toString('base64'),
  };
  const { data, status } = await client(ctx, input.session, ctx.enrolTimeoutMs).requestWithStatus(
    'POST',
    '/v1/devices/enroll',
    enrollResultSchema,
    body,
  );
  return { result: data, status };
}

/** E2 with a bearer: `ok` (200), `refused` (401) or `unknown` (anything else). */
async function probe(
  ctx: Ctx,
  bearer: string,
): Promise<{ readonly state: 'ok' | 'refused' | 'unknown'; readonly whoami: Whoami | null }> {
  try {
    const whoami = await client(ctx, bearer, ctx.whoamiTimeoutMs).request(
      'GET',
      '/v1/whoami',
      whoamiSchema,
    );
    return { state: 'ok', whoami };
  } catch (err) {
    if (err instanceof NexusError && err.status === 401) return { state: 'refused', whoami: null };
    return { state: 'unknown', whoami: null };
  }
}

/** Clear this process's intent, best effort (a failure leaves only a stale intent). */
async function clearIntent(ctx: Ctx, userId: string, owner: string): Promise<void> {
  try {
    await ctx.devices.update((tx) => {
      const entry = tx.get(ctx.apiUrl, userId);
      if (entry?.enrolIntent?.owner === owner) {
        tx.set(ctx.apiUrl, userId, applyClearEnrolIntent(entry, owner));
      }
    });
  } catch {
    /* a stale intent is harmless: it is taken over or ignored */
  }
}

/**
 * Step 7: re-take the lock and store E1's credential with a CAS, applying the
 * racing-login rule when the file already holds a different credential.
 */
async function store(
  ctx: Ctx,
  input: EnrolInput,
  prepared: Prepared,
  issued: EnrollResult,
  warnings: string[],
): Promise<SealedNexusDevice> {
  const enrolment = new NexusDeviceEnrolment({
    deviceId: prepared.deviceId,
    keys: prepared.keys,
    credential: {
      credentialId: issued.credential.credentialId,
      token: issued.credential.token,
      profile: issued.credential.profile,
      scopes: knownScopes(issued.credential.scopes),
      createdAt: issued.credential.createdAt,
    },
  });
  const ours = enrolment.credential();
  for (let round = 0; round < 3; round++) {
    const step = await ctx.devices.update((tx) => {
      const entry = tx.get(ctx.apiUrl, input.userId);
      if (entry !== null && entry.deviceId !== prepared.deviceId) {
        // Another process replaced this machine's identity meanwhile: never
        // retire that device's live credential for ours (security review L3).
        tx.set(ctx.apiUrl, input.userId, applyClearEnrolIntent(entry, input.owner));
        return { kind: 'identity-changed' } as const;
      }
      if (entry !== null && entry.pendingRevoke !== null) {
        tx.set(ctx.apiUrl, input.userId, applyClearEnrolIntent(entry, input.owner));
        return { kind: 'revoke-pending' } as const;
      }
      const held = entry?.current ?? null;
      if (entry === null || held === null || held.credentialId === prepared.baseline) {
        tx.set(
          ctx.apiUrl,
          input.userId,
          applyClearEnrolIntent(applyEnrolment(entry, enrolment, ctx.now()), input.owner),
        );
        return { kind: 'stored' } as const;
      }
      if (held.credentialId === ours.credentialId) return { kind: 'stored' } as const;
      // Racing logins: park ours, sealed, beside the held one BEFORE probing,
      // so the only live credential is never lost (security review M2).
      tx.set(
        ctx.apiUrl,
        input.userId,
        applyClearEnrolIntent(
          applySetRaceCandidate(entry, {
            credentialId: ours.credentialId,
            token: ours.token,
            profile: ours.profile,
            scopes: ours.scopes,
            createdAt: ours.createdAt,
          }),
          input.owner,
        ),
      );
      return { kind: 'race' } as const;
    });
    if (step.kind === 'identity-changed') {
      throw new NexusAccountError(
        'E_NEXUS_BUSY',
        `another cleo process replaced this machine's Nexus device while device ${prepared.deviceId} was being enrolled; nothing was stored`,
        `retry \`cleo login nexus\`; if device ${prepared.deviceId} is listed on cleocode.dev, revoke it there`,
      );
    }
    if (step.kind === 'revoke-pending') {
      throw storeErrorToAccountError(
        new NexusDeviceStoreError('E_NEXUS_DEVICE_REVOKE_PENDING', 'revoke pending'),
      );
    }
    if (step.kind === 'stored') return requireStored(ctx, input.userId);

    const outcome = await settleRaceCandidate(ctx, input.userId, warnings);
    if (outcome === 'unknown') {
      throw new NexusAccountError(
        'E_NEXUS_UNREACHABLE',
        'another login stored a device credential at the same time, and the server could not confirm which one is live; both are kept, sealed, and the next cloud command settles them',
        'run `cleo login nexus` again when Cleo Nexus is reachable: it re-enrols the same device id, which revokes any credential left orphaned on the server',
      );
    }
    if (outcome === 'both-refused') {
      throw new NexusAccountError(
        'E_NEXUS_NOT_SIGNED_IN',
        'two logins raced on this CLEO home and the server refused both credentials',
        'run `cleo login nexus`',
      );
    }
    if (outcome !== 'changed') return requireStored(ctx, input.userId);
    // The file changed again while probing: re-run the check.
  }
  await clearIntent(ctx, input.userId, input.owner);
  throw new NexusAccountError(
    'E_NEXUS_BUSY',
    'other logins kept replacing the device credential on this CLEO home',
    'retry the command',
  );
}

/** How {@link settleRaceCandidate} ended. */
type SettleOutcome =
  | 'none'
  | 'kept-candidate'
  | 'kept-current'
  | 'both-refused'
  | 'unknown'
  | 'changed';

/**
 * Settle a parked race candidate (§3.3 step 7, ruling A): ask E2 about it and
 * about `current`, then, under the lock with a CAS on both, keep the one that
 * answers 200 (both: the later `createdAt`, with
 * {@link W_NEXUS_LOGIN_RACE_BOTH_LIVE}), or drop both when both are refused.
 * The loser is dropped with no E9 and no `pendingSignOut`: the server already
 * refused it. With no answer, nothing changes.
 */
async function settleRaceCandidate(
  ctx: Ctx,
  userId: string,
  warnings: string[],
): Promise<SettleOutcome> {
  const snap = (await ctx.devices.get(ctx.apiUrl, userId))?.unseal() ?? null;
  const candidate = snap?.raceCandidate ?? null;
  if (snap === null || candidate === null) return 'none';
  const current = snap.current;
  let keep: 'candidate' | 'current' | 'neither' = 'candidate';
  if (current !== null) {
    const [mine, other] = await Promise.all([
      probe(ctx, candidate.token),
      probe(ctx, current.token),
    ]);
    if (mine.state === 'unknown' || other.state === 'unknown') return 'unknown';
    if (mine.state === 'ok' && other.state === 'ok') {
      keep =
        Date.parse(candidate.createdAt) > Date.parse(current.createdAt) ? 'candidate' : 'current';
      warnings.push(
        `${W_NEXUS_LOGIN_RACE_BOTH_LIVE}: two logins on this CLEO home both hold a live credential for device ${snap.deviceId}; kept the newer one`,
      );
    } else if (mine.state === 'ok') {
      keep = 'candidate';
    } else if (other.state === 'ok') {
      keep = 'current';
    } else {
      keep = 'neither';
    }
  }
  const currentId = current?.credentialId ?? null;
  const applied = await ctx.devices.update((tx) => {
    const entry = tx.get(ctx.apiUrl, userId);
    if (
      entry === null ||
      entry.deviceId !== snap.deviceId ||
      entry.raceCandidate?.credentialId !== candidate.credentialId ||
      (entry.current?.credentialId ?? null) !== currentId
    ) {
      return false;
    }
    if (keep === 'candidate') {
      const promoted = new NexusDeviceEnrolment({
        deviceId: entry.deviceId,
        keys: null,
        credential: {
          credentialId: candidate.credentialId,
          token: candidate.token,
          profile: candidate.profile,
          scopes: candidate.scopes,
          createdAt: candidate.createdAt,
        },
      });
      tx.set(ctx.apiUrl, userId, applyEnrolment(entry, promoted, ctx.now()));
    } else if (keep === 'current') {
      tx.set(ctx.apiUrl, userId, applyDropRaceCandidate(entry, candidate.credentialId));
    } else {
      const dropped = applyDropRaceCandidate(entry, candidate.credentialId);
      tx.set(
        ctx.apiUrl,
        userId,
        currentId === null ? dropped : applyDropCurrent(dropped, currentId),
      );
    }
    return true;
  });
  if (!applied) return 'changed';
  return keep === 'candidate'
    ? 'kept-candidate'
    : keep === 'current'
      ? 'kept-current'
      : 'both-refused';
}

/** The stored entry after step 7. */
async function requireStored(ctx: Ctx, userId: string): Promise<SealedNexusDevice> {
  const device = await ctx.devices.get(ctx.apiUrl, userId);
  if (device === null || device.currentBearer() === null) {
    throw new NexusAccountError(
      'E_NEXUS_NOT_SIGNED_IN',
      'the device credential was removed by another cleo process',
      'run `cleo login nexus`',
    );
  }
  return device;
}

/** An E1 409 that §3.3 step 6 handles by minting a new identity. */
function conflictReason(err: unknown): string | null {
  return err instanceof NexusError && err.status === 409 ? (reasonOf(err) ?? null) : null;
}

/**
 * Steps 5 to 7 with a session token. On the exempt upgrade path
 * (`input.kind === 'upgrade'`) a lost E1 answer is not retried: the server
 * may have consumed the session (N2).
 */
async function enrol(
  ctx: Ctx,
  input: EnrolInput,
  alreadyPrepared: Prepared | null,
  warnings: string[],
): Promise<Enrolled> {
  let prepared: Prepared;
  try {
    prepared = alreadyPrepared ?? (await prepare(ctx, input, false, warnings));
  } catch (err) {
    throw storeErrorToAccountError(err);
  }
  let issued: { result: EnrollResult; status: number } | null = null;
  let adopted: SealedNexusDevice | null = null;
  for (let attempt = 0; attempt < 2 && issued === null && adopted === null; attempt++) {
    // Refresh the intent (owner CAS) right before E1, so a live intent never
    // looks stale to another upgrader (security review M1). On the one-shot
    // upgrade path, an intent that is no longer ours means another process
    // took over: send nothing.
    let ownIntent: boolean;
    try {
      ownIntent = await refreshIntent(ctx, input, prepared);
    } catch (err) {
      throw storeErrorToAccountError(err);
    }
    if (!ownIntent && input.kind === 'upgrade') {
      throw new NexusAccountError(
        'E_NEXUS_BUSY',
        'another cleo process took over this upgrade; the stored session was not sent',
        'retry the command',
      );
    }
    try {
      issued = await sendEnrol(ctx, input, prepared);
    } catch (err) {
      const reason = conflictReason(err);
      const retryable =
        attempt === 0 &&
        (reason === 'device-revoked' ||
          reason === 'device-other-account' ||
          reason === 'device-id-taken' ||
          (reason === 'device-keys-changed' && prepared.regeneratedKeys));
      if (reason === 'device-id-taken' && (await enrolledMeanwhile(ctx, input, prepared))) {
        // Another process on this home enrolled this identity: use its result.
        adopted = await requireStored(ctx, input.userId);
        break;
      }
      if (retryable) {
        try {
          prepared = await prepare(ctx, input, true, warnings);
        } catch (storeErr) {
          throw storeErrorToAccountError(storeErr);
        }
        continue;
      }
      await clearIntent(ctx, input.userId, input.owner);
      throw enrolError(err, err instanceof NexusError ? (reasonOf(err) ?? null) : null, input);
    }
  }
  if (adopted !== null) {
    return {
      device: adopted,
      view: { deviceId: adopted.deviceId, name: '', state: 'active', profile: null },
      created: null,
      warnings,
    };
  }
  if (issued === null) {
    await clearIntent(ctx, input.userId, input.owner);
    throw new NexusAccountError('E_NEXUS_REQUEST_FAILED', 'the device enrolment did not complete');
  }
  const device = await store(ctx, input, prepared, issued.result, warnings);
  const stored = device.unseal().current;
  const ours = stored?.credentialId === issued.result.credential.credentialId;
  return {
    device,
    view: ours
      ? {
          deviceId: issued.result.device.deviceId,
          name: issued.result.device.name,
          state: issued.result.device.state,
          profile: issued.result.credential.profile,
        }
      : { deviceId: device.deviceId, name: '', state: 'active', profile: stored?.profile ?? null },
    created: ours ? issued.result.created : null,
    warnings,
  };
}

/**
 * §3.3 step 6, 409 `device-id-taken`: under the lock, re-read the file. When
 * this identity now holds a credential other than the one step 5 saw, another
 * process on this home enrolled it; the intent is cleared and that result is used.
 */
async function enrolledMeanwhile(
  ctx: Ctx,
  input: EnrolInput,
  prepared: Prepared,
): Promise<boolean> {
  try {
    return await ctx.devices.update((tx) => {
      const entry = tx.get(ctx.apiUrl, input.userId);
      const held = entry?.current ?? null;
      if (entry === null || entry.deviceId !== prepared.deviceId || held === null) return false;
      if (held.credentialId === prepared.baseline) return false;
      tx.set(ctx.apiUrl, input.userId, applyClearEnrolIntent(entry, input.owner));
      return true;
    });
  } catch {
    return false;
  }
}

/** The error for a failed E1 (after the internal 409 handling). */
function enrolError(err: unknown, reason: string | null, input: EnrolInput): Error {
  if (input.kind === 'upgrade') {
    if (isUnanswered(err)) {
      return new NexusAccountError(
        'E_NEXUS_SESSION_EXPIRED',
        'the automatic upgrade of the stored session lost its answer from Cleo Nexus; that session can enrol only once, so it cannot be retried',
        BROWSER_LOGIN_FIX,
      );
    }
    const refusedSession =
      err instanceof NexusError &&
      (err.status === 401 ||
        (err.status === 403 &&
          (reason === 'session-not-fresh' || reason === 'bearer-session-required')));
    if (refusedSession) {
      return new NexusAccountError(
        'E_NEXUS_SESSION_EXPIRED',
        'the stored session can no longer be upgraded (expired, or created after the server deploy and older than 15 minutes)',
        BROWSER_LOGIN_FIX,
      );
    }
  }
  if (isUnanswered(err)) {
    return new NexusAccountError(
      'E_NEXUS_UNREACHABLE',
      `Cleo Nexus did not answer the device enrolment: ${err instanceof Error ? err.message : String(err)}`,
      'run `cleo login nexus` again when Cleo Nexus is reachable: it re-enrols the same device id, which revokes any credential left orphaned on the server',
    );
  }
  const conflict = conflictReason(err);
  if (conflict === 'device-keys-changed') {
    return new NexusAccountError(
      'E_NEXUS_REQUEST_FAILED',
      'the server holds different keys for this device than the ones stored on this machine',
      'revoke this device on cleocode.dev, then run `cleo login nexus`',
    );
  }
  if (
    conflict === 'device-id-taken' ||
    conflict === 'device-revoked' ||
    conflict === 'device-other-account'
  ) {
    return new NexusAccountError(
      'E_NEXUS_REQUEST_FAILED',
      `the device enrolment was refused twice (${conflict})`,
      'retry `cleo login nexus`',
    );
  }
  return nexusApiErrorToAccountError(err);
}

/** Steps 8 and 9 for a login: sign the session out, then confirm the credential with E2. */
async function finish(
  ctx: Ctx,
  session: string,
  device: SealedNexusDevice,
  signOutExpectedToFail: boolean,
  warnings: string[],
): Promise<Whoami | null> {
  try {
    await signOutNexusSessionToken(ctx.apiUrl, session, NEXUS_REVOKE_TIMEOUT_MS, ctx.fetch);
  } catch (err) {
    if (!signOutExpectedToFail) {
      warnings.push(
        `the browser session could not be signed out (${err instanceof Error ? err.message : String(err)}); it expires on its own`,
      );
    }
  }
  const bearer = device.currentBearer();
  if (bearer === null) return null;
  const confirmed = await probe(ctx, bearer);
  if (confirmed.state !== 'ok') {
    warnings.push('the device credential was stored, but Cleo Nexus could not confirm it yet');
  }
  return confirmed.whoami;
}

/** The personal organization, else the first. */
function primaryOrganization(
  orgs: readonly NexusAccountOrganization[],
): NexusAccountOrganization | null {
  return orgs.find((o) => o.personal) ?? orgs[0] ?? null;
}

/**
 * `cleo login nexus` with device credentials (contract §3.3): the device-code
 * login gives a session held in memory only; the session enrols this machine
 * as a device (E1), is signed out, and only the scoped device credential is
 * stored, sealed, in `nexus-device.json`. `nexus-credentials.json` is never
 * written.
 *
 * @param opts - API URL, profile, name, UI hooks and test overrides.
 * @returns The secret-free login result, with the device and its scopes.
 * @throws {NexusAccountError} `E_NEXUS_REVOKE_PENDING` while a revoke of this
 *   device is unconfirmed; `E_NEXUS_UNREACHABLE`; the §4.0.4 mappings.
 */
export async function loginToNexusDevice(
  opts: NexusDeviceLoginOptions = {},
): Promise<NexusLoginResult> {
  const ctx = context(opts);
  const profile: NexusDeviceProfile = opts.readOnly === true ? 'read-only' : 'device';
  const loginOpts: NexusLoginOptions = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.onCode ? { onCode: opts.onCode } : {}),
    ...(opts.onPending ? { onPending: opts.onPending } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.pollSleep ? { sleep: opts.pollSleep } : {}),
  };
  const token = await runNexusDeviceCode(
    ctx.apiUrl,
    loginOpts,
    profile === 'read-only' ? 'cleo:read-only' : 'cleo:device',
  );
  const session = token.accessToken;
  const warnings: string[] = [];

  // Step 4: who is signing in.
  let me: Whoami;
  try {
    me = await client(ctx, session, ctx.whoamiTimeoutMs).request('GET', '/v1/whoami', whoamiSchema);
  } catch (err) {
    throw nexusApiErrorToAccountError(err);
  }

  const name = opts.name?.trim();
  if (name !== undefined && name !== '' && name === osHostname()) {
    warnings.push(
      `${W_NEXUS_DEVICE_NAME_IS_HOSTNAME}: device names are visible to members of your organizations`,
    );
  }
  const enrolled = await enrol(
    ctx,
    {
      userId: me.user.id,
      session,
      profile,
      kind: 'login',
      owner: newOwner(),
      ...(name !== undefined && name !== '' ? { name } : {}),
    },
    null,
    warnings,
  );
  const confirmed = await finish(ctx, session, enrolled.device, false, warnings);
  return loginResult(ctx, me, confirmed, enrolled, warnings);
}

/** Build the step-10 result. */
function loginResult(
  ctx: Ctx,
  me: Whoami,
  confirmed: Whoami | null,
  enrolled: Enrolled,
  warnings: string[],
): NexusLoginResult {
  const who = confirmed ?? me;
  const user: NexusAccountUser = {
    id: who.user.id,
    email: who.user.email,
    ...(who.user.name !== undefined ? { name: who.user.name } : {}),
  };
  const stored = enrolled.device.unseal().current;
  return {
    apiUrl: ctx.apiUrl,
    user,
    organization: primaryOrganization(who.organizations),
    expiresAt: null,
    credentialsPath: ctx.devices.location,
    warnings,
    device: {
      deviceId: enrolled.view.deviceId,
      name: confirmed?.device?.name ?? enrolled.view.name,
      state: confirmed?.device?.state ?? enrolled.view.state,
      profile: stored?.profile ?? enrolled.view.profile,
      created: enrolled.created,
    },
    scopes: confirmed?.credential?.scopes ?? stored?.scopes ?? [],
  };
}

// ---------- the 9.24 auto-upgrade (§3.4) ----------

/** What one locked re-check of the upgrade decided. */
type UpgradeStep =
  | { readonly kind: 'enrolled' }
  | { readonly kind: 'consumed' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'stale'; readonly owner: string }
  | { readonly kind: 'go'; readonly prepared: Prepared };

/**
 * Upgrade a 9.24 session to a device credential, once (contract §3.4).
 *
 * Under `nexus-device.json`'s lock, then `nexus-credentials.json`'s (always in
 * that order), both files are re-read:
 *
 * - the device file already holds a credential for (origin, user): another
 *   process upgraded; the leftover session is removed and E1 is not called;
 * - the session is gone from the v1 file: another process consumed it;
 * - another process's upgrade intent is live: the locks are released and
 *   this process waits for it (re-reading under the lock), never calling E1;
 * - an intent older than E1's timeout is stale, and is taken over only when
 *   this locked re-read finds no credential and that same intent.
 *
 * Otherwise the identity and the upgrade intent are persisted, the locks are
 * released, and steps 4 to 9 run with the stored session. E1 accepts it once
 * (the auto-upgrade exemption) and deletes it, so a lost answer is reported
 * as needing a browser login, and the session is removed so no later command
 * retries it.
 *
 * @param opts - API URL, stores and test overrides.
 * @returns What happened; never a secret.
 * @throws {NexusAccountError} `E_NEXUS_SESSION_EXPIRED` (browser login
 *   needed), `E_NEXUS_BUSY`, `E_NEXUS_REVOKE_PENDING`, or a §4.0.4 mapping.
 */
export async function upgradeNexusSession(
  opts: NexusDeviceFlowOptions = {},
): Promise<NexusSessionUpgradeResult> {
  const ctx = context(opts);
  const session = await ctx.sessions.get(ctx.apiUrl);
  if (session === null) return { outcome: 'no-session', device: null, warnings: [] };
  const warnings: string[] = [];

  // The user id keys the device entry. A session stored without one needs E2
  // first; that call does not consume the session.
  let userId = session.user?.id ?? null;
  if (userId === null) {
    const me = await probe(ctx, session.bearer());
    if (me.whoami === null) {
      const again = await ctx.sessions.get(ctx.apiUrl);
      if (again === null) return { outcome: 'no-session', device: null, warnings };
      throw me.state === 'refused'
        ? new NexusAccountError(
            'E_NEXUS_SESSION_EXPIRED',
            'the stored Nexus session expired',
            BROWSER_LOGIN_FIX,
          )
        : new NexusAccountError('E_NEXUS_UNREACHABLE', 'Cleo Nexus did not answer', 'retry');
    }
    userId = me.whoami.user.id;
  }

  const owner = newOwner();
  const input: EnrolInput = {
    userId,
    session: session.bearer(),
    profile: 'device',
    kind: 'upgrade',
    owner,
  };
  const deadline = ctx.now().getTime() + ctx.upgradeWaitMs;
  let staleOwner: string | null = null;
  let prepared: Prepared | null = null;
  while (prepared === null) {
    let step: UpgradeStep;
    try {
      step = await upgradeCheck(ctx, session, input, staleOwner, warnings);
    } catch (err) {
      throw storeErrorToAccountError(err);
    }
    if (step.kind === 'enrolled') {
      await retireLeftoverSession(ctx, session, warnings);
      const device = await ctx.devices.get(ctx.apiUrl, userId);
      return { outcome: 'already-enrolled', device, warnings };
    }
    if (step.kind === 'consumed') return { outcome: 'no-session', device: null, warnings };
    if (step.kind === 'go') {
      prepared = step.prepared;
      break;
    }
    if (step.kind === 'stale') {
      // Seen stale once; take it over only if the next locked re-read finds
      // no credential and this same intent.
      staleOwner = step.owner;
      continue;
    }
    staleOwner = null;
    if (ctx.now().getTime() >= deadline) {
      throw new NexusAccountError(
        'E_NEXUS_BUSY',
        'another cleo process is upgrading the stored Nexus session and has not finished',
        'retry the command',
      );
    }
    await ctx.sleep(ctx.upgradePollMs);
  }

  // Step 4 with the stored session, after the intent is persisted: it must
  // still name the same user.
  const me = await probe(ctx, session.bearer());
  if (me.whoami === null || me.whoami.user.id !== userId) {
    await clearIntent(ctx, userId, owner);
    if (me.state === 'unknown') {
      throw new NexusAccountError('E_NEXUS_UNREACHABLE', 'Cleo Nexus did not answer', 'retry');
    }
    await ctx.sessions.delete(ctx.apiUrl, session).catch(() => false);
    throw new NexusAccountError(
      'E_NEXUS_SESSION_EXPIRED',
      me.state === 'refused'
        ? 'the stored Nexus session expired'
        : 'the stored Nexus session belongs to another user than the one recorded',
      BROWSER_LOGIN_FIX,
    );
  }

  let enrolled: Enrolled;
  try {
    enrolled = await enrol(ctx, input, prepared, warnings);
  } catch (err) {
    if (err instanceof NexusAccountError && err.code === 'E_NEXUS_SESSION_EXPIRED') {
      // Never retry an exempt session: remove it (CAS on the token).
      await ctx.sessions.delete(ctx.apiUrl, session).catch(() => false);
    }
    throw err;
  }
  // Step 3: the session is consumed; remove it from the v1 file (CAS).
  await ctx.sessions.delete(ctx.apiUrl, session).catch(() => false);
  // Step 4 of §3.4: E1 deleted the exempt session, so a failed sign-out is expected.
  await finish(ctx, session.bearer(), enrolled.device, true, warnings);
  return { outcome: 'upgraded', device: enrolled.device, warnings };
}

/**
 * A 9.24 session left in the v1 file next to a device credential (a login ran,
 * or another process upgraded): sign it out server-side first, best effort,
 * as a login signs out its own session, then remove it from the v1 file with
 * a CAS on its token. No lock is held during the sign-out.
 */
async function retireLeftoverSession(
  ctx: Ctx,
  session: SealedNexusSession,
  warnings: string[],
): Promise<void> {
  try {
    await signOutNexusSessionToken(
      ctx.apiUrl,
      session.bearer(),
      NEXUS_REVOKE_TIMEOUT_MS,
      ctx.fetch,
    );
  } catch (err) {
    warnings.push(
      `the leftover Cleo Nexus session could not be signed out (${err instanceof Error ? err.message : String(err)}); it was removed locally and expires on its own`,
    );
  }
  try {
    await ctx.sessions.delete(ctx.apiUrl, session);
  } catch (err) {
    throw sessionStoreError(err);
  }
}

/**
 * Map a `nexus-credentials.json` failure to a CLI error: a held lock
 * (`ELOCKED`) is {@link NexusAccountError} `E_NEXUS_BUSY` (security review L4).
 */
function sessionStoreError(err: unknown): Error {
  if (err instanceof Error && 'code' in err && err.code === 'ELOCKED') {
    return new NexusAccountError(
      'E_NEXUS_BUSY',
      'another cleo process holds the Nexus session file',
      'retry the command',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * One locked re-check of §3.4 step 1, device file first, then the v1 file. On
 * `go` it has persisted the identity and the upgrade intent in the same
 * transaction, so no second process can pass the check meanwhile.
 */
async function upgradeCheck(
  ctx: Ctx,
  session: SealedNexusSession,
  input: EnrolInput,
  staleOwner: string | null,
  warnings: string[],
): Promise<UpgradeStep> {
  const unreadable = await unreadableDeviceId(ctx, input.userId);
  return ctx.devices.update(async (tx): Promise<UpgradeStep> => {
    discardIfUnreadable(tx, ctx, input.userId, unreadable);
    warnings.push(...tx.warnings.filter((w) => !warnings.includes(w)));
    const entry = tx.get(ctx.apiUrl, input.userId);
    // A leftover session is signed out and removed after this transaction:
    // no network call is made with the lock held.
    if (entry?.current) return { kind: 'enrolled' };
    const stored = await ctx.sessions.get(ctx.apiUrl);
    if (stored === null || stored.bearer() !== session.bearer()) return { kind: 'consumed' };
    const intent = entry?.enrolIntent ?? null;
    // Any live intent (an upgrade or a login) means another process is about
    // to enrol this identity: wait for it (security review M1, LOW).
    if (intent !== null && intent.owner !== input.owner) {
      const age = ctx.now().getTime() - Date.parse(intent.startedAt);
      if (age < ctx.intentStaleMs) return { kind: 'wait' };
      if (intent.owner !== staleOwner) return { kind: 'stale', owner: intent.owner };
      // Second locked read: no credential and the same stale intent. Take over.
    }
    return { kind: 'go', prepared: prepareInTx(tx, ctx, input, false) };
  });
}

/** Options for {@link ensureNexusDeviceCredential}. */
export interface NexusDeviceCredentialOptions extends NexusDeviceFlowOptions {
  /**
   * The Nexus user whose device credential to use. Without it, the origin
   * must hold exactly one account's credential (security review L2).
   */
  userId?: string;
}

/**
 * The device credential for commands that need one (behind `CLEO_NEXUS_DEVICE=1`).
 *
 * - A 9.24 session still in `nexus-credentials.json` is upgraded first, once
 *   (§3.4); a leftover session next to an existing credential is signed out
 *   and removed.
 * - The account is `opts.userId`, else the upgraded one, else the only one
 *   on the origin; with several, it refuses and lists them.
 * - A racing login's parked credential is settled with E2 first (§3.3 step
 *   7); without an answer the current credential is used and a warning added.
 *
 * @param opts - API URL, account, stores and test overrides.
 * @returns The sealed device entry and whether an upgrade ran.
 * @throws {NexusAccountError} `E_NEXUS_NOT_SIGNED_IN` with no usable
 *   credential, `E_NEXUS_ACCOUNT_AMBIGUOUS`, or the upgrade's errors.
 */
export async function ensureNexusDeviceCredential(
  opts: NexusDeviceCredentialOptions = {},
): Promise<NexusDeviceCredentialHandle> {
  const ctx = context(opts);
  const upgrade = await upgradeNexusSession({
    ...opts,
    apiUrl: ctx.apiUrl,
    deviceStore: ctx.devices,
    store: ctx.sessions,
  });
  const warnings = [...upgrade.warnings];
  const notSignedIn = (): NexusAccountError =>
    new NexusAccountError(
      'E_NEXUS_NOT_SIGNED_IN',
      `not signed in to Cleo Nexus at ${ctx.apiUrl}`,
      'run `cleo login nexus`',
    );
  let userId = opts.userId ?? upgrade.device?.userId ?? null;
  if (userId === null) {
    const origin = nexusOriginKey(ctx.apiUrl);
    const holders = new Set<string>();
    for (const d of await ctx.devices.list()) {
      if (d instanceof UnreadableNexusDevice || d.origin !== origin) continue;
      if (d.currentBearer() !== null || d.unseal().raceCandidate) holders.add(d.userId);
    }
    if (holders.size === 0) throw notSignedIn();
    if (holders.size > 1) {
      throw new NexusAccountError(
        'E_NEXUS_ACCOUNT_AMBIGUOUS',
        `several Cleo Nexus accounts are signed in at ${ctx.apiUrl} on this CLEO home (users ${[...holders].sort().join(', ')}); refusing to pick one`,
        'sign out the accounts you do not use with `cleo logout nexus`, or name the account explicitly',
      );
    }
    userId = [...holders][0] ?? null;
    if (userId === null) throw notSignedIn();
  }
  const settled = await settleRaceCandidate(ctx, userId, warnings);
  if (settled === 'both-refused') throw notSignedIn();
  if (settled === 'unknown' || settled === 'changed') {
    warnings.push(
      'a racing login left two credentials for this device and the server could not say which is live yet; using the current one',
    );
  }
  const device = await ctx.devices.get(ctx.apiUrl, userId);
  if (device === null || device.currentBearer() === null) throw notSignedIn();
  return { device, upgraded: upgrade.outcome === 'upgraded', warnings };
}
