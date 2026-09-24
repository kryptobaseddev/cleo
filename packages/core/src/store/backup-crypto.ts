/**
 * Encryption/decryption helpers for `.enc.cleobundle.tar.gz` bundles.
 *
 * Uses AES-256-GCM with a scrypt-derived key (Node built-in `node:crypto` only;
 * no native bindings). scrypt is memory-hard and NIST-approved. Argon2id (PHC
 * winner, spec §7.1) was the original target but adds a native binding
 * dependency that violates ADR-010. This module documents the trade-off:
 * scrypt with N=2^15 provides equivalent interactive-session security and full
 * cross-platform portability.
 *
 * Binary layout of an encrypted bundle:
 *   [8]  magic bytes "CLEOENC1" (0x43 0x4C 0x45 0x4F 0x45 0x4E 0x43 0x31)
 *   [1]  format version (0x01)
 *   [7]  reserved (zero-filled)
 *   [32] scrypt salt (random, per-bundle)
 *   [12] AES-256-GCM nonce (random, per-bundle)
 *   [N]  ciphertext (the tar.gz bytes)
 *   [16] AES-256-GCM authentication tag
 *
 * Total fixed overhead: 76 bytes header + 16 bytes auth tag = 92 bytes.
 *
 * @task T345
 * @epic T311
 * @see ADR-038 §5 — opt-in encrypted backups for portable export/import
 * @module store/backup-crypto
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/** Magic bytes that identify a CLEO encrypted bundle: ASCII "CLEOENC1". */
const MAGIC = Buffer.from('CLEOENC1', 'utf8'); // 8 bytes

/** Current format version byte written at offset 8. */
const VERSION = 0x01; // 1 byte

/** Reserved bytes at offsets 9–15 (zero-filled). */
const RESERVED = Buffer.alloc(7); // 7 bytes

/** Byte length of the per-bundle scrypt salt (offset 16). */
const SALT_SIZE = 32;

/** Byte length of the AES-256-GCM nonce (offset 48). */
const NONCE_SIZE = 12;

/** AES key length in bytes (AES-256). */
const KEY_SIZE = 32;

/** AES-256-GCM authentication tag length in bytes. */
const AUTH_TAG_SIZE = 16;

/**
 * scrypt CPU/memory cost parameter (N = 2^15 = 32768).
 * Provides ~64 MB memory hardness per derivation — equivalent to OWASP
 * interactive-login recommendation when Argon2id is unavailable.
 */
const SCRYPT_N = 2 ** 15;

/** scrypt block size parameter. */
const SCRYPT_R = 8;

/** scrypt parallelism parameter. */
const SCRYPT_P = 1;

/** Derived key length in bytes — must equal KEY_SIZE. */
const SCRYPT_KEY_LEN: typeof KEY_SIZE = KEY_SIZE;

/**
 * Minimum valid byte length of an encrypted bundle.
 * = magic(8) + version(1) + reserved(7) + salt(32) + nonce(12) + auth-tag(16)
 */
const MIN_ENCRYPTED_LENGTH = 8 + 1 + 7 + SALT_SIZE + NONCE_SIZE + AUTH_TAG_SIZE;

/**
 * Derives a 32-byte AES key from a user passphrase and a per-bundle salt
 * using Node's built-in scrypt (RFC 7914).
 *
 * Parameters are chosen to match OWASP Argon2id interactive-login guidance
 * adapted for scrypt: ~64 MB memory, single-threaded, ~100 ms on a 2024 laptop.
 *
 * @param passphrase - UTF-8 user passphrase (must be non-empty).
 * @param salt - 32-byte random per-bundle salt.
 * @returns 32-byte Buffer suitable for AES-256-GCM.
 *
 * @task T345
 * @epic T311
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // maxmem guard: 128 * N * r * 2 bytes — prevents accidental OOM
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  }) as Buffer;
}

/**
 * Encrypts a plaintext tarball buffer with AES-256-GCM.
 *
 * A fresh random 32-byte salt and 12-byte nonce are generated for every call,
 * so two encryptions of the same plaintext produce different ciphertexts.
 *
 * Output binary layout:
 * ```
 * Offset  Length  Field
 * 0        8      Magic bytes "CLEOENC1"
 * 8        1      Format version 0x01
 * 9        7      Reserved (zeros)
 * 16       32     scrypt salt
 * 48       12     GCM nonce
 * 60       N      Ciphertext
 * 60+N     16     GCM auth tag
 * ```
 *
 * @param plaintext  - Raw `.cleobundle.tar.gz` bytes to encrypt.
 * @param passphrase - User-supplied passphrase (must be non-empty).
 * @returns Encrypted bundle bytes ready to write as `.enc.cleobundle.tar.gz`.
 * @throws {Error} If `passphrase` is empty.
 *
 * @task T345
 * @epic T311
 */
