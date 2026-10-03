/**
 * The vault's connection and keys: a read-write device connection, the
 * account master key, this device's certificate, and the stream data keys.
 *
 * Owner decision (2026-10-01): adding a device needs only `cleo login` and
 * the one-time browser approval; that approval also hands the device the
 * encryption key. So the account master key (MK) is escrowed on Cleo Nexus:
 *
 * 1. `GET /v1/account/keys/escrow` returns MK sealed to this device's X25519
 *    key (`sealTo`), released only to an approved, active device. The client
 *    opens it with the device's private key and checks it against the
 *    escrow's verifier.
 * 2. No escrow and no account keys: this is the account's first vault use.
 *    The client mints MK and escrows it (`PUT`, insert-only). A concurrent
 *    first device loses the insert with 409 and reads the winner's key.
 *    Since T13100 `cleo login nexus` runs steps 1 to 4 right after enrolment
 *    ({@link provisionNexusAccount}); `cleo cloud push` still does them for a
 *    device that logged in before that.
 * 3. The device certifies itself under MK (a self-grant, `PUT
 *    /v1/devices/:id/key`), so other devices can verify its snapshots.
 * 4. Signer trust comes from `certifiedSigners` over `GET /v1/devices/trust`,
 *    with the trust state persisted in {@link NexusVaultState}.
 *
 * Threat model (cleo-nexus T082): the escrow `PUT` sends MK to the server
 * over TLS, and the server stores it encrypted under a server-held key
 * (`KEY_ESCROW_SECRET`). Snapshots are therefore encrypted at rest with keys
 * Cleo Nexus can recover: this is server-escrowed encryption, not
 * zero-knowledge end-to-end encryption. What the escrow does guarantee is
 * that MK is released only to an approved, active device of the account,
 * sealed to that device's key.
 *
 * A project's data key (PDK) is minted by its first pusher and stored
 * wrapped by MK (`PUT /v1/projects/:id/keys/:userId`); the home stream key
 * is derived from MK.
 *
 * No function here logs a key, and no error carries one.
 *
 * @task T12336
 * @task T13100
 * @epic T12322
 */

import type { CloudWarning, NexusAccountSetup, NexusAccountSetupStep } from '@cleocode/contracts';
import { nexusProjectKeysSchema, nexusUserKeysSchema } from '@cleocode/contracts';
import {
  type DeviceTrust,
  DeviceTrust as DeviceTrustSchema,
  KeyEscrowGrant,
  PutKeyEscrowResult,
} from '@cleocode/contracts/cloud';
import { z } from 'zod';
import { type KeyPair, openSealed, randomKey } from './crypto.js';
import { type FetchLike, Http, NexusError, type ResponseSchema } from './http.js';
import {
  certifiedSigners,
  createDeviceGrant,
  homeStreamKey,
  masterKeyVerifier,
  newProjectKey,
  type TrustedSigners,
  unwrapProjectKey,
  wrapProjectKey,
} from './keys.js';
import { NexusAccountError, resolveNexusApiUrl } from './nexus-auth.js';
import {
  assertNexusCloudDeviceMode,
  NEXUS_CLOUD_TIMEOUT_MS,
  type NexusCloudOptions,
  nexusCredentialWarnings,
} from './nexus-cloud.js';
import type { SealedNexusDevice } from './nexus-device.js';
import { ensureNexusDeviceCredential, nexusApiErrorToAccountError } from './nexus-enrol.js';
import { NexusVaultState } from './nexus-vault-state.js';

/** Timeout of a snapshot blob upload or download. */
export const NEXUS_VAULT_BLOB_TIMEOUT_MS = 10 * 60_000;

/** The sealed-box context of an escrow release (must match the server, cleo-nexus T082). */
export const escrowContext = (userId: string, deviceId: string) =>
  `cleo-nexus/escrow/v1:${userId}:${deviceId}`;

