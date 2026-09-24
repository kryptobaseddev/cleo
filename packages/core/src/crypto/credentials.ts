/**
 * Credential encryption — AES-256-GCM with device-bound key derivation.
 *
 * Every key derives from the 32-byte `machine-key` in the CLEO home. That key
 * NEVER leaves the device; credentials cross devices only through the
 * passphrase-sealed path in `store/credential-transfer.ts`.
 *
 * Two KDFs:
 *
 * - **Project** (T12326): `HMAC-SHA256(machine-key, "cleo:project-credential:v2\0"
 *   ‖ projectId)`, ciphertext version `0x02`. Keyed by project IDENTITY, so a
 *   moved or renamed project still decrypts. The pre-T12326 path-bound KDF
 *   (`HMAC-SHA256(machine-key, projectPath)`, version `0x01`) is read-only and
 *   migrated on first successful decrypt ({@link decryptProjectSecret}).
 * - **Global** (ADR-037 §5): `HMAC-SHA256(machine-key ‖ global-salt, id)`,
 *   version `0x01`, for project-independent credentials.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3.6
 * @module crypto/credentials
 */

import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCleoHome } from '../paths.js';
import { getGlobalSalt } from '../store/global-salt.js';

/** AES-256-GCM constants. */
const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
/**
 * Version byte of global-KDF ciphertexts (F-006: enables future algorithm
 * migration). Project ciphertexts carry their own versions — see
 * {@link PROJECT_CIPHERTEXT_VERSION_PROJECT_ID}.
 */
const CIPHERTEXT_VERSION = 0x01;

/**
 * Absolute path to the machine key file: `<cleoHome>/machine-key`.
 *
 * Resolved through {@link getCleoHome} — the same root as `global-salt` and
 * the agent registry's key reader — so `CLEO_HOME` relocates all of them
 * together. (Before T12326 this function re-derived the XDG path itself and
 * ignored `CLEO_HOME`, so a relocated home read the salt from one directory
 * and the key from another.) On every platform the default resolves to the
 * same file as before.
 *
 * The machine key is DEVICE-LOCAL by design: it is never exported in any
 * backup bundle. Credentials move between devices through
 * `store/credential-transfer.ts` instead.
 *
 * @returns Absolute path to the machine key.
 * @task T12326
 */
export function getMachineKeyPath(): string {
  return join(getCleoHome(), 'machine-key');
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
    // Verify key file permissions
    const stats = await stat(keyPath);
    if (process.platform === 'win32') {
      // Windows: use icacls to verify the key is not world-readable.
      try {
        const output = execFileSync('icacls', [keyPath], { encoding: 'utf-8', timeout: 5000 });
        const unsafePatterns = /\\(Users|Everyone|Authenticated Users):/i;
        if (unsafePatterns.test(output)) {
          throw new Error(
            `Machine key has unsafe Windows ACLs (accessible to other users). ` +
              `Fix with: icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%":F`,
          );
        }
      } catch (aclErr) {
        if (aclErr instanceof Error && aclErr.message.includes('unsafe')) throw aclErr;
      }
    } else {
      // Unix: verify 0600 permissions
      const mode = stats.mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(
          `Machine key has unsafe permissions (${mode.toString(8)}). Expected 0600. ` +
            `Fix with: chmod 600 ${keyPath}`,
        );
      }
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
      if (process.platform === 'win32') {
        // Lock down Windows ACLs: remove inherited permissions, grant only current user
        try {
          execFileSync(
            'icacls',
            [
              keyPath,
              '/inheritance:r',
              '/grant:r',
              `${process.env['USERNAME'] ?? 'CURRENT_USER'}:F`,
            ],
            { timeout: 5000 },
          );
        } catch {
          // Best-effort — icacls may not be available in all environments
        }
      } else {
        await chmod(keyPath, 0o600);
      }
      return key;
    }
    throw err;
  }
}

// ============================================================================
// Ciphertext framing (shared by every KDF)
// ============================================================================

