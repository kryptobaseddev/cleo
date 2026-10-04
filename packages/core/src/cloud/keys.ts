import type {
  CreateDeviceRevocationRequest,
  DeviceTrust,
  PutDeviceWrappedKeyRequest,
  RevocationPins,
} from '@cleocode/contracts/cloud';
import {
  constantTimeEqual,
  DecryptError,
  decodeRecoveryKey,
  deriveKey,
  encodeRecoveryKey,
  hmacSha256,
  type KdfParams,
  type KeyPair,
  newKdfParams,
  open,
  openSealed,
  passphraseKey,
  randomKey,
  seal,
  sealTo,
  sha256Hex,
  signEd25519,
  verifyEd25519,
} from './crypto.js';
import {
  deviceCertificateMessage,
  deviceGrantMessage,
  deviceRevocationMessage,
  revocationPinsCanonical,
} from './signing.js';

/** What the server stores for a user (PutUserKeysRequest). Nothing here opens without a secret. */
export interface StoredUserKeys {
  passphraseWrappedMasterKey: string;
  kdf: KdfParams;
  recoveryWrappedMasterKey: string;
  masterKeyVerifier: string;
  keyVersion: number;
}

const mkContext = (userId: string, v: number) => `mk\n${userId}\n${v}`;
const pdkContext = (projectId: string, v: number) => `pdk\n${projectId}\n${v}`;
const deviceContext = (userId: string, deviceId: string, v: number) =>
  `device-mk\n${userId}\n${deviceId}\n${v}`;

export const masterKeyVerifier = (mk: Uint8Array) => sha256Hex(deriveKey(mk, 'verifier'));

/**
 * First-device setup: mint the master key and wrap it by passphrase and by a new recovery key.
 * Show `recoveryKey` to the user exactly once.
 */
export async function createUserKeys(
  userId: string,
  passphrase: string,
  keyVersion = 1,
): Promise<{ masterKey: Buffer; recoveryKey: string; stored: StoredUserKeys }> {
  if (passphrase.length < 12) throw new Error('passphrase must be at least 12 characters');
  const masterKey = randomKey();
  const recovery = randomKey();
  const kdf = newKdfParams();
  const pwk = await passphraseKey(passphrase, kdf);
  const ctx = mkContext(userId, keyVersion);
  return {
    masterKey,
    recoveryKey: encodeRecoveryKey(recovery),
    stored: {
      passphraseWrappedMasterKey: seal(pwk, masterKey, 'mk-wrap', ctx).toString('base64'),
      kdf,
      recoveryWrappedMasterKey: seal(recovery, masterKey, 'mk-wrap', ctx).toString('base64'),
      masterKeyVerifier: masterKeyVerifier(masterKey),
      keyVersion,
    },
  };
}

function checkVerifier(mk: Buffer, stored: StoredUserKeys): Buffer {
  if (
    !constantTimeEqual(Buffer.from(masterKeyVerifier(mk)), Buffer.from(stored.masterKeyVerifier))
  ) {
    throw new DecryptError('master key does not match its verifier');
  }
  return mk;
}

export async function unlockWithPassphrase(
  userId: string,
  stored: StoredUserKeys,
  passphrase: string,
) {
  const pwk = await passphraseKey(passphrase, stored.kdf);
  try {
    const mk = open(
      pwk,
      Buffer.from(stored.passphraseWrappedMasterKey, 'base64'),
      'mk-wrap',
      mkContext(userId, stored.keyVersion),
    );
    return checkVerifier(mk, stored);
  } catch (err) {
    if (err instanceof DecryptError) throw new DecryptError('wrong passphrase');
    throw err;
  }
}

export function unlockWithRecoveryKey(
  userId: string,
  stored: StoredUserKeys,
  recoveryKey: string,
): Buffer {
  const rk = decodeRecoveryKey(recoveryKey);
  const mk = open(
    rk,
    Buffer.from(stored.recoveryWrappedMasterKey, 'base64'),
    'mk-wrap',
    mkContext(userId, stored.keyVersion),
  );
  return checkVerifier(mk, stored);
}

