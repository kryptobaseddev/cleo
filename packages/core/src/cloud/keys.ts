import {
  constantTimeEqual,
  DecryptError,
  decodeRecoveryKey,
  deriveKey,
  encodeRecoveryKey,
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
} from './crypto.js';

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

/** Seal the master key to a device, so that device unlocks without the passphrase. */
export function sealMasterKeyForDevice(
  mk: Buffer,
  userId: string,
  deviceId: string,
  devicePublicKey: Uint8Array,
  keyVersion: number,
): string {
  return sealTo(devicePublicKey, mk, deviceContext(userId, deviceId, keyVersion)).toString(
    'base64',
  );
}

export function openDeviceSealedMasterKey(
  device: KeyPair,
  userId: string,
  deviceId: string,
  sealed: string,
  keyVersion: number,
  stored?: StoredUserKeys,
): Buffer {
  const mk = openSealed(
    device,
    Buffer.from(sealed, 'base64'),
    deviceContext(userId, deviceId, keyVersion),
  );
  return stored ? checkVerifier(mk, stored) : mk;
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