export function encryptBundle(plaintext: Buffer, passphrase: string): Buffer {
  if (passphrase.length === 0) {
    throw new Error('encryptBundle: passphrase cannot be empty');
  }

  const salt = crypto.randomBytes(SALT_SIZE);
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, Buffer.from([VERSION]), RESERVED, salt, nonce, ciphertext, authTag]);
}

/**
 * Decrypts an `.enc.cleobundle.tar.gz` payload back to its original tar.gz bytes.
 *
 * Validates magic bytes, format version, and the AES-256-GCM authentication
 * tag. Any mismatch throws descriptively so callers can map to the correct
 * exit code (E_BUNDLE_DECRYPT = 70).
 *
 * @param encrypted  - Full encrypted bundle bytes (as read from disk).
 * @param passphrase - User-supplied passphrase.
 * @returns Decrypted tar.gz bytes.
 * @throws {Error} `"decryptBundle: payload too short"` — buffer smaller than minimum.
 * @throws {Error} `"decryptBundle: magic mismatch (not a cleo encrypted bundle)"` — invalid magic.
 * @throws {Error} `"decryptBundle: unsupported version <n>, expected 1"` — unknown version byte.
 * @throws {Error} `"decryptBundle: authentication failed (wrong passphrase or corrupted bundle)"` — GCM tag invalid.
 *
 * @task T345
 * @epic T311
 */
export function decryptBundle(encrypted: Buffer, passphrase: string): Buffer {
  if (encrypted.length < MIN_ENCRYPTED_LENGTH) {
    throw new Error('decryptBundle: payload too short');
  }

  if (!encrypted.subarray(0, 8).equals(MAGIC)) {
    throw new Error('decryptBundle: magic mismatch (not a cleo encrypted bundle)');
  }

  const version = encrypted[8];
  if (version !== VERSION) {
    throw new Error(`decryptBundle: unsupported version ${version}, expected ${VERSION}`);
  }

  // Bytes 9–15 are reserved — ignored.
  const salt = encrypted.subarray(16, 16 + SALT_SIZE);
  const nonce = encrypted.subarray(16 + SALT_SIZE, 16 + SALT_SIZE + NONCE_SIZE);
  const ciphertext = encrypted.subarray(
    16 + SALT_SIZE + NONCE_SIZE,
    encrypted.length - AUTH_TAG_SIZE,
  );
  const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_SIZE);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('decryptBundle: authentication failed (wrong passphrase or corrupted bundle)');
  }
}

/**
 * Tests whether a buffer starts with the CLEO encrypted bundle magic bytes
 * `"CLEOENC1"`. Reads only the first 8 bytes; does not validate any other
 * part of the header.
 *
 * Useful for detecting encrypted bundles before attempting decryption, e.g.
 * when deciding whether to prompt for a passphrase.
 *
 * @param header - At least 8 bytes from the start of the file (may be longer).
 * @returns `true` if the magic bytes match; `false` if the buffer is too short
 *   or the magic does not match.
 *
 * @task T345
 * @epic T311
 */
export function isEncryptedBundle(header: Buffer): boolean {
  if (header.length < 8) return false;
  return header.subarray(0, 8).equals(MAGIC);
}

// ---------------------------------------------------------------------------
// Streaming variant (format version 0x02) — T12318
// ---------------------------------------------------------------------------

/**
 * Format version byte written by the streaming encryptor.
 *
 * The byte layout is identical to version 0x01; the distinct version lets a
 * reader tell a portable v2 bundle (streamed, possibly many GB) from a v1
 * bundle without decrypting it, and keeps v1 readers from buffering a file
 * they cannot interpret.
 */
export const STREAM_FORMAT_VERSION = 0x02;

/** Byte offset where ciphertext begins (magic + version + reserved + salt + nonce). */
const STREAM_HEADER_SIZE = 8 + 1 + 7 + SALT_SIZE + NONCE_SIZE;

/**
 * Write one chunk to a stream, waiting for `drain` when the buffer is full.
 *
 * @param out - Destination write stream.
 * @param chunk - Bytes to write.
 */
async function writeWithBackpressure(out: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (chunk.length === 0) return;
  if (!out.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      out.once('drain', resolve);
      out.once('error', reject);
    });
  }
}

/**
 * Close a write stream and wait until its bytes are flushed.
 *
 * @param out - Stream to finish.
 */
