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
 * @epic T12322
 */

import type { CloudWarning } from '@cleocode/contracts';
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
  const device = handle.device;
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
    warnings: nexusCredentialWarnings(handle.warnings),
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

async function mintEscrow(conn: NexusVaultConnection): Promise<{ mk: Buffer; kv: number }> {
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
    return { mk, kv: 1 };
  } catch (err) {
    // Backstop: unreachable while GET and PUT escrow ship together (cleo-nexus #24), since
    // openEscrow already refused; kept for a server that exposes one without the other.
    if (isRouteMissing(err)) throw vaultUnsupported();
    if (!isConflict(err)) throw nexusApiErrorToAccountError(err);
    // Another device escrowed first: use its key.
    const won = await openEscrow(conn);
    if (won === null)
      throw keyUnavailable('the account key was escrowed concurrently but is not readable');
    return won;
  }
}

async function ensureCertified(
  conn: NexusVaultConnection,
  mk: Buffer,
  kv: number,
): Promise<DeviceTrust> {
  const trust = await conn.call('GET', '/v1/devices/trust', DeviceTrustSchema);
  const mine = conn.keys.signing.publicKey.toString('base64');
  const certified = trust.certificates.some(
    (c) =>
      c.deviceId === conn.deviceId && c.keyVersion === kv && c.signingPublicKey === mine && c.live,
  );
  if (certified) return trust;
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
  return conn.call('GET', '/v1/devices/trust', DeviceTrustSchema);
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
  const escrowed = await openEscrow(conn);
  if (escrowed === null && opts.readOnly === true) {
    // Nothing was ever pushed from any device: a read has nothing to read, and
    // must not mint the account key as a side effect.
    throw new NexusAccountError(
      'E_NEXUS_VAULT_EMPTY',
      'the cloud vault is empty: no device has pushed a snapshot to this account yet',
      'run `cleo cloud push` on a device that has the data',
    );
  }
  const unlocked = escrowed ?? (await mintEscrow(conn));
  const trust =
    opts.readOnly === true
      ? await conn.call('GET', '/v1/devices/trust', DeviceTrustSchema)
      : await ensureCertified(conn, unlocked.mk, unlocked.kv);
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
  return { masterKey: unlocked.mk, keyVersion: unlocked.kv, signers: evaluation.signers };
}

/**
 * Why Cleo Nexus refused this device's first key for a project (403), as an
 * account error with a remedy, or `null` for any other failure. A device may
 * create only version 1, of a keyless project its own user registered
 * (cleo-nexus #33); this function is reached only when this account holds no
 * key for the project (T13098).
 */
function refusedFirstKey(err: unknown, projectId: string): NexusAccountError | null {
  if (!(err instanceof NexusError) || err.status !== 403) return null;
  switch (err.details?.['reason']) {
    case 'not-registrant':
      return keyUnavailable(
        `project ${projectId} has no key yet, and only a device of the account that registered it may create the first one`,
        'run the first `cleo cloud push` from a device of the account that first ran `cleo project link` for this project',
      );
    case 'session-required':
      return keyUnavailable(
        `project ${projectId} already has a key, but it has not been shared with this account`,
        'ask the project owner to share the project key with this account',
      );
    case 'project-role':
      // Checked before the server knows whether the project has a key, so an owner may already
      // have created one and not shared it with this account.
      return keyUnavailable(
        `this account holds no key for project ${projectId}, and only a project owner can create one`,
        'ask a project owner to share the project key with this account, or, if the project has no key yet, to run the first `cleo cloud push`',
      );
    default:
      return null;
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
      // Cleo Nexus accepts a new key version, the first one included, only as a rotation naming
      // the current highest version (cleo-nexus T12856). The two fields stay out of the shared
      // contract until cleo-nexus adds them there too (T064), as the server does.
      rotate: true,
      expectedMax: 0,
    });
    return pdk;
  } catch (err) {
    const refused = refusedFirstKey(err, projectId);
    if (refused) throw refused;
    if (isConflict(err, 'rotation-stale') || isConflict(err, 'keys-exist')) {
      // Another device created version 1 first: use its key (T13098).
      const won = await read();
      if (won === null) {
        throw keyUnavailable(
          `the project key of ${projectId} was created by another account and has not been shared with this one`,
          'ask the project owner to share the project with this account',
        );
      }
      return won;
    }
    if (isConflict(err)) {
      const e = err as NexusError;
      const reason = typeof e.details?.['reason'] === 'string' ? ` (${e.details['reason']})` : '';
      throw keyUnavailable(
        `Cleo Nexus refused to store the project key of ${projectId}${reason}: ${e.serverMessage}`,
      );
    }
    throw nexusApiErrorToAccountError(err);
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