/** Re-wrap the master key under a new passphrase (for example after a recovery-key unlock). */
export async function rewrapPassphrase(
  userId: string,
  mk: Buffer,
  stored: StoredUserKeys,
  newPassphrase: string,
): Promise<StoredUserKeys> {
  const kdf = newKdfParams();
  const pwk = await passphraseKey(newPassphrase, kdf);
  return {
    ...stored,
    kdf,
    passphraseWrappedMasterKey: seal(
      pwk,
      mk,
      'mk-wrap',
      mkContext(userId, stored.keyVersion),
    ).toString('base64'),
  };
}

// ---------- device trust (docs/security/e2e-keys.md, "Device trust") ----------

/** A device's public identity, as raw key bytes. */
export interface DevicePublicKeys {
  deviceId: string;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
}

/** A grant or certificate that does not come from a trusted master key holder. Never retry it blindly. */
export class KeyTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyTrustError';
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const certMessage = (userId: string, d: DevicePublicKeys, keyVersion: number) =>
  deviceCertificateMessage({
    userId,
    deviceId: d.deviceId,
    encryptionPublicKeyHex: hex(d.encryptionPublicKey),
    signingPublicKeyHex: hex(d.signingPublicKey),
    keyVersion,
  });

/**
 * Certify a device under the master key: HMAC-SHA256 keyed by HKDF(MK, "device-cert"). Only a holder of
 * the master key can make one, so the server cannot add a device of its own to the set a client trusts.
 */
export function deviceCertificate(
  mk: Uint8Array,
  userId: string,
  device: DevicePublicKeys,
  keyVersion: number,
) {
  return hmacSha256(deriveKey(mk, 'device-cert'), certMessage(userId, device, keyVersion));
}

export function verifyDeviceCertificate(
  mk: Uint8Array,
  userId: string,
  device: DevicePublicKeys,
  keyVersion: number,
  certificate: Uint8Array,
): boolean {
  return constantTimeEqual(deviceCertificate(mk, userId, device, keyVersion), certificate);
}

/**
 * One signing key a client trusts for a device. `pin` is null for a live key. A revoked key keeps a pin:
 * its signatures are accepted up to the pinned replicaSeq per replica and the pinned checkpoint coversSeq
 * per stream, and refused past them. `pending` marks a certified key that is no longer live but has no
 * revocation record yet (only returned with `includePending`, for writing that record).
 */
export interface SignerKey {
  publicKey: Uint8Array;
  pin: RevocationPins | null;
  pending?: boolean;
}

/** Trusted signers by device id. A bare key stands for one live key (a device's own key, for example). */
export type TrustedSigners = ReadonlyMap<string, Uint8Array | readonly SignerKey[]>;

/** The keys trusted for `deviceId`, normalized. */
export function signerKeys(trusted: TrustedSigners, deviceId: string): readonly SignerKey[] {
  const v = trusted.get(deviceId);
  if (!v) return [];
  return v instanceof Uint8Array ? [{ publicKey: v, pin: null }] : v;
}

/** Keys that may vouch for new things (grants, endorsements): live and unpinned. */
export const liveKeys = (trusted: TrustedSigners, deviceId: string) =>
  signerKeys(trusted, deviceId).filter((k) => k.pin === null && !k.pending);

const utf8 = (s: string) => Buffer.from(s, 'utf8');

/** Where two pins agree: only entries in both, at the lower bound. Used when several records revoke one key. */
function narrowerPins(a: RevocationPins, b: RevocationPins): RevocationPins {
  const both = (x: Record<string, number>, y: Record<string, number>) =>
    Object.fromEntries(
      Object.keys(x)
        .filter((k) => k in y)
        .map((k) => [k, Math.min(x[k] as number, y[k] as number)]),
    );
  return {
    replicas: both(a.replicas, b.replicas),
    checkpoints: both(a.checkpoints, b.checkpoints),
  };
}

/** Master keys by key version. Certificates made under older versions verify under their own key. */
export type MasterKeys = ReadonlyMap<number, Uint8Array>;

/**
 * What a client has learned about signer trust, persisted with the pull cursor (same local transaction)
 * and passed back to every certifiedSigners call. Trust only ever tightens through it: the server can
 * withhold a record or flip its `live` claims, but it cannot make the client forget what it has seen.
 * Key ids are `${deviceId}/${hex of the Ed25519 public key}`.
 */