/** Options of every vault command. */
export interface NexusVaultOptions extends NexusCloudOptions {
  /** Vault state store (tests). */
  vaultState?: NexusVaultState;
  /** Timeout of a blob transfer; default {@link NEXUS_VAULT_BLOB_TIMEOUT_MS}. */
  blobTimeoutMs?: number;
}

/** A read-write connection with this machine's device credential and keys. */
export interface NexusVaultConnection {
  readonly apiUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly device: SealedNexusDevice;
  /** Device keys: X25519 for sealed boxes, Ed25519 for signatures. */
  readonly keys: { encryption: KeyPair; signing: KeyPair };
  /** The authenticated client (sends `X-Cleo-Device-Id`). For the journal. */
  readonly http: Http;
  /** `fetch` for presigned blob transfers (long timeout, no credential). */
  readonly blobFetch: FetchLike;
  readonly state: NexusVaultState;
  readonly warnings: CloudWarning[];
  /** A request whose failure stays a raw {@link NexusError} (callers handle server codes). */
  raw<T>(method: string, path: string, schema: ResponseSchema<T>, body?: unknown): Promise<T>;
  /** {@link NexusVaultConnection.raw}, with failures mapped to {@link NexusAccountError}. */
  call<T>(method: string, path: string, schema: ResponseSchema<T>, body?: unknown): Promise<T>;
  /** `GET`, mapped; a 404 answers `null`. */
  find<T>(path: string, schema: ResponseSchema<T>): Promise<T | null>;
}

const b64 = (s: string) => Buffer.from(s, 'base64');

function keyPairOf(kp: { publicKey: string; privateKey: string }): KeyPair {
  return { publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) };
}

/**
 * Open a read-write vault connection with this machine's device credential.
 *
 * @param opts - API URL, account, stores and test overrides.
 * @returns The connection.
 * @throws {NexusAccountError} Not signed in, device mode off, or no device keys.
 */
export async function connectNexusVault(
  opts: NexusVaultOptions = {},
): Promise<NexusVaultConnection> {
  assertNexusCloudDeviceMode();
  const apiUrl = resolveNexusApiUrl(opts.apiUrl);
  const handle = await ensureNexusDeviceCredential({ ...opts, apiUrl });
  return vaultConnectionOf(handle.device, apiUrl, opts, handle.warnings);
}

/** A vault connection acting as `device` (its current credential and keys). */
function vaultConnectionOf(
  device: SealedNexusDevice,
  apiUrl: string,
  opts: NexusVaultOptions,
  credentialWarnings: readonly string[],
): NexusVaultConnection {
  const bearer = device.currentBearer();
  if (bearer === null) {
    throw new NexusAccountError(
      'E_NEXUS_NOT_SIGNED_IN',
      `not signed in to Cleo Nexus at ${apiUrl}`,
      'run `cleo login nexus`',
    );
  }
  const entryKeys = device.unseal().keys;
  if (entryKeys === null) {
    throw new NexusAccountError(
      'E_NEXUS_VAULT_KEY_UNAVAILABLE',
      'this device has no key pair (it was enrolled before device keys existed)',
      'run `cleo logout nexus --revoke` and then `cleo login nexus` to enrol it again',
    );
  }
  const base: FetchLike =
    opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? NEXUS_CLOUD_TIMEOUT_MS;
  const blobTimeoutMs = opts.blobTimeoutMs ?? NEXUS_VAULT_BLOB_TIMEOUT_MS;
  const http = new Http({
    baseUrl: apiUrl,
    token: bearer,
    deviceId: device.deviceId,
    fetch: (input, init) => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    maxAttempts: 2,
  });
  const raw = <T>(method: string, path: string, schema: ResponseSchema<T>, body?: unknown) =>
    http.request(method, path, schema, body);
  return {
    apiUrl,
    userId: device.userId,
    deviceId: device.deviceId,
    device,
    keys: { encryption: keyPairOf(entryKeys.encryption), signing: keyPairOf(entryKeys.signing) },
    http,
    blobFetch: (input, init) =>
      base(input, { ...init, signal: AbortSignal.timeout(blobTimeoutMs) }),
    state: opts.vaultState ?? new NexusVaultState(),
    warnings: nexusCredentialWarnings(credentialWarnings),
    raw,
    async call<T>(method: string, path: string, schema: ResponseSchema<T>, body?: unknown) {
      try {
        return await raw(method, path, schema, body);
      } catch (err) {
        throw nexusApiErrorToAccountError(err);
      }
    },
    async find<T>(path: string, schema: ResponseSchema<T>) {
      try {
        return await raw('GET', path, schema);
      } catch (err) {
        if (err instanceof NexusError && err.status === 404) return null;
        throw nexusApiErrorToAccountError(err);
      }
    },
  };
}

