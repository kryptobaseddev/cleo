/**
 * Credentials (AES-256-GCM) test suite.
 *
 * Tests the encrypt/decrypt roundtrip, version-byte validation,
 * truncated-ciphertext rejection, and wrong-project-key failure.
 * Each test is fully isolated — no shared state, no file system
 * dependencies beyond the auto-generated machine key.
 *
 * @see packages/core/src/crypto/credentials.ts
 * @task T180
 */

import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../credentials.js';

// ============================================================================
// Helpers
// ============================================================================

/** A stable project path used as the encryption context. */
const PROJECT_A = '/tmp/test-project-a';
const PROJECT_B = '/tmp/test-project-b';

// ============================================================================
// Roundtrip
// ============================================================================

describe('credentials', () => {
  describe('encrypt / decrypt roundtrip', () => {
    it('round-trips a short plaintext', async () => {
      const plaintext = 'hello';
      const ciphertext = await encrypt(plaintext, PROJECT_A);
      const result = await decrypt(ciphertext, PROJECT_A);
      expect(result).toBe(plaintext);
    });

    it('round-trips a realistic API key', async () => {
      const apiKey = 'sk_live_abc123XYZ_0987654321_real_key';
      const ciphertext = await encrypt(apiKey, PROJECT_A);
      const result = await decrypt(ciphertext, PROJECT_A);
      expect(result).toBe(apiKey);
    });

    it('round-trips an empty string', async () => {
      const ciphertext = await encrypt('', PROJECT_A);
      const result = await decrypt(ciphertext, PROJECT_A);
      expect(result).toBe('');
    });

    it('round-trips a unicode string', async () => {
      const plaintext = '日本語テスト — émojis 🔑 are fine too';
      const ciphertext = await encrypt(plaintext, PROJECT_A);
      const result = await decrypt(ciphertext, PROJECT_A);
      expect(result).toBe(plaintext);
    });

    it('round-trips a long payload (4096 bytes)', async () => {
      const plaintext = 'x'.repeat(4096);
      const ciphertext = await encrypt(plaintext, PROJECT_A);
      const result = await decrypt(ciphertext, PROJECT_A);
      expect(result).toBe(plaintext);
    });

    it('produces valid base64 output', async () => {
      const ciphertext = await encrypt('test', PROJECT_A);
      expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
      // Base64 string must be non-empty and use only base64 characters
      expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('produces different ciphertexts on successive encryptions (random IV)', async () => {
      const plaintext = 'same-plaintext';
      const ct1 = await encrypt(plaintext, PROJECT_A);
      const ct2 = await encrypt(plaintext, PROJECT_A);
      // Same plaintext, same key — ciphertexts MUST differ due to random IV
      expect(ct1).not.toBe(ct2);
      // Both must still decrypt correctly
      expect(await decrypt(ct1, PROJECT_A)).toBe(plaintext);
      expect(await decrypt(ct2, PROJECT_A)).toBe(plaintext);
    });
  });

  // --------------------------------------------------------------------------
  // Cross-project key isolation
  // --------------------------------------------------------------------------

  describe('cross-project key isolation', () => {
    it('rejects ciphertext encrypted for a different project path', async () => {
      const plaintext = 'secret-for-project-a';
      const ciphertext = await encrypt(plaintext, PROJECT_A);
      // PROJECT_B produces a different derived key — decryption MUST fail
      await expect(decrypt(ciphertext, PROJECT_B)).rejects.toThrow();
    });

    it('accepts ciphertext when project path matches exactly', async () => {
      const plaintext = 'cross-check';
      const ciphertext = await encrypt(plaintext, PROJECT_B);
      await expect(decrypt(ciphertext, PROJECT_B)).resolves.toBe(plaintext);
    });
  });

  // --------------------------------------------------------------------------
  // Malformed / corrupted input
  // --------------------------------------------------------------------------

  describe('malformed ciphertext rejection', () => {
    it('throws on ciphertext that is too short', async () => {
      // A valid packed buffer has at minimum 1 (version) + 12 (IV) + 16 (authTag) = 29 bytes.
      // Encode a 10-byte blob — far below the minimum.
      const tooShort = Buffer.from('tooshort!!').toString('base64');
      await expect(decrypt(tooShort, PROJECT_A)).rejects.toThrow('ciphertext too short');
    });

    it('throws on ciphertext with unknown version byte', async () => {
      // Build a buffer that satisfies the minimum length but has version byte 0x02.
      const fakeVersion = Buffer.alloc(1 + 12 + 0 + 16); // version + iv + 0 ciphertext + authTag
      fakeVersion[0] = 0x02; // unsupported version
      const encoded = fakeVersion.toString('base64');
      await expect(decrypt(encoded, PROJECT_A)).rejects.toThrow(/[Uu]nknown ciphertext version/);
    });

    it('throws on bit-flipped (corrupted) ciphertext — auth tag mismatch', async () => {
      const ciphertext = await encrypt('important data', PROJECT_A);
      // Flip a byte in the middle of the base64-decoded buffer
      const buf = Buffer.from(ciphertext, 'base64');
      buf[buf.length >> 1] ^= 0xff; // flip a byte in the ciphertext body
      const corrupted = buf.toString('base64');
      await expect(decrypt(corrupted, PROJECT_A)).rejects.toThrow();
    });

    it('throws on empty string input', async () => {
      await expect(decrypt('', PROJECT_A)).rejects.toThrow();
    });

    it('throws on non-base64 garbage string', async () => {
      // Buffer.from with invalid base64 produces an empty or zero buffer — will fail length check
      await expect(decrypt('!!! not base64 !!!', PROJECT_A)).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // GCM authentication tag enforcement
  // --------------------------------------------------------------------------

  describe('GCM auth tag enforcement', () => {
    it('rejects ciphertext with a zeroed auth tag', async () => {
      const ct = await encrypt('gcm-test', PROJECT_A);
      const buf = Buffer.from(ct, 'base64');
      // Zero the last 16 bytes (auth tag position)
      buf.fill(0, buf.length - 16);
      const tampered = buf.toString('base64');
      await expect(decrypt(tampered, PROJECT_A)).rejects.toThrow();
    });

    it('rejects ciphertext with a zeroed IV', async () => {
      const ct = await encrypt('gcm-test', PROJECT_A);
      const buf = Buffer.from(ct, 'base64');
      // Zero bytes [1..12] — the IV region (byte 0 is version)
      buf.fill(0, 1, 13);
      const tampered = buf.toString('base64');
      await expect(decrypt(tampered, PROJECT_A)).rejects.toThrow();
    });
  });
});