async function endStream(out: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(() => resolve());
  });
}

/**
 * Encrypt a file to another file without holding it in memory.
 *
 * Uses the same AES-256-GCM + scrypt construction and byte layout as
 * {@link encryptBundle}, with format version {@link STREAM_FORMAT_VERSION}.
 * Suitable for multi-GB machine bundles, which exceed a single Buffer.
 *
 * @param srcPath - Plaintext file.
 * @param destPath - Encrypted output file (overwritten).
 * @param passphrase - Non-empty passphrase.
 * @throws {Error} When the passphrase is empty or I/O fails.
 *
 * @task T12318
 */
export async function encryptFileStream(
  srcPath: string,
  destPath: string,
  passphrase: string,
): Promise<void> {
  if (passphrase.length === 0) {
    throw new Error('encryptFileStream: passphrase cannot be empty');
  }
  const salt = crypto.randomBytes(SALT_SIZE);
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const out = fs.createWriteStream(destPath);
  try {
    await writeWithBackpressure(
      out,
      Buffer.concat([MAGIC, Buffer.from([STREAM_FORMAT_VERSION]), RESERVED, salt, nonce]),
    );
    for await (const chunk of fs.createReadStream(srcPath)) {
      await writeWithBackpressure(out, cipher.update(chunk as Buffer));
    }
    await writeWithBackpressure(out, cipher.final());
    await writeWithBackpressure(out, cipher.getAuthTag());
  } finally {
    await endStream(out);
  }
}

/**
 * Decrypt a file written by {@link encryptFileStream} without holding it in memory.
 *
 * The plaintext is written to `destPath` as it is decrypted, but it is only
 * trustworthy once this function resolves: GCM authenticates at the end, so on
 * a wrong passphrase or tampered ciphertext the partial output is deleted and
 * the call rejects.
 *
 * @param srcPath - Encrypted file (version 0x02).
 * @param destPath - Plaintext output file.
 * @param passphrase - Passphrase used at encryption time.
 * @throws {Error} On bad magic/version, authentication failure, or I/O failure.
 *
 * @task T12318
 */
export async function decryptFileStream(
  srcPath: string,
  destPath: string,
  passphrase: string,
): Promise<void> {
  const size = fs.statSync(srcPath).size;
  if (size < STREAM_HEADER_SIZE + AUTH_TAG_SIZE) {
    throw new Error('decryptFileStream: payload too short');
  }
  const fd = fs.openSync(srcPath, 'r');
  const header = Buffer.alloc(STREAM_HEADER_SIZE);
  const tag = Buffer.alloc(AUTH_TAG_SIZE);
  try {
    fs.readSync(fd, header, 0, STREAM_HEADER_SIZE, 0);
    fs.readSync(fd, tag, 0, AUTH_TAG_SIZE, size - AUTH_TAG_SIZE);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, 8).equals(MAGIC)) {
    throw new Error('decryptFileStream: magic mismatch (not a cleo encrypted bundle)');
  }
  if (header[8] !== STREAM_FORMAT_VERSION) {
    throw new Error(
      `decryptFileStream: unsupported version ${header[8]}, expected ${STREAM_FORMAT_VERSION}`,
    );
  }
  const salt = header.subarray(16, 16 + SALT_SIZE);
  const nonce = header.subarray(16 + SALT_SIZE, STREAM_HEADER_SIZE);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), nonce);
  decipher.setAuthTag(tag);
  const out = fs.createWriteStream(destPath);
  let authenticated = false;
  try {
    const body = fs.createReadStream(srcPath, {
      start: STREAM_HEADER_SIZE,
      end: size - AUTH_TAG_SIZE - 1,
    });
    for await (const chunk of body) {
      await writeWithBackpressure(out, decipher.update(chunk as Buffer));
    }
    try {
      await writeWithBackpressure(out, decipher.final());
    } catch {
      throw new Error(
        'decryptFileStream: authentication failed (wrong passphrase or corrupted bundle)',
      );
    }
    authenticated = true;
  } finally {
    await endStream(out);
    if (!authenticated) fs.rmSync(destPath, { force: true });
  }
}

/**
 * Read the format version byte of an encrypted bundle header.
 *
 * @param header - At least 9 bytes from the start of the file.
 * @returns The version byte, or null when the header is not a CLEO encrypted bundle.
 *
 * @task T12318
 */
export function encryptedBundleVersion(header: Buffer): number | null {
  if (!isEncryptedBundle(header) || header.length < 9) return null;
  return header[8] ?? null;
}