export interface TrustState {
  /**
   * The highest master key version this client holds or has proven (by unlocking it). Only such versions are
   * persisted: a version the server merely declares is used for one call and never stored, so one bad
   * response cannot brick the device. Live trust needs a certificate at the current version.
   */
  keyVersion: number;
  /** The last pins seen per revoked key. A key seen pinned is never live again. */
  pins: Record<string, RevocationPins>;
  /** Every key seen as the target of a valid revocation record. Never live again. Sorted. */
  revoked: string[];
}

export const initialTrustState = (): TrustState => ({ keyVersion: 0, pins: {}, revoked: [] });

/**
 * How far a declared account key version may exceed the highest version this client holds or has proven.
 * A rotation bumps the version by one, so an honest server is never more than one ahead of a device that
 * has seen the previous rotation. A device that missed two rotations sees a server error (and fails closed);
 * it needs a passphrase unlock anyway, to fetch the new master key.
 */
export const MAX_ROTATION_STEP = 1;

export interface TrustEvaluation {
  signers: Map<string, SignerKey[]>;
  /** Persist this with the pull cursor, in the same local transaction. */
  state: TrustState;
  /**
   * The account's key version is ahead of every master key this client holds: nothing is live. Tell the
   * user "the account key was rotated: unlock with your passphrase to fetch the new master key".
   */
  keyRotated: boolean;
  /**
   * The server declared a key version no rotation can explain (more than MAX_ROTATION_STEP above what this
   * client holds or has proven). Not a rotation: nothing is persisted, and nothing is live in this call.
   */
  serverError?: 'implausible-key-version';
}

/**
 * Update TrustState after a successful passphrase or recovery-key unlock, the only proof of the account's
 * real key version. It requires proof of possession: the unwrapped master key must match `stored`'s
 * verifier (and the unwrap itself already checked the AAD, which binds the user and the version).
 * - `keyVersion` becomes the proven version, if it is higher (an older genuine wrap never lowers it).
 * - Seen pins are cleared **only** with `confirmedPinReset: true`, after the user explicitly confirms it (for
 *   example, when a thief's record narrowed a pin while the stolen device was still live). The confirmation
 *   prompt must tell the user to revoke the thief's device FIRST: while it is live, its records still count
 *   and would narrow the pins again. The next
 *   certifiedSigners call then takes pins from the records live devices have signed.
 * - The seen-revoked set is never cleared: revocation is monotonic.
 */
export function resetTrustStateAfterUnlock(
  state: TrustState,
  proof: {
    masterKey: Uint8Array;
    stored: Pick<StoredUserKeys, 'masterKeyVerifier' | 'keyVersion'>;
  },
  opts: { confirmedPinReset?: boolean } = {},
): TrustState {
  if (
    !constantTimeEqual(
      Buffer.from(masterKeyVerifier(proof.masterKey)),
      Buffer.from(proof.stored.masterKeyVerifier),
    )
  ) {
    throw new KeyTrustError(
      'the master key does not match its verifier: no proof of the key version',
    );
  }
  return {
    // Never lower: an older genuine wrap (a replayed pre-rotation one) proves only that older version.
    keyVersion: Math.max(state.keyVersion, proof.stored.keyVersion),
    pins: opts.confirmedPinReset === true ? {} : { ...state.pins },
    revoked: [...state.revoked],
  };
}

/**
 * The trusted signer set, built from `GET /v1/devices/trust`, the master keys the client holds and its
 * persisted TrustState. Build the set for pulls, checkpoints and grants from this, never from the server's
 * device list alone. Persist the returned state. The rules (docs/security/e2e-keys.md, "Revocation"):
 * - A key is certified if a certificate for it verifies under the master key of the certificate's own
 *   version (old history stays verifiable after rotation while the client keeps the old master keys).
 * - **Current version only for liveness.** The current version is the highest the client holds or has
 *   seen. Only a certificate at that version can make a key live, so a thief with a pre-rotation master key
 *   cannot certify a fresh key into live trust. Older certificates carry pinned history only.
 * - **Any valid record revokes its target.** A record whose signature verifies under a key certified at the
 *   current version, live, pinned or pending, makes its target non-live for good (TrustState.revoked),
 *   whatever the server claims. Records by old-version-only keys are ignored: such a key can never be live.
 * - **Pins come only from live signers, and only ever narrow.** A record sets pins only if its signer is live
 *   (a server claim at the current version) and not itself revoked. Several such records: the narrowest pins.
 *   The result is always narrowed with the pins this client has seen (TrustState.pins), so neither a withheld
 *   record nor a wider record served later can widen or drop a pin. A revoked key with no pins, now or ever,
 *   is pending (untrusted; `includePending` returns it for the revocation flow).
 * - **The current version** is the highest of: the versions the client has seen, the account version the
 *   server declares, and the master keys held. When it is above every held master key, nothing is live and
 *   `keyRotated` is true: tell the user "the account key was rotated: unlock with your passphrase to fetch
 *   the new master key".
 *
 * **The caller MUST persist the returned `state`** in the same local transaction as the pull cursor, and pass
 * it back next time. Nothing in core does this yet (the `cleo cloud` commands will); without it the monotonic
 * guarantees above do not hold.
 * - A live key: certified at the current version, called live by the server, never revoked.
 */