/** The unlocked account key and the signers this device trusts. */
export interface NexusAccountKey {
  masterKey: Buffer;
  keyVersion: number;
  signers: TrustedSigners;
}

const isConflict = (err: unknown, reason?: string) =>
  err instanceof NexusError &&
  err.status === 409 &&
  (reason === undefined || err.details?.['reason'] === reason);

function keyUnavailable(message: string, fix?: string): NexusAccountError {
  return new NexusAccountError('E_NEXUS_VAULT_KEY_UNAVAILABLE', message, fix);
}

/**
 * The server answered 404 because it has no such route, not because the resource is missing: its
 * fallback handler says `E_NOT_FOUND` "route not found" (cleo-nexus app.notFound), while a missing
 * escrow is "key escrow not found" (T13049).
 */
function isRouteMissing(err: unknown): boolean {
  return (
    err instanceof NexusError &&
    err.status === 404 &&
    err.code === 'E_NOT_FOUND' &&
    err.serverMessage === 'route not found'
  );
}

/** A Cleo Nexus server older than account key escrow (cleo-nexus T082) cannot hold a vault (T13049). */
function vaultUnsupported(): NexusAccountError {
  return new NexusAccountError(
    'E_NEXUS_VAULT_UNSUPPORTED',
    'this Cleo Nexus server does not support the cloud vault yet: it has no account key escrow',
    'upgrade the Cleo Nexus server (account key escrow, cleo-nexus T082), or point CLEO at one that has it; nothing was written',
  );
}

async function openEscrow(conn: NexusVaultConnection): Promise<{ mk: Buffer; kv: number } | null> {
  let grant: z.infer<typeof KeyEscrowGrant>;
  try {
    grant = await conn.raw('GET', '/v1/account/keys/escrow', KeyEscrowGrant);
  } catch (err) {
    if (isRouteMissing(err)) throw vaultUnsupported();
    // A supporting server with nothing escrowed yet: the account has no vault key. Only the
    // server's own E_NOT_FOUND counts; a 404 page from something else (a proxy, a wrong
    // --api-url) is a failed request, never an empty vault.
    if (err instanceof NexusError && err.status === 404 && err.code === 'E_NOT_FOUND') return null;
    throw nexusApiErrorToAccountError(err);
  }
  if (grant.deviceId !== conn.deviceId) {
    throw keyUnavailable('the server released the account key to another device id');
  }
  let mk: Buffer;
  try {
    mk = openSealed(
      conn.keys.encryption,
      b64(grant.sealedMasterKey),
      escrowContext(conn.userId, conn.deviceId),
    );
  } catch {
    throw keyUnavailable(
      'the escrowed account key does not open with this device key',
      'run `cleo logout nexus --revoke` and `cleo login nexus` to enrol this machine again',
    );
  }
  if (mk.length !== 32 || masterKeyVerifier(mk) !== grant.masterKeyVerifier) {
    throw keyUnavailable('the escrowed account key does not match its verifier');
  }
  return { mk, kv: grant.keyVersion };
}

/**
 * Mint the account master key and escrow it (insert-only). `adopted` is `true` when another
 * device escrowed first (409): its key is read and used, and this device never mints again.
 */
