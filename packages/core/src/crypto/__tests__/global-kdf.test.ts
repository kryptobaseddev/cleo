/**
 * Global-KDF (ADR-037 §5) test suite for `encryptGlobal` / `decryptGlobal`.
 *
 * The global KDF derives an AES-256 key from
 * `HMAC-SHA256(machine-key || globalSalt, id)` — project-independent, so a
 * single global credential decrypts from any project on the same machine.
 *
 * These tests prove:
 *   1. `encryptGlobal` → `decryptGlobal` round-trips plaintext for a given id.
 *   2. A different id derives a different key and fails the GCM auth tag.
 *   3. The ciphertext keeps the versioned `0x01 + 12B IV + 16B authTag` format.
 *
 * @see packages/core/src/crypto/credentials.ts
 * @see packages/core/src/store/global-salt.ts
 * @task T11710
 */

import { describe, expect, it } from 'vitest';
import { decryptGlobal, encryptGlobal } from '../credentials.js';

// ============================================================================
// Helpers
// ============================================================================

/** Stable identity bindings (agentIds / credential ids). */
const ID_A = 'agent-global-a';
const ID_B = 'agent-global-b';

/** Ciphertext framing constants — mirror credentials.ts. */
const VERSION_BYTE = 0x01;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

describe('global KDF (encryptGlobal / decryptGlobal)', () => {
  // --------------------------------------------------------------------------
  // Round-trip
  // --------------------------------------------------------------------------

  describe('round-trip', () => {
    it('round-trips a realistic LLM API key for a given id', async () => {
      const apiKey = 'sk-ant-oat01-abc123XYZ_realistic_global_llm_key';
      const ciphertext = await encryptGlobal(apiKey, ID_A);
      const result = await decryptGlobal(ciphertext, ID_A);
      expect(result).toBe(apiKey);
    });

    it('round-trips an empty string', async () => {
      const ciphertext = await encryptGlobal('', ID_A);
      const result = await decryptGlobal(ciphertext, ID_A);
      expect(result).toBe('');
    });

    it('round-trips a unicode payload', async () => {
      const plaintext = '日本語テスト — émojis 🔑 are fine too';
      const ciphertext = await encryptGlobal(plaintext, ID_B);
      const result = await decryptGlobal(ciphertext, ID_B);
      expect(result).toBe(plaintext);
    });

    it('produces different ciphertexts on successive encryptions (random IV)', async () => {
      const plaintext = 'same-global-plaintext';
      const ct1 = await encryptGlobal(plaintext, ID_A);
      const ct2 = await encryptGlobal(plaintext, ID_A);
      expect(ct1).not.toBe(ct2);
      expect(await decryptGlobal(ct1, ID_A)).toBe(plaintext);
      expect(await decryptGlobal(ct2, ID_A)).toBe(plaintext);
    });
  });

  // --------------------------------------------------------------------------
  // Identity isolation — a different id must fail the auth tag
  // --------------------------------------------------------------------------

  describe('identity isolation', () => {
    it('rejects ciphertext when decrypted under a different id (auth tag fails)', async () => {
      const plaintext = 'secret-bound-to-id-a';
      const ciphertext = await encryptGlobal(plaintext, ID_A);
      // ID_B derives a different key — GCM auth tag verification MUST fail.
      await expect(decryptGlobal(ciphertext, ID_B)).rejects.toThrow();
    });

    it('accepts ciphertext when the id matches exactly', async () => {
      const plaintext = 'cross-check-global';
      const ciphertext = await encryptGlobal(plaintext, ID_B);
      await expect(decryptGlobal(ciphertext, ID_B)).resolves.toBe(plaintext);
    });
  });

  // --------------------------------------------------------------------------
  // Ciphertext format — versioned 0x01 + 12B IV + 16B authTag
  // --------------------------------------------------------------------------

  describe('ciphertext format', () => {
    it('emits a 0x01 version byte and the expected framing', async () => {
      const plaintext = 'format-check';
      const ciphertext = await encryptGlobal(plaintext, ID_A);
      const packed = Buffer.from(ciphertext, 'base64');

      // version(1) + iv(12) + ciphertext(len) + authTag(16)
      expect(packed[0]).toBe(VERSION_BYTE);
      const expectedLen = 1 + IV_LENGTH + Buffer.byteLength(plaintext, 'utf8') + AUTH_TAG_LENGTH;
      expect(packed.length).toBe(expectedLen);
    });

    it('rejects ciphertext with an unknown version byte', async () => {
      // version(0x02) + iv(12) + 0 ciphertext + authTag(16) satisfies min length.
      const fakeVersion = Buffer.alloc(1 + IV_LENGTH + AUTH_TAG_LENGTH);
      fakeVersion[0] = 0x02;
      const encoded = fakeVersion.toString('base64');
      await expect(decryptGlobal(encoded, ID_A)).rejects.toThrow(/[Uu]nknown ciphertext version/);
    });

    it('rejects ciphertext that is too short', async () => {
      const tooShort = Buffer.from('tooshort!!').toString('base64');
      await expect(decryptGlobal(tooShort, ID_A)).rejects.toThrow('ciphertext too short');
    });
  });
});
