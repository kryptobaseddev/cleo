/**
 * Unit tests for backup-crypto.ts (T345).
 *
 * Covers: round-trip correctness, magic/version header, ciphertext
 * non-determinism (random salt + nonce), error paths (wrong passphrase,
 * truncated payload, bit-flip tamper, magic mismatch, too-short), and
 * isEncryptedBundle detection.
 *
 * @task T345
 * @epic T311
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptBundle, encryptBundle, isEncryptedBundle } from '../backup-crypto.js';

describe('backup-crypto', () => {
  const plaintext = Buffer.from('Hello, CLEO backup world! 🌍 Non-ASCII: ñoño café');
  const passphrase = 'correct horse battery staple';

  it('round-trip: decrypt(encrypt(x)) == x', () => {
    const encrypted = encryptBundle(plaintext, passphrase);
    const decrypted = decryptBundle(encrypted, passphrase);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('encryptBundle output starts with CLEOENC1 magic', () => {
    const enc = encryptBundle(plaintext, passphrase);
    expect(enc.subarray(0, 8).toString('utf8')).toBe('CLEOENC1');
  });

  it('encryptBundle output has version byte 0x01 at offset 8', () => {
    const enc = encryptBundle(plaintext, passphrase);
    expect(enc[8]).toBe(0x01);
  });

  it('two encryptions of same input differ (random salt + nonce)', () => {
    const e1 = encryptBundle(plaintext, passphrase);
    const e2 = encryptBundle(plaintext, passphrase);
    expect(e1.equals(e2)).toBe(false);
  });

  it('decryptBundle throws on wrong passphrase', () => {
    const enc = encryptBundle(plaintext, passphrase);
    expect(() => decryptBundle(enc, 'wrong passphrase')).toThrow(/authentication failed/);
  });

  it('decryptBundle throws on truncated ciphertext (auth tag missing)', () => {
    const enc = encryptBundle(plaintext, passphrase);
    const truncated = enc.subarray(0, enc.length - 1);
    expect(() => decryptBundle(truncated, passphrase)).toThrow();
  });

  it('decryptBundle throws on flipped bit (auth tag fails)', () => {
    const enc = encryptBundle(plaintext, passphrase);
    // Flip a byte in the middle of the ciphertext region
    const tampered = Buffer.from(enc);
    const idx = 16 + 32 + 12 + 5; // well inside ciphertext region
    tampered[idx] ^= 0x01;
    expect(() => decryptBundle(tampered, passphrase)).toThrow(/authentication failed/);
  });

  it('decryptBundle throws on magic mismatch', () => {
    const bogus = Buffer.alloc(128);
    expect(() => decryptBundle(bogus, passphrase)).toThrow(/magic mismatch/);
  });

  it('decryptBundle throws on payload too short', () => {
    const tiny = Buffer.alloc(32);
    expect(() => decryptBundle(tiny, passphrase)).toThrow(/too short/);
  });

  it('encryptBundle throws on empty passphrase', () => {
    expect(() => encryptBundle(plaintext, '')).toThrow(/passphrase/);
  });

  it('isEncryptedBundle returns true for magic header', () => {
    const enc = encryptBundle(plaintext, passphrase);
    expect(isEncryptedBundle(enc.subarray(0, 8))).toBe(true);
  });

  it('isEncryptedBundle returns false for random data', () => {
    const random = crypto.randomBytes(32);
    expect(isEncryptedBundle(random)).toBe(false);
  });

  it('handles large payloads (1 MB)', () => {
    const large = crypto.randomBytes(1024 * 1024);
    const enc = encryptBundle(large, passphrase);
    const dec = decryptBundle(enc, passphrase);
    expect(dec.equals(large)).toBe(true);
  });

  it('scrypt derivation is deterministic for same passphrase + salt', () => {
    // Indirectly verified: two independent round-trips both recover the plaintext.
    const e1 = encryptBundle(plaintext, passphrase);
    const e2 = encryptBundle(plaintext, passphrase);
    expect(decryptBundle(e1, passphrase).equals(plaintext)).toBe(true);
    expect(decryptBundle(e2, passphrase).equals(plaintext)).toBe(true);
  });
});