async function mintEscrow(
  conn: NexusVaultConnection,
): Promise<{ mk: Buffer; kv: number; adopted: boolean }> {
  const existing = await conn.find('/v1/account/keys', nexusUserKeysSchema);
  if (existing !== null) {
    throw keyUnavailable(
      'this account has an encryption key that is not escrowed, so it cannot be handed to this device',
      'run `cleo cloud push` once on a device that already holds the key, so it escrows it',
    );
  }
  const mk = randomKey();
  try {
    await conn.raw('PUT', '/v1/account/keys/escrow', PutKeyEscrowResult, {
      masterKey: mk.toString('base64url'),
      keyVersion: 1,
      masterKeyVerifier: masterKeyVerifier(mk),
    });
    return { mk, kv: 1, adopted: false };
  } catch (err) {
    // Backstop: unreachable while GET and PUT escrow ship together (cleo-nexus #24), since
    // openEscrow already refused; kept for a server that exposes one without the other.
    if (isRouteMissing(err)) throw vaultUnsupported();
    if (!isConflict(err)) throw nexusApiErrorToAccountError(err);
    // Another device escrowed first: use its key.
    const won = await openEscrow(conn);
    if (won === null)
      throw keyUnavailable('the account key was escrowed concurrently but is not readable');
    return { ...won, adopted: true };
  }
}

/** Certify this device under MK unless it already is; `wrote` says whether this call did. */
async function ensureCertified(
  conn: NexusVaultConnection,
  mk: Buffer,
  kv: number,
): Promise<{ trust: DeviceTrust; wrote: boolean }> {
  const trust = await conn.call('GET', '/v1/devices/trust', DeviceTrustSchema);
  const mine = conn.keys.signing.publicKey.toString('base64');
  const certified = trust.certificates.some(
    (c) =>
      c.deviceId === conn.deviceId && c.keyVersion === kv && c.signingPublicKey === mine && c.live,
  );
  if (certified) return { trust, wrote: false };
  const grant = createDeviceGrant({
    masterKey: mk,
    userId: conn.userId,
    keyVersion: kv,
    recipient: {
      deviceId: conn.deviceId,
      encryptionPublicKey: conn.keys.encryption.publicKey,
      signingPublicKey: conn.keys.signing.publicKey,
    },
    signer: { deviceId: conn.deviceId, signing: conn.keys.signing },
  });
  await conn.call(
    'PUT',
    `/v1/devices/${encodeURIComponent(conn.deviceId)}/key`,
    z.looseObject({}),
    grant,
  );
  return { trust: await conn.call('GET', '/v1/devices/trust', DeviceTrustSchema), wrote: true };
}

/**
 * Get the account master key for this device, minting and escrowing it on
 * the account's first vault use, and certify this device under it.
 *
 * @param conn - A vault connection.
 * @param opts - `readOnly`: never mint, escrow or certify (GET only); a missing escrow is
 *   `E_NEXUS_VAULT_EMPTY`.
 * @returns The key, its version and the trusted signers.
 * @throws {NexusAccountError} `E_NEXUS_VAULT_KEY_UNAVAILABLE` when the key
 *   cannot be obtained or verified; `E_NEXUS_VAULT_UNSUPPORTED` when the server
 *   has no key escrow route; a mapped API error otherwise.
 */
export async function unlockNexusAccountKey(
  conn: NexusVaultConnection,
  opts: { readOnly?: boolean } = {},
): Promise<NexusAccountKey> {
  return (await unlockAccount(conn, opts.readOnly === true, { step: 'escrow-read' })).key;
}

/** How {@link unlockAccount} obtained the key; holds the key itself, so never print it. */
interface UnlockedAccount {
  key: NexusAccountKey;
  escrow: 'fetched' | 'minted' | 'adopted';
  /** `null` on a read-only unlock (nothing certified). */
  certificate: 'new' | 'existing' | null;
}

/**
 * {@link unlockNexusAccountKey}, reporting how the key was obtained. `progress.step` names the
 * step running, so a caller that catches a failure can say where it happened.
 */