export function certifiedSigners(
  masterKeys: MasterKeys,
  userId: string,
  trust: DeviceTrust,
  state: TrustState,
  /**
   * The account's key version as the server declares it (`keyVersion` of GET /v1/account/keys), or null
   * when the account has no keys yet. Used for this call only, never persisted. It may raise the current
   * version by at most MAX_ROTATION_STEP above the highest held or proven version: a rotation bumps the
   * version by one. A higher value is a server error (`serverError`), not a rotation.
   */
  accountKeyVersion: number | null,
  opts: { includePending?: boolean } = {},
): TrustEvaluation {
  const held = Math.max(0, ...masterKeys.keys());
  const proven = Math.max(state.keyVersion, held);
  const implausible = accountKeyVersion !== null && accountKeyVersion > proven + MAX_ROTATION_STEP;
  const current = Math.max(proven, implausible ? 0 : (accountKeyVersion ?? 0));
  const certified = new Map<
    string,
    { deviceId: string; publicKey: Buffer; live: boolean; atCurrent: boolean }
  >();
  for (const c of trust.certificates) {
    const mk = masterKeys.get(c.keyVersion);
    if (!mk) continue;
    const keys = {
      deviceId: c.deviceId,
      encryptionPublicKey: Buffer.from(c.encryptionPublicKey, 'base64'),
      signingPublicKey: Buffer.from(c.signingPublicKey, 'base64'),
    };
    if (
      !verifyDeviceCertificate(mk, userId, keys, c.keyVersion, Buffer.from(c.certificate, 'base64'))
    )
      continue;
    const id = `${c.deviceId}/${hex(keys.signingPublicKey)}`;
    const prev = certified.get(id);
    const atCurrent = c.keyVersion === current;
    certified.set(id, {
      deviceId: c.deviceId,
      publicKey: keys.signingPublicKey,
      // An implausible declaration fails closed: nothing is live in this call (nothing is persisted either).
      live: (prev?.live ?? false) || (c.live && atCurrent && !implausible),
      atCurrent: (prev?.atCurrent ?? false) || atCurrent,
    });
  }
  // Every record whose signature verifies under a key of its signer that is certified at the current
  // version, whatever that key's status (live, pinned or pending). An old-version-only key can never be
  // live, and its records touch nothing: a thief with a pre-rotation master key cannot revoke live devices.
  const valid: { signerId: string; revokedId: string; pins: RevocationPins }[] = [];
  for (const r of trust.revocations) {
    const revokedKey = Buffer.from(r.signingPublicKey, 'base64');
    const revokedId = `${r.deviceId}/${hex(revokedKey)}`;
    if (!certified.has(revokedId)) continue;
    const msg = revocationMessage(userId, r.deviceId, revokedKey, r.pins, r.signerDeviceId);
    const signature = Buffer.from(r.signature, 'base64');
    for (const [signerId, k] of certified) {
      if (
        k.deviceId === r.signerDeviceId &&
        k.atCurrent &&
        verifyEd25519(k.publicKey, msg, signature)
      ) {
        valid.push({ signerId, revokedId, pins: r.pins });
        break;
      }
    }
  }
  const revoked = new Set([
    ...state.revoked,
    ...Object.keys(state.pins),
    ...valid.map((x) => x.revokedId),
  ]);
  const pins = new Map<string, RevocationPins>();
  for (const x of valid) {
    const signer = certified.get(x.signerId);
    if (!signer?.live || revoked.has(x.signerId)) continue;
    const prev = pins.get(x.revokedId);
    pins.set(x.revokedId, prev ? narrowerPins(prev, x.pins) : x.pins);
  }
  // Pins only ever narrow: a record served now, even a genuine one by another live signer, can never
  // widen a pin this client has seen, and a withheld record leaves the seen pin in force.
  for (const [id, p] of Object.entries(state.pins)) {
    const now = pins.get(id);
    pins.set(id, now ? narrowerPins(now, p) : p);
  }
  const signers = new Map<string, SignerKey[]>();
  for (const [id, k] of certified) {
    const pin = pins.get(id);
    const key: SignerKey | null = pin
      ? { publicKey: k.publicKey, pin }
      : k.live && !revoked.has(id)
        ? { publicKey: k.publicKey, pin: null }
        : opts.includePending
          ? { publicKey: k.publicKey, pin: null, pending: true }
          : null;
    if (!key) continue;
    signers.set(k.deviceId, [...(signers.get(k.deviceId) ?? []), key]);
  }
  const next: TrustState = {
    keyVersion: proven,
    pins: Object.fromEntries([...pins].sort(([a], [b]) => (a < b ? -1 : 1))),
    revoked: [...revoked].sort(),
  };
  // The account moved to a key version this client has no master key for: nothing is live until it
  // unlocks with the passphrase (or the recovery key) and fetches the new master key.
  return {
    signers,
    state: next,
    keyRotated: current > held,
    ...(implausible ? { serverError: 'implausible-key-version' as const } : {}),
  };
}