/**
 * Encrypt `plaintext` under `key` and frame it as
 * base64(version ‖ iv ‖ ciphertext ‖ authTag).
 */
function sealWithKey(plaintext: string, key: Buffer, version: number): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([version]), iv, encrypted, authTag]).toString('base64');
}

/**
 * Split a framed ciphertext into its parts.
 *
 * @throws {Error} If the payload is shorter than the fixed framing.
 */
function unframe(ciphertext: string): {
  version: number;
  iv: Buffer;
  encrypted: Buffer;
  authTag: Buffer;
} {
  const packed = Buffer.from(ciphertext, 'base64');
  if (packed.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Cannot decrypt credentials: ciphertext too short');
  }
  return {
    version: packed[0] ?? -1,
    iv: packed.subarray(1, 1 + IV_LENGTH),
    encrypted: packed.subarray(1 + IV_LENGTH, packed.length - AUTH_TAG_LENGTH),
    authTag: packed.subarray(packed.length - AUTH_TAG_LENGTH),
  };
}

/**
 * Decrypt a framed ciphertext under `key`. Returns `null` when the GCM auth
 * tag rejects the key — the caller decides whether another key is worth trying.
 */
function openWithKey(parts: ReturnType<typeof unframe>, key: Buffer): string | null {
  const decipher = createDecipheriv(ALGORITHM, key, parts.iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(parts.authTag);
  try {
    return Buffer.concat([decipher.update(parts.encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ============================================================================
// Project KDF — keyed by project IDENTITY, not project path (T12326)
// ============================================================================

/**
 * Ciphertext version written by the pre-T12326 project KDF,
 * `HMAC-SHA256(machine-key, projectPath)`. Read-only: decrypted during
 * migration, never written.
 */
export const PROJECT_CIPHERTEXT_VERSION_LEGACY_PATH = 0x01;

/**
 * Ciphertext version written by the project-identity KDF,
 * `HMAC-SHA256(machine-key, "cleo:project-credential:v2\0" ‖ projectId)`.
 */
export const PROJECT_CIPHERTEXT_VERSION_PROJECT_ID = 0x02;

/** Domain-separation prefix for the project-identity KDF message. */
const PROJECT_ID_KDF_CONTEXT = 'cleo:project-credential:v2\0';

/**
 * Which KDF decrypted a project credential.
 *
 * @task T12326
 */
export type ProjectCredentialKdf = 'project-id' | 'legacy-path';

/**
 * Key context for {@link decryptProjectSecret}.
 *
 * @task T12326
 */
export interface ProjectSecretContext {
  /**
   * Stable project identity — the `projectId` of `.cleo/project-info.json`
   * (or its tracked successor). Travels with the project directory, so a
   * moved or renamed checkout derives the same key.
   */
  readonly projectId: string;
  /**
   * Candidate project paths for ciphertexts still under the legacy path KDF
   * (typically the current root plus the path the registry last recorded).
   * Tried in order; unused for project-id ciphertexts.
   */
  readonly legacyProjectPaths?: readonly string[];
}

/**
 * Result of {@link decryptProjectSecret}.
 *
 * @task T12326
 */
export interface ProjectSecretReadResult {
  /** The decrypted secret. */
  readonly plaintext: string;
  /** Which KDF opened it. */
  readonly kdf: ProjectCredentialKdf;
  /**
   * When the ciphertext was legacy (path-bound): the same secret re-encrypted
   * under the project-id KDF. The caller persists it in place of the old
   * ciphertext. `null` when the ciphertext was already current.
   */
  readonly rewrapped: string | null;
}

/**
 * Derive the project-identity key.
 *
 * @throws {Error} If `projectId` is empty — an empty id would collapse every
 *   project onto one key.
 */
async function deriveProjectIdKey(projectId: string): Promise<Buffer> {
  if (projectId.length === 0) {
    throw new Error('Cannot derive a project credential key: projectId is empty');
  }
  const machineKey = await getMachineKey();
  return createHmac('sha256', machineKey)
    .update(PROJECT_ID_KDF_CONTEXT + projectId, 'utf8')
    .digest();
}

/**
 * Derive the LEGACY path-bound project key, `HMAC-SHA256(machine-key, path)`.
 * Used only to read pre-T12326 ciphertexts during migration.
 */
async function deriveLegacyPathKey(projectPath: string): Promise<Buffer> {
  const machineKey = await getMachineKey();
  return createHmac('sha256', machineKey).update(projectPath).digest();
}

/**
 * Encrypt a project-scoped secret under the project-identity KDF.
 *
 * The key is `HMAC-SHA256(machine-key, "cleo:project-credential:v2\0" ‖
 * projectId)`: bound to this device (machine-key) and to the project's
 * identity, but NOT to where the project directory lives. Moving or renaming
 * the checkout keeps the key; a different device does not (see
 * `store/credential-transfer.ts` for the portable path).
 *
 * @param plaintext - The secret (e.g. an agent API key).
 * @param projectId - Stable project identity.
 * @returns Base64 ciphertext, version byte {@link PROJECT_CIPHERTEXT_VERSION_PROJECT_ID}.
 * @task T12326
 */
export async function encryptProjectSecret(plaintext: string, projectId: string): Promise<string> {
  const key = await deriveProjectIdKey(projectId);
  return sealWithKey(plaintext, key, PROJECT_CIPHERTEXT_VERSION_PROJECT_ID);
}

/**
 * Decrypt a project-scoped secret, migrating legacy ciphertexts on the way.
 *
 * - Version `0x02` ciphertexts open with the project-identity key.
 * - Version `0x01` (legacy, path-bound) ciphertexts are tried against each of
 *   `legacyProjectPaths`; the first that authenticates wins and the secret is
 *   re-encrypted under the project-identity KDF and returned as `rewrapped`
 *   for the caller to persist. The legacy ciphertext is never needed again.
 *
 * @param ciphertext - Base64 ciphertext from either KDF.
 * @param context - Project identity plus legacy path candidates.
 * @returns The plaintext, which KDF opened it, and any re-wrapped ciphertext.
 * @throws {Error} If no key authenticates. The message names the paths tried
 *   so the caller can report which credential to re-enter.
 * @task T12326
 */
export async function decryptProjectSecret(
  ciphertext: string,
  context: ProjectSecretContext,
): Promise<ProjectSecretReadResult> {
  const parts = unframe(ciphertext);

  if (parts.version === PROJECT_CIPHERTEXT_VERSION_PROJECT_ID) {
    const plaintext = openWithKey(parts, await deriveProjectIdKey(context.projectId));
    if (plaintext === null) {
      throw new Error(
        `Cannot decrypt project credential for project ${context.projectId}: ` +
          'the machine key differs from the one that encrypted it (another device, or a ' +
          'regenerated machine-key), or the data is corrupted.',
      );
    }
    return { plaintext, kdf: 'project-id', rewrapped: null };
  }

  if (parts.version === PROJECT_CIPHERTEXT_VERSION_LEGACY_PATH) {
    const candidates = [...new Set(context.legacyProjectPaths ?? [])];
    for (const candidate of candidates) {
      const plaintext = openWithKey(parts, await deriveLegacyPathKey(candidate));
      if (plaintext !== null) {
        return {
          plaintext,
          kdf: 'legacy-path',
          rewrapped: await encryptProjectSecret(plaintext, context.projectId),
        };
      }
    }
    throw new Error(
      'Cannot decrypt legacy path-bound project credential: none of the candidate project ' +
        `paths opened it (${candidates.length === 0 ? 'none supplied' : candidates.join(', ')}). ` +
        'It was encrypted at a path this device no longer knows, or on another device.',
    );
  }

  throw new Error(
    `Unknown project ciphertext version (${parts.version}). Expected ` +
      `${PROJECT_CIPHERTEXT_VERSION_PROJECT_ID} or ${PROJECT_CIPHERTEXT_VERSION_LEGACY_PATH}.`,
  );
}

// ============================================================================
// Global (project-independent) KDF — ADR-037 §5
// ============================================================================

/**
 * Derive a per-identity, machine-bound encryption key that is independent of
 * any project path.
 *
 * Implements the ADR-037 §5 KDF:
 * ```
 * key = HMAC-SHA256(machine-key || globalSalt, id)
 * ```
 *
 * Unlike {@link deriveProjectKey}, the derived key is bound to the machine
 * (via the 32-byte machine-key) AND a machine-local 32-byte global salt, but
 * NOT to a project directory. This lets globally-scoped credentials (e.g. LLM
 * API keys stored in the global signaldock) decrypt consistently from any
 * project on the same machine.
 *
 * The global salt is sourced from the existing {@link getGlobalSalt}
 * subsystem (`store/global-salt.ts`) — it is never re-implemented here.
 *
 * @param id - The stable identity binding the ciphertext (e.g. an agentId or
 *   credential id). The same `id` MUST be supplied to {@link decryptGlobal};
 *   a different `id` yields a different key and fails the GCM auth tag.
 * @returns A 32-byte AES-256 key derived from machine-key + global-salt + id.
 *
 * @see ADR-037 §5 — KDF design (`HMAC-SHA256(machine-key || globalSalt, id)`)
 * @see getGlobalSalt — global-salt source of truth (store/global-salt.ts)
 * @task T11710
 */
async function deriveGlobalKey(id: string): Promise<Buffer> {
  const machineKey = await getMachineKey();
  const globalSalt = getGlobalSalt();
  // HMAC key = machine-key || globalSalt (concatenation); message = id.
  const hmacKey = Buffer.concat([machineKey, globalSalt]);
  return createHmac('sha256', hmacKey).update(id).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM with a global, machine-bound key.
 *
 * Output format is byte-identical to {@link encrypt}:
 * base64(version + iv + ciphertext + authTag)
 *   - version: 1 byte (0x01 = AES-256-GCM)
 *   - iv: 12 bytes
 *   - ciphertext: variable length
 *   - authTag: 16 bytes
 *
 * The encryption key is derived via {@link deriveGlobalKey} (machine-key +
 * global-salt + `id`), so the resulting ciphertext decrypts from any project
 * on the same machine — unlike the project-bound {@link encrypt}.
 *
 * @param plaintext - The string to encrypt (e.g. an LLM API key).
 * @param id - The stable identity used for key derivation (e.g. an agentId).
 * @returns Base64-encoded ciphertext.
 *
 * @see decryptGlobal — the inverse operation.
 * @task T11710
 */
export async function encryptGlobal(plaintext: string, id: string): Promise<string> {
  const key = await deriveGlobalKey(id);
  return sealWithKey(plaintext, key, CIPHERTEXT_VERSION);
}

/**
 * Decrypt a base64-encoded ciphertext produced by {@link encryptGlobal} using
 * the global, machine-bound key derived from `id`.
 *
 * @param ciphertext - Base64-encoded string from {@link encryptGlobal}.
 * @param id - The identity used at encryption time. A mismatched `id` derives a
 *   different key and fails the GCM auth tag (throws).
 * @returns The original plaintext string.
 * @throws If decryption fails (wrong id, corrupted data, or machine-key/
 *   global-salt mismatch).
 *
 * @see encryptGlobal — the inverse operation.
 * @task T11710
 */
export async function decryptGlobal(ciphertext: string, id: string): Promise<string> {
  const parts = unframe(ciphertext);
  if (parts.version !== CIPHERTEXT_VERSION) {
    throw new Error(
      `Unknown ciphertext version (${parts.version}). Expected ${CIPHERTEXT_VERSION}. ` +
        'Re-register agents to re-encrypt with the current format.',
    );
  }
  const plaintext = openWithKey(parts, await deriveGlobalKey(id));
  if (plaintext === null) {
    throw new Error(
      'Cannot decrypt global credentials. Machine key / global-salt mismatch, ' +
        'wrong id, or corrupted data. If this database was moved from another ' +
        'machine, re-register the credential under its original id.',
    );
  }
  return plaintext;
}