async function unlockAccount(
  conn: NexusVaultConnection,
  readOnly: boolean,
  progress: { step: NexusAccountSetupStep },
): Promise<UnlockedAccount> {
  progress.step = 'escrow-read';
  const escrowed = await openEscrow(conn);
  if (escrowed === null && readOnly) {
    // Nothing was ever pushed from any device: a read has nothing to read, and
    // must not mint the account key as a side effect.
    throw new NexusAccountError(
      'E_NEXUS_VAULT_EMPTY',
      'the cloud vault is empty: no device has pushed a snapshot to this account yet',
      'run `cleo cloud push` on a device that has the data',
    );
  }
  let unlocked: { mk: Buffer; kv: number };
  let escrow: UnlockedAccount['escrow'];
  if (escrowed !== null) {
    unlocked = escrowed;
    escrow = 'fetched';
  } else {
    // The account's first device. Since T13100 `cleo login nexus` does this right after
    // enrolment; a push still gets here for a device that logged in before that.
    progress.step = 'escrow-mint';
    const minted = await mintEscrow(conn);
    unlocked = minted;
    escrow = minted.adopted ? 'adopted' : 'minted';
  }
  progress.step = 'certify';
  let trust: DeviceTrust;
  let certificate: UnlockedAccount['certificate'] = null;
  if (readOnly) {
    trust = await conn.call('GET', '/v1/devices/trust', DeviceTrustSchema);
  } else {
    const certified = await ensureCertified(conn, unlocked.mk, unlocked.kv);
    trust = certified.trust;
    certificate = certified.wrote ? 'new' : 'existing';
  }
  progress.step = 'trust';
  // Read, evaluate and persist the trust state under one lock, so two
  // concurrent commands cannot interleave and lose a narrowed pin.
  const evaluation = conn.state.updateTrust(conn.apiUrl, conn.userId, (current) => {
    const e = certifiedSigners(
      new Map([[unlocked.kv, unlocked.mk]]),
      conn.userId,
      trust,
      current,
      unlocked.kv,
    );
    return { trust: e.keyRotated || e.serverError ? current : e.state, result: e };
  });
  if (evaluation.keyRotated || evaluation.serverError) {
    throw keyUnavailable(
      evaluation.keyRotated
        ? 'the account key was rotated and this device does not hold the new one'
        : 'the server declared an account key version no rotation explains',
    );
  }
  return {
    key: { masterKey: unlocked.mk, keyVersion: unlocked.kv, signers: evaluation.signers },
    escrow,
    certificate,
  };
}

/** Options of {@link provisionNexusAccount}. */
export interface ProvisionNexusAccountOptions extends NexusVaultOptions {
  /**
   * The device entry to act as. `cleo login nexus` passes the entry it just
   * stored, so the setup runs on that new device credential (the escrow routes
   * accept only device credentials). Default: the stored credential, as
   * {@link connectNexusVault} finds it.
   */
  device?: SealedNexusDevice;
}

/** What each setup step does, for a failure message. */
const SETUP_STEP_LABELS: Readonly<Record<NexusAccountSetupStep, string>> = {
  connect: 'opening the vault connection with the device credential',
  'escrow-read': 'reading the escrowed account key',
  'escrow-mint': 'creating and escrowing the account key',
  certify: 'certifying this device under the account key',
  trust: 'recording the device trust state',
};

/** The remedy of a failed setup step whose error carried none. */
const SETUP_RETRY_FIX =
  'run `cleo login nexus` again; `cleo cloud push` also finishes the setup on this device';

/**
 * Make the account ready for encrypted backups on this device (onboarding A,
 * T13100): read the escrowed account master key, or mint and escrow it when
 * the account has none (a 409 means another device won: its key is read,
 * never re-minted), then certify this device under it and record the signer
 * trust state in {@link NexusVaultState}. It is {@link unlockNexusAccountKey}
 * with a report, so a later `cleo cloud push` finds everything in place and
 * mints nothing; it is idempotent.
 *
 * It never throws: a server without key escrow answers `unsupported`, any
 * other failure answers `failed` with the step and the remedy. No key is in
 * the result.
 *
 * @param opts - API URL, stores, the device to act as, and test overrides.
 * @returns What the setup did.
 */