const revocationMessage = (
  userId: string,
  deviceId: string,
  revokedKey: Uint8Array,
  pins: RevocationPins,
  signerDeviceId: string,
) =>
  deviceRevocationMessage({
    userId,
    revokedDeviceId: deviceId,
    revokedSigningPublicKeyHex: hex(revokedKey),
    pinsHash: sha256Hex(utf8(revocationPinsCanonical(pins))),
    signerDeviceId,
  });

/**
 * Revoke one signing key of a device and pin its history (the POST /v1/devices/:id/revocations body).
 * The signer must hold a certified key: after losing every other device, the device that just unlocked
 * with the passphrase certifies itself (a self-grant) and signs this. Compute `pins` from segments and
 * checkpoints this client has itself verified (revocationPins), never from numbers the server supplies.
 */
export function createDeviceRevocation(args: {
  userId: string;
  revoked: { deviceId: string; signingPublicKey: Uint8Array };
  pins: RevocationPins;
  signer: { deviceId: string; signing: KeyPair };
}): CreateDeviceRevocationRequest {
  const { userId, revoked, pins, signer } = args;
  const msg = revocationMessage(
    userId,
    revoked.deviceId,
    revoked.signingPublicKey,
    pins,
    signer.deviceId,
  );
  return {
    signingPublicKey: Buffer.from(revoked.signingPublicKey).toString('base64'),
    pins,
    signerDeviceId: signer.deviceId,
    signature: signEd25519(signer.signing, msg).toString('base64'),
  };
}

const grantMessage = (
  userId: string,
  recipient: DevicePublicKeys,
  keyVersion: number,
  sealed: Uint8Array,
  certificate: Uint8Array,
  signerDeviceId: string,
) =>
  deviceGrantMessage({
    userId,
    recipientDeviceId: recipient.deviceId,
    recipientEncryptionPublicKeyHex: hex(recipient.encryptionPublicKey),
    recipientSigningPublicKeyHex: hex(recipient.signingPublicKey),
    keyVersion,
    sealedMasterKeyHash: sha256Hex(sealed),
    certificateHex: hex(certificate),
    signerDeviceId,
  });

/**
 * Grant the master key to a device: seal it to the recipient's X25519 key, certify the recipient under
 * the master key, and sign the whole grant with the signer's Ed25519 key. The signer must hold the
 * master key legitimately: a device that unlocked by passphrase or recovery key grants to itself, and a
 * trusted device grants to another (key rotation). The result is the PUT /v1/devices/:id/key body.
 */
