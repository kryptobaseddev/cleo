import { describe, expect, it } from 'vitest';
import {
  DecryptError,
  decodeRecoveryKey,
  encodeRecoveryKey,
  generateEd25519,
  generateX25519,
  open,
  openSealed,
  randomKey,
  seal,
  sealTo,
  signEd25519,
  verifyEd25519,
} from '../crypto.js';
import {
  createUserKeys,
  homeStreamKey,
  newProjectKey,
  openDeviceSealedMasterKey,
  sealMasterKeyForDevice,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unwrapProjectKey,
  wrapProjectKey,
} from '../keys.js';

const msg = Buffer.from('tasks_tasks T123 status=done');

describe('AEAD seal/open', () => {
  it('round-trips', () => {
    const k = randomKey();
    expect(open(k, seal(k, msg, 'segment', 'ctx'), 'segment', 'ctx').equals(msg)).toBe(true);
  });

  it('produces different ciphertext each time (fresh salt and nonce)', () => {
    const k = randomKey();
    expect(seal(k, msg, 'segment', 'ctx').equals(seal(k, msg, 'segment', 'ctx'))).toBe(false);
  });

  it.each([
    ['wrong key', (k: Buffer, e: Buffer) => open(randomKey(), e, 'segment', 'ctx')],
    [
      'wrong context (moved ciphertext)',
      (k: Buffer, e: Buffer) => open(k, e, 'segment', 'other-ctx'),
    ],
    ['wrong purpose', (k: Buffer, e: Buffer) => open(k, e, 'checkpoint', 'ctx')],
    [
      'flipped bit',
      (k: Buffer, e: Buffer) => {
        const t = Buffer.from(e);
        t[t.length - 20] = (t[t.length - 20] ?? 0) ^ 1;
        return open(k, t, 'segment', 'ctx');
      },
    ],
    ['truncated', (k: Buffer, e: Buffer) => open(k, e.subarray(0, 40), 'segment', 'ctx')],
  ])('refuses %s', (_name, attempt) => {
    const k = randomKey();
    const e = seal(k, msg, 'segment', 'ctx');
    expect(() => attempt(k, e)).toThrow(DecryptError);
  });
});

describe('sealed box to a device key', () => {
  it('opens only with the recipient private key and the same context', () => {
    const dev = generateX25519();
    const other = generateX25519();
    const s = sealTo(dev.publicKey, msg, 'device-mk\nu\nd\n1');
    expect(openSealed(dev, s, 'device-mk\nu\nd\n1').equals(msg)).toBe(true);
    expect(() => openSealed(other, s, 'device-mk\nu\nd\n1')).toThrow(DecryptError);
    expect(() => openSealed(dev, s, 'device-mk\nu\nd\n2')).toThrow(DecryptError);
  });
});

describe('Ed25519', () => {
  it('verifies its own signatures and nothing else', () => {
    const kp = generateEd25519();
    const sig = signEd25519(kp, msg);
    expect(verifyEd25519(kp.publicKey, msg, sig)).toBe(true);
    expect(verifyEd25519(kp.publicKey, Buffer.from('other'), sig)).toBe(false);
    expect(verifyEd25519(generateEd25519().publicKey, msg, sig)).toBe(false);
  });
});

describe('recovery key encoding', () => {
  it('round-trips and tolerates dashes, case and confusable characters', () => {
    const k = randomKey();
    const text = encodeRecoveryKey(k);
    expect(text).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(decodeRecoveryKey(text.toLowerCase().replace(/-/g, ' ')).equals(k)).toBe(true);
    expect(decodeRecoveryKey(text.replace(/0/g, 'O').replace(/1/g, 'I')).equals(k)).toBe(true);
  });

  it('catches a typo with the checksum (most of the time) or the character set', () => {
    const k = randomKey();
    const text = encodeRecoveryKey(k);
    const last = text.at(-1) === 'A' ? 'B' : 'A';
    const typo = `${text.slice(0, -1)}${last}`;
    let caught = 0;
    try {
      const d = decodeRecoveryKey(typo);
      if (!d.equals(k)) caught++;
    } catch {
      caught++;
    }
    expect(caught).toBe(1);
  });
});

describe('key hierarchy', () => {
  it('unlocks by passphrase, by recovery key, and by device seal; project keys wrap under MK', async () => {
    const { masterKey, recoveryKey, stored } = await createUserKeys(
      'user-1',
      'a long enough passphrase',
    );
    expect(
      (await unlockWithPassphrase('user-1', stored, 'a long enough passphrase')).equals(masterKey),
    ).toBe(true);
    await expect(unlockWithPassphrase('user-1', stored, 'wrong passphrase!!')).rejects.toThrow(
      'wrong passphrase',
    );
    expect(unlockWithRecoveryKey('user-1', stored, recoveryKey).equals(masterKey)).toBe(true);
    // A wrap copied to another user id does not open (the AAD binds the user).
    await expect(
      unlockWithPassphrase('user-2', stored, 'a long enough passphrase'),
    ).rejects.toThrow();

    const dev = generateX25519();
    const sealed = sealMasterKeyForDevice(masterKey, 'user-1', 'dev-1', dev.publicKey, 1);
    expect(
      openDeviceSealedMasterKey(dev, 'user-1', 'dev-1', sealed, 1, stored).equals(masterKey),
    ).toBe(true);
    expect(() => openDeviceSealedMasterKey(dev, 'user-1', 'dev-2', sealed, 1)).toThrow(
      DecryptError,
    );

    const pdk = newProjectKey();
    const w = wrapProjectKey(masterKey, pdk, 'proj-1', 1);
    expect(unwrapProjectKey(masterKey, w, 'proj-1', 1).equals(pdk)).toBe(true);
    expect(() => unwrapProjectKey(masterKey, w, 'proj-2', 1)).toThrow(DecryptError);
    expect(homeStreamKey(masterKey).equals(homeStreamKey(masterKey))).toBe(true);
  });

  it('never stores the master key or passphrase in what goes to the server', async () => {
    const { masterKey, stored } = await createUserKeys('u', 'another long passphrase');
    const wire = JSON.stringify(stored);
    expect(wire).not.toContain(masterKey.toString('base64'));
    expect(wire).not.toContain(masterKey.toString('hex'));
    expect(wire).not.toContain('another long passphrase');
  });
});
