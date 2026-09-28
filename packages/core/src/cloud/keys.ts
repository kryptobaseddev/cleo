import type { Device, PutDeviceWrappedKeyRequest } from '@cleocode/contracts/cloud';
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
import { deviceCertificateMessage, deviceGrantMessage } from './signing.js';

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
 * The signing keys of the user's devices that the master key certifies, by device id. Build the trusted
 * signer set for pulls and grants from this, never from the server's device list alone. Revoked devices
 * are left out; a hidden revocation is covered by rotation (a new key version certifies only live devices).
 */
export function certifiedSigners(
  mk: Uint8Array,
  userId: string,
  keyVersion: number,
  devices: readonly Device[],
): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const d of devices) {
    if (d.revokedAt || !d.certificate || d.certificateKeyVersion !== keyVersion) continue;
    const keys = {
      deviceId: d.deviceId,
      encryptionPublicKey: Buffer.from(d.encryptionPublicKey, 'base64'),
      signingPublicKey: Buffer.from(d.signingPublicKey, 'base64'),
    };
    if (
      verifyDeviceCertificate(mk, userId, keys, keyVersion, Buffer.from(d.certificate, 'base64'))
    ) {
      out.set(d.deviceId, keys.signingPublicKey);
    }
  }
  return out;
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
  trustedSigners: ReadonlyMap<string, Uint8Array>;
}): Buffer {
  const { userId, device, grant, trustedSigners } = args;
  const signerKey = trustedSigners.get(grant.signerDeviceId);
  if (!signerKey)
    throw new KeyTrustError(`key grant is signed by untrusted device ${grant.signerDeviceId}`);
  const me: DevicePublicKeys = {
    deviceId: device.deviceId,
    encryptionPublicKey: device.encryption.publicKey,
    signingPublicKey: device.signingPublicKey,
  };
  const sealed = Buffer.from(grant.sealedMasterKey, 'base64');
  const certificate = Buffer.from(grant.certificate, 'base64');
  const msg = grantMessage(userId, me, grant.keyVersion, sealed, certificate, grant.signerDeviceId);
  if (!verifyEd25519(signerKey, msg, Buffer.from(grant.grantSignature, 'base64'))) {
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
