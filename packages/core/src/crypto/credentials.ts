/**
 * Credential encryption — AES-256-GCM with machine-bound key derivation.
 *
 * API keys (`sk_live_*`) are encrypted at rest in SQLite using AES-256-GCM.
 * The encryption key is derived per-project from a machine-specific secret:
 *
 *   machine-key (32 random bytes at ~/.local/share/cleo/machine-key)
 *   + project path
 *   = HMAC-SHA256(machine-key, project-path) → per-project AES key
 *
 * This means credentials are bound to BOTH the machine AND the project.
 * Moving `.cleo/tasks.db` to another machine renders stored keys unreadable.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3.6
 * @module crypto/credentials
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** AES-256-GCM constants. */
const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
/** Version byte prefix for ciphertext format (F-006: enables future algorithm migration). */
const CIPHERTEXT_VERSION = 0x01;

/**
 * Get the path to the machine key file.
 * Uses XDG data dir: `~/.local/share/cleo/machine-key`
 *
 * @throws If HOME/USERPROFILE are unset (F-002: never fall back to /tmp).
 */
function getMachineKeyPath(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (!home) {
    throw new Error(
      'Cannot determine home directory. Set HOME or USERPROFILE environment variable. ' +
        'Machine key cannot be stored securely without a persistent home directory.',
    );
  }
  return join(home, '.local', 'share', 'cleo', 'machine-key');
}

/**
 * Read or auto-generate the machine key (32 random bytes).
 * Sets file permissions to 0600 (owner read/write only).
 *
 * @throws If the machine key exists but has wrong permissions (not 0600).
 */
async function getMachineKey(): Promise<Buffer> {
  const keyPath = getMachineKeyPath();

  try {
    // Check existing key
    const stats = await stat(keyPath);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `Machine key has unsafe permissions (${mode.toString(8)}). Expected 0600. ` +
          `Fix with: chmod 600 ${keyPath}`,
      );
    }
    const key = await readFile(keyPath);
    // F-004: validate key length
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `Machine key has invalid length (${key.length} bytes, expected ${KEY_LENGTH}). ` +
          `Delete ${keyPath} and re-register agents to generate a new key.`,
      );
    }
    return key;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Auto-generate on first use
      const key = randomBytes(KEY_LENGTH);
      await mkdir(dirname(keyPath), { recursive: true });
      await writeFile(keyPath, key, { mode: 0o600 });
      await chmod(keyPath, 0o600); // Ensure perms even on existing dirs
      return key;
    }
    throw err;
  }
}

/**
 * Derive a per-project encryption key from the machine key.
 * Uses HMAC-SHA256(machine-key, project-path) to produce a 32-byte AES key.
 */
async function deriveProjectKey(projectPath: string): Promise<Buffer> {
  const machineKey = await getMachineKey();
  return createHmac('sha256', machineKey).update(projectPath).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM with a per-project key.
 *
 * Output format: base64(version + iv + ciphertext + authTag)
 *   - version: 1 byte (0x01 = AES-256-GCM)
 *   - iv: 12 bytes
 *   - ciphertext: variable length
 *   - authTag: 16 bytes
 *
 * @param plaintext - The string to encrypt (e.g. an API key).
 * @param projectPath - Absolute path to the project directory (used for key derivation).
 * @returns Base64-encoded ciphertext.
 */
export async function encrypt(plaintext: string, projectPath: string): Promise<string> {
  const key = await deriveProjectKey(projectPath);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: version + iv + ciphertext + authTag (F-006: version byte for future migration)
  const version = Buffer.from([CIPHERTEXT_VERSION]);
  const packed = Buffer.concat([version, iv, encrypted, authTag]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext using AES-256-GCM with a per-project key.
 *
 * @param ciphertext - Base64-encoded string from `encrypt()`.
 * @param projectPath - Absolute path to the project directory (must match the one used for encryption).
 * @returns The original plaintext string.
 * @throws If decryption fails (wrong key, corrupted data, or machine key mismatch).
 */
export async function decrypt(ciphertext: string, projectPath: string): Promise<string> {
  const key = await deriveProjectKey(projectPath);
  const packed = Buffer.from(ciphertext, 'base64');

  if (packed.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Cannot decrypt credentials: ciphertext too short');
  }

  // F-006: check version byte
  const version = packed[0];
  if (version !== CIPHERTEXT_VERSION) {
    throw new Error(
      `Unknown ciphertext version (${version}). Expected ${CIPHERTEXT_VERSION}. ` +
        'Re-register agents to re-encrypt with the current format.',
    );
  }

  const iv = packed.subarray(1, 1 + IV_LENGTH);
  const authTag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
  const encrypted = packed.subarray(1 + IV_LENGTH, packed.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      'Cannot decrypt credentials. Machine key mismatch or corrupted data. ' +
        'If this database was moved from another machine, re-register agents: ' +
        'cleo agent register --id <id> --api-key <key>',
    );
  }
}
