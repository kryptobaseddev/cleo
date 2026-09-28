import { describe, expect, it } from 'vitest';
import {
  checkKdfParams,
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
  certifiedSigners,
  createDeviceGrant,
  createDeviceRevocation,
  createUserKeys,
  deviceCertificate,
  homeStreamKey,
  KeyTrustError,
  newProjectKey,
  openDeviceGrant,
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
    ['wrong key', (_k: Buffer, e: Buffer) => open(randomKey(), e, 'segment', 'ctx')],
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

describe('KDF parameter bounds (the server supplies them)', () => {
  const ok = {
    algorithm: 'argon2id' as const,
    memoryKiB: 65_536,
    iterations: 3,
    parallelism: 1,
    salt: randomKey().subarray(0, 16).toString('base64'),
  };
  it('accepts the defaults and refuses weak or abusive parameters before running Argon2id', async () => {
    expect(() => checkKdfParams(ok)).not.toThrow();
    for (const bad of [
      { ...ok, memoryKiB: 1024 },
      { ...ok, memoryKiB: 64 * 1024 * 1024 },
      { ...ok, iterations: 1 },
      { ...ok, iterations: 1000 },
      { ...ok, parallelism: 0 },
      { ...ok, parallelism: 255 },
      { ...ok, salt: '' },
    ]) {
      expect(() => checkKdfParams(bad)).toThrow(RangeError);
      await expect(
        unlockWithPassphrase(
          'u',
          {
            passphraseWrappedMasterKey: '',
            kdf: bad,
            recoveryWrappedMasterKey: '',
            masterKeyVerifier: '',
            keyVersion: 1,
          },
          'x'.repeat(12),
        ),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe('device trust: signed, certified master key grants', () => {
  const userId = '0192f1c2-7d3e-4abc-8def-000000000001';
  const dev = (deviceId: string) => {
    const encryption = generateX25519();
    const signing = generateEd25519();
    return {
      deviceId,
      encryption,
      signing,
      pub: {
        deviceId,
        encryptionPublicKey: encryption.publicKey,
        signingPublicKey: signing.publicKey,
      },
      open: { deviceId, encryption, signingPublicKey: signing.publicKey },
    };
  };
  const mk = randomKey();
  const a = dev('0192f1c2-7d3e-4abc-8def-00000000000a');
  const b = dev('0192f1c2-7d3e-4abc-8def-00000000000b');
  const evil = dev('0192f1c2-7d3e-4abc-8def-00000000000e');
  const grant = (masterKey: Buffer, signer: ReturnType<typeof dev>, to: ReturnType<typeof dev>) =>
    createDeviceGrant({
      masterKey,
      userId,
      keyVersion: 1,
      recipient: to.pub,
      signer: { deviceId: signer.deviceId, signing: signer.signing },
    });
  const trustSelf = (d: ReturnType<typeof dev>) => new Map([[d.deviceId, d.signing.publicKey]]);

  it('opens a self-grant and a grant from a trusted signer', () => {
    expect(
      openDeviceGrant({
        userId,
        device: b.open,
        grant: grant(mk, b, b),
        trustedSigners: trustSelf(b),
      }).equals(mk),
    ).toBe(true);
    expect(
      openDeviceGrant({
        userId,
        device: b.open,
        grant: grant(mk, a, b),
        trustedSigners: trustSelf(a),
      }).equals(mk),
    ).toBe(true);
  });

  it('refuses an attacker-chosen key: anonymous sealing is not enough (HIGH 1)', () => {
    const attackerMk = randomKey();
    // Signed by a device the recipient does not trust.
    expect(() =>
      openDeviceGrant({
        userId,
        device: b.open,
        grant: grant(attackerMk, evil, b),
        trustedSigners: trustSelf(b),
      }),
    ).toThrow(/untrusted device/);
    // The attacker's key sealed into a grant that was signed over the real sealed box.
    const real = grant(mk, b, b);
    const swapped = { ...real, sealedMasterKey: grant(attackerMk, b, b).sealedMasterKey };
    expect(() =>
      openDeviceGrant({ userId, device: b.open, grant: swapped, trustedSigners: trustSelf(b) }),
    ).toThrow(/signature/);
    // A trusted signer's grant made for other keys (redirected).
    expect(() =>
      openDeviceGrant({
        userId,
        device: b.open,
        grant: grant(mk, a, a),
        trustedSigners: trustSelf(a),
      }),
    ).toThrow(/signature/);
    // A trusted signer whose sealed key does not certify the recipient (the signer's intent and the key disagree).
    const mismatch = createDeviceGrant({
      masterKey: attackerMk,
      userId,
      keyVersion: 1,
      recipient: b.pub,
      signer: { deviceId: a.deviceId, signing: a.signing },
    });
    const withRealCert = {
      ...mismatch,
      certificate: deviceCertificate(mk, userId, b.pub, 1).toString('base64'),
    };
    expect(() =>
      openDeviceGrant({
        userId,
        device: b.open,
        grant: withRealCert,
        trustedSigners: trustSelf(a),
      }),
    ).toThrow(KeyTrustError);
  });

  const certRow = (d: ReturnType<typeof dev>, key: Buffer, live = true) => ({
    deviceId: d.deviceId,
    encryptionPublicKey: d.encryption.publicKey.toString('base64'),
    signingPublicKey: d.signing.publicKey.toString('base64'),
    keyVersion: 1,
    certificate: deviceCertificate(key, userId, d.pub, 1).toString('base64'),
    live,
  });
  const pins = { replicas: { '0192f1c2-7d3e-7abc-8def-0000000000a1': 4 }, checkpoints: {} };
  const revoke = (signer: ReturnType<typeof dev>, revoked: ReturnType<typeof dev>, p = pins) => ({
    deviceId: revoked.deviceId,
    ...createDeviceRevocation({
      userId,
      revoked: { deviceId: revoked.deviceId, signingPublicKey: revoked.signing.publicKey },
      pins: p,
      signer: { deviceId: signer.deviceId, signing: signer.signing },
    }),
  });

  it('certifies only devices the master key vouches for', () => {
    const trust = { certificates: [certRow(a, mk), certRow(evil, randomKey())], revocations: [] };
    expect([...certifiedSigners(new Map([[1, mk]]), userId, trust).keys()]).toEqual([a.deviceId]);
    expect(certifiedSigners(new Map([[2, mk]]), userId, trust).size).toBe(0);
  });

  it('keeps a revoked key trusted up to its pins, and never trusts one with no record (round 3)', () => {
    // b is revoked (not live). With no record it is pending: left out, unless the revocation flow asks.
    const noRecord = { certificates: [certRow(a, mk), certRow(b, mk, false)], revocations: [] };
    expect(certifiedSigners(new Map([[1, mk]]), userId, noRecord).has(b.deviceId)).toBe(false);
    expect(
      certifiedSigners(new Map([[1, mk]]), userId, noRecord, { includePending: true }).get(
        b.deviceId,
      ),
    ).toEqual([{ publicKey: b.signing.publicKey, pin: null, pending: true }]);
    // a signs a revocation record for b: b is trusted with the pin, whatever the server says about live.
    for (const live of [false, true]) {
      const t = {
        certificates: [certRow(a, mk), certRow(b, mk, live)],
        revocations: [revoke(a, b)],
      };
      expect(certifiedSigners(new Map([[1, mk]]), userId, t).get(b.deviceId)).toEqual([
        { publicKey: b.signing.publicKey, pin: pins },
      ]);
    }
    // A record signed by an uncertified key, or with edited pins, is ignored.
    const byEvil = {
      certificates: [certRow(a, mk), certRow(b, mk, false), certRow(evil, randomKey())],
      revocations: [revoke(evil, b)],
    };
    expect(certifiedSigners(new Map([[1, mk]]), userId, byEvil).has(b.deviceId)).toBe(false);
    const edited = {
      ...revoke(a, b),
      pins: { replicas: { '0192f1c2-7d3e-7abc-8def-0000000000a1': 99 }, checkpoints: {} },
    };
    expect(
      certifiedSigners(new Map([[1, mk]]), userId, {
        certificates: [certRow(a, mk), certRow(b, mk, false)],
        revocations: [edited],
      }).has(b.deviceId),
    ).toBe(false);
    // The lost-only-device case: b signs the record for a itself, having certified itself after a passphrase unlock.
    const selfRescue = {
      certificates: [certRow(a, mk, false), certRow(b, mk)],
      revocations: [revoke(b, a)],
    };
    expect(certifiedSigners(new Map([[1, mk]]), userId, selfRescue).get(a.deviceId)).toEqual([
      { publicKey: a.signing.publicKey, pin: pins },
    ]);
  });

  const c = dev('0192f1c2-7d3e-4abc-8def-00000000000c');
  const R = '0192f1c2-7d3e-7abc-8def-0000000000a1';
  const v1 = (t: Parameters<typeof certifiedSigners>[2]) =>
    certifiedSigners(new Map([[1, mk]]), userId, t);

  it('ignores records by a revoked signer: a thief cannot pre-empt the owner (round 4)', () => {
    const empty = { replicas: {}, checkpoints: {} };
    // The thief holds a (still live) and signs {} for its own key and for the owner's other device b.
    const thiefSelf = revoke(a, a, empty);
    const thiefOnB = revoke(a, b, empty);
    // While a is live its records count: b is pinned to nothing (denial of service, not trust).
    const before = v1({
      certificates: [certRow(a, mk), certRow(b, mk, false)],
      revocations: [thiefOnB],
    });
    expect(before.get(b.deviceId)).toEqual([{ publicKey: b.signing.publicKey, pin: empty }]);
    // The owner revokes a from the web: a is no longer live, so its records stop counting at once, even
    // before any record revokes a. b becomes pending (untrusted), not pinned to nothing.
    const webRevoked = v1({
      certificates: [certRow(a, mk, false), certRow(b, mk, false)],
      revocations: [thiefOnB],
    });
    expect(webRevoked.size).toBe(0);
    // Then c (unlocked by passphrase) signs the owner's records.
    const owner = [revoke(c, a), revoke(c, b)];
    const after = v1({
      certificates: [certRow(a, mk, false), certRow(b, mk, false), certRow(c, mk)],
      revocations: [thiefSelf, thiefOnB, ...owner],
    });
    expect(after.get(a.deviceId)).toEqual([{ publicKey: a.signing.publicKey, pin: pins }]);
    expect(after.get(b.deviceId)).toEqual([{ publicKey: b.signing.publicKey, pin: pins }]);
    // Even if a server still called a live, a's records stop counting once a live record revokes a.
    const lying = v1({
      certificates: [certRow(a, mk), certRow(b, mk, false), certRow(c, mk)],
      revocations: [thiefOnB, ...owner],
    });
    expect(lying.get(b.deviceId)).toEqual([{ publicKey: b.signing.publicKey, pin: pins }]);
    // Mutual revocation between two live keys cancels both: neither is trusted (pending).
    const mutual = v1({
      certificates: [certRow(a, mk), certRow(c, mk)],
      revocations: [revoke(a, c, pins), revoke(c, a, pins)],
    });
    expect(mutual.size).toBe(0);
  });

  it('applies the narrowest pins when several live devices revoke one key', () => {
    const wide = { replicas: { [R]: 9 }, checkpoints: {} };
    const narrow = { replicas: { [R]: 2 }, checkpoints: {} };
    const t = v1({
      certificates: [certRow(a, mk, false), certRow(b, mk), certRow(c, mk)],
      revocations: [revoke(b, a, wide), revoke(c, a, narrow)],
    });
    expect(t.get(a.deviceId)).toEqual([{ publicKey: a.signing.publicKey, pin: narrow }]);
  });

  it('verifies each certificate under the master key of its own version (rotation keeps history)', () => {
    const mk2 = randomKey();
    const atV2 = (d: ReturnType<typeof dev>) => ({
      ...certRow(d, mk),
      keyVersion: 2,
      certificate: deviceCertificate(mk2, userId, d.pub, 2).toString('base64'),
    });
    // a was certified at v1 and revoked; b is live at v2 and signs a's record.
    const trust = { certificates: [certRow(a, mk, false), atV2(b)], revocations: [revoke(b, a)] };
    const both = certifiedSigners(
      new Map([
        [1, mk],
        [2, mk2],
      ]),
      userId,
      trust,
    );
    expect(both.get(a.deviceId)).toEqual([{ publicKey: a.signing.publicKey, pin: pins }]);
    expect(both.has(b.deviceId)).toBe(true);
    // Without the v1 key, a's history is not verifiable (the documented requirement: keep old master keys).
    expect(certifiedSigners(new Map([[2, mk2]]), userId, trust).has(a.deviceId)).toBe(false);
  });

  it('refuses a grant from a revoked (pinned) signer', () => {
    const t = certifiedSigners(new Map([[1, mk]]), userId, {
      certificates: [certRow(a, mk, false), certRow(b, mk)],
      revocations: [revoke(b, a)],
    });
    expect(() =>
      openDeviceGrant({ userId, device: b.open, grant: grant(mk, a, b), trustedSigners: t }),
    ).toThrow(/untrusted device/);
  });
});