export async function provisionNexusAccount(
  opts: ProvisionNexusAccountOptions = {},
): Promise<NexusAccountSetup> {
  const progress: { step: NexusAccountSetupStep } = { step: 'connect' };
  try {
    const conn =
      opts.device !== undefined
        ? vaultConnectionOf(opts.device, resolveNexusApiUrl(opts.apiUrl), opts, [])
        : await connectNexusVault(opts);
    const unlocked = await unlockAccount(conn, false, progress);
    const how =
      unlocked.escrow === 'minted'
        ? 'the account key was created and escrowed on Cleo Nexus'
        : 'this device received the account key from Cleo Nexus escrow';
    return {
      status: 'ready',
      escrow: unlocked.escrow,
      certificate: unlocked.certificate ?? 'existing',
      keyVersion: unlocked.key.keyVersion,
      summary: `Your account is ready for encrypted backups: ${how}, and this device is certified to use it.`,
    };
  } catch (err) {
    if (err instanceof NexusAccountError && err.code === 'E_NEXUS_VAULT_UNSUPPORTED') {
      const fix = err.fix ?? 'upgrade the Cleo Nexus server';
      return {
        status: 'unsupported',
        code: err.code,
        fix,
        summary: `signed in, but encrypted backups are not available: ${err.message}. Fix: ${fix}`,
      };
    }
    const code = err instanceof NexusAccountError ? err.code : 'E_NEXUS_REQUEST_FAILED';
    const message = err instanceof Error ? err.message : String(err);
    const fix = (err instanceof NexusAccountError ? err.fix : undefined) ?? SETUP_RETRY_FIX;
    const step = progress.step;
    return {
      status: 'failed',
      step,
      code,
      message,
      fix,
      summary: `signed in, but encrypted backups are not set up: step ${step} (${SETUP_STEP_LABELS[step]}) failed with ${code}: ${message}. Fix: ${fix}`,
    };
  }
}

/**
 * The data key of a project stream: unwrap the newest wrapped key, or mint
 * and store one when the project has none yet (its first push).
 *
 * @param conn - A vault connection.
 * @param mk - The unlocked master key.
 * @param projectId - The server's project id.
 * @param mint - Whether a missing key may be created (push: yes; restore: no).
 * @returns The project data key, or `null` when none exists and `mint` is false.
 */
export async function nexusProjectDataKey(
  conn: NexusVaultConnection,
  mk: Buffer,
  projectId: string,
  mint: boolean,
): Promise<Buffer | null> {
  const path = `/v1/projects/${encodeURIComponent(projectId)}/keys`;
  const read = async () => {
    const list = await conn.find(path, nexusProjectKeysSchema);
    const newest = list?.keys[0];
    if (!newest) return null;
    try {
      return unwrapProjectKey(mk, newest.wrappedProjectKey, projectId, newest.keyVersion);
    } catch {
      throw keyUnavailable(`the project key of ${projectId} does not open with this account's key`);
    }
  };
  const have = await read();
  if (have !== null || !mint) return have;
  const pdk = newProjectKey();
  try {
    await conn.raw('PUT', `${path}/${encodeURIComponent(conn.userId)}`, z.looseObject({}), {
      wrappedProjectKey: wrapProjectKey(mk, pdk, projectId, 1),
      keyVersion: 1,
    });
    return pdk;
  } catch (err) {
    if (!isConflict(err)) throw nexusApiErrorToAccountError(err);
    const won = await read();
    if (won === null) throw keyUnavailable(`the project key of ${projectId} is not readable`);
    return won;
  }
}

/**
 * The data key of the account's `home:` stream (derived from MK, never stored).
 *
 * @param mk - The unlocked master key.
 * @returns The home stream key.
 */
export function nexusHomeDataKey(mk: Buffer): Buffer {
  return homeStreamKey(mk);
}

/** Re-export for callers that only need the URL resolver. */
export { resolveNexusApiUrl };