export function createDeviceGrant(args: {
  masterKey: Buffer;
  userId: string;
  keyVersion: number;
  recipient: DevicePublicKeys;
  signer: { deviceId: string; signing: KeyPair };
}): PutDeviceWrappedKeyRequest {
  const { masterKey, userId, keyVersion, recipient, signer } = args;
  const sealed = sealTo(
    recipient.encryptionPublicKey,
    masterKey,
    deviceContext(userId, recipient.deviceId, keyVersion),
  );
  const certificate = deviceCertificate(masterKey, userId, recipient, keyVersion);
  const signature = signEd25519(
    signer.signing,
    grantMessage(userId, recipient, keyVersion, sealed, certificate, signer.deviceId),
  );
  return {
    sealedMasterKey: sealed.toString('base64'),
    keyVersion,
    certificate: certificate.toString('base64'),
    signerDeviceId: signer.deviceId,
    grantSignature: signature.toString('base64'),
  };
}

/**
 * Open a master key grant made to this device, after checking it came from a trusted signer. The checks,
 * in order: the signer is in `trustedSigners` (the device's own signing key for a self-grant, or devices
 * certified under a master key this device already holds); the signature verifies over a message rebuilt
 * from this device's OWN keys, so a grant made for other keys fails; the sealed box opens; and the key
 * inside certifies this device, so the key and the signer's intent agree. The server's verifier is not
 * consulted: it is server-supplied and proves nothing.
 */
export function openDeviceGrant(args: {
  userId: string;
  device: { deviceId: string; encryption: KeyPair; signingPublicKey: Uint8Array };
  grant: PutDeviceWrappedKeyRequest;
  trustedSigners: TrustedSigners;
}): Buffer {
  const { userId, device, grant, trustedSigners } = args;
  // Only a live key vouches for a new grant: a revoked device's pin covers its history, not new keys.
  const candidates = liveKeys(trustedSigners, grant.signerDeviceId);
  if (candidates.length === 0)
    throw new KeyTrustError(`key grant is signed by untrusted device ${grant.signerDeviceId}`);
  const me: DevicePublicKeys = {
    deviceId: device.deviceId,
    encryptionPublicKey: device.encryption.publicKey,
    signingPublicKey: device.signingPublicKey,
  };
  const sealed = Buffer.from(grant.sealedMasterKey, 'base64');
  const certificate = Buffer.from(grant.certificate, 'base64');
  const msg = grantMessage(userId, me, grant.keyVersion, sealed, certificate, grant.signerDeviceId);
  const grantSignature = Buffer.from(grant.grantSignature, 'base64');
  if (!candidates.some((k) => verifyEd25519(k.publicKey, msg, grantSignature))) {
    throw new KeyTrustError('key grant signature does not verify');
  }
  const mk = openSealed(
    device.encryption,
    sealed,
    deviceContext(userId, device.deviceId, grant.keyVersion),
  );
  if (!verifyDeviceCertificate(mk, userId, me, grant.keyVersion, certificate)) {
    throw new KeyTrustError('granted master key does not certify this device');
  }
  return mk;
}

export const newProjectKey = randomKey;

export function wrapProjectKey(
  mk: Buffer,
  pdk: Buffer,
  projectId: string,
  keyVersion: number,
): string {
  return seal(mk, pdk, 'pdk-wrap', pdkContext(projectId, keyVersion)).toString('base64');
}

/**
 * Whether a base64 key wrap may be sent: it has content beyond `=` padding
 * and decodes to at least one byte. Cleo Nexus refuses an empty or
 * padding-only `wrappedProjectKey` with 400 (cleo-nexus #35), so the client
 * checks before every send (T13101).
 *
 * @param wrapped - The base64 wrap.
 */
export function isSendableWrap(wrapped: string): boolean {
  return wrapped.replace(/=+$/, '') !== '' && Buffer.from(wrapped, 'base64').length > 0;
}

export function unwrapProjectKey(
  mk: Buffer,
  wrapped: string,
  projectId: string,
  keyVersion: number,
): Buffer {
  return open(mk, Buffer.from(wrapped, 'base64'), 'pdk-wrap', pdkContext(projectId, keyVersion));
}

/** Key for the personal home stream. It is derived, so it never needs storing or sharing. */
export const homeStreamKey = (mk: Buffer) => deriveKey(mk, 'home-stream');
