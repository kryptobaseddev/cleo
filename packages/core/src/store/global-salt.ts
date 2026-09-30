/**
 * Global-salt subsystem for the CLEO API key KDF.
 *
 * @task T348
 * @epic T310
 * @why ADR-037 §5 — API key KDF uses machine-key + global-salt + agentId.
 *      global-salt must persist across process restarts but is machine-local.
 * @what Atomic first-run generation, memoized read, permission/size validation.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getCleoHome } from '../paths.js';

/** Filename for the global salt file under CLEO home. */
export const GLOBAL_SALT_FILENAME = 'global-salt';

/** Required size of the global salt in bytes. */
export const GLOBAL_SALT_SIZE = 32;

/** Required file permission mode for the global salt file (POSIX). */
const SALT_FILE_MODE = 0o600;

/**
 * In-process memoization. Invalidated only by process restart.
 * Cleared in tests via `__clearGlobalSaltCache()` (test-only export).
 */
let cached: Buffer | null = null;

/**
 * Returns the absolute path to the global-salt file.
 *
 * @returns Absolute path: `{cleoHome}/global-salt`
 *
 * @task T348
 * @epic T310
 *
 * @example
 * ```typescript
 * const saltPath = getGlobalSaltPath();
 * // Linux: "/home/user/.local/share/cleo/global-salt"
 * ```
 */
export function getGlobalSaltPath(): string {
  return path.join(getCleoHome(), GLOBAL_SALT_FILENAME);
}

/**
 * Returns the 32-byte global salt. Generates and persists atomically on first
 * call when the file does not exist. Subsequent calls return the memoized value.
 *
 * Never overwrites an existing salt — doing so would invalidate every stored
 * API key derived from it.
 *
 * @returns A 32-byte Buffer containing the global salt
 * @throws {Error} If the salt file exists with wrong size or wrong permissions
 *
 * @task T348
 * @epic T310
 *
 * @example
 * ```typescript
 * const salt = getGlobalSalt(); // Buffer(32) [...]
 * ```
 */
export function getGlobalSalt(): Buffer {
  if (cached !== null) return cached;
  cached = loadGlobalSaltAt(getCleoHome());
  return cached;
}

/**
 * Read (or generate on first use) the global salt of an EXPLICIT CLEO home,
 * bypassing the process memo.
 *
 * {@link getGlobalSalt} memoizes the salt of the ambient home for the process
 * lifetime. That is wrong for code that addresses a different home, or one
 * whose salt file was just replaced — a backup import that places the bundled
 * `global-salt` and then re-encrypts credentials under it (T12326). Same
 * generation and validation rules as {@link getGlobalSalt}.
 *
 * @param cleoHome - Absolute CLEO home directory.
 * @returns The 32-byte salt stored at `<cleoHome>/global-salt`.
 * @throws {Error} If the salt file exists with wrong size or wrong permissions.
 * @task T12326
 */
export function loadGlobalSaltAt(cleoHome: string): Buffer {
  const existing = readGlobalSaltAt(cleoHome);
  if (existing !== null) return existing;

  // First-run generation. Never replaces a salt another process created
  // meanwhile: the create is exclusive, and whoever loses the race reads the
  // winner's salt (T12867 review N2). Replacing it would split the two
  // processes onto different keys.
  if (!fs.existsSync(cleoHome)) {
    fs.mkdirSync(cleoHome, { recursive: true });
  }
  const saltPath = path.join(cleoHome, GLOBAL_SALT_FILENAME);
  createSecretFileExclusive(saltPath, crypto.randomBytes(GLOBAL_SALT_SIZE), SALT_FILE_MODE);
  const created = readGlobalSaltAt(cleoHome);
  if (created === null) {
    throw new Error(`global-salt at ${saltPath} vanished right after it was created`);
  }
  return created;
}

/**
 * Read and validate the global salt of an explicit CLEO home WITHOUT ever
 * creating it. Read paths that must not mint key material use this.
 *
 * @param cleoHome - Absolute CLEO home directory.
 * @returns The 32-byte salt, or `null` when `<cleoHome>/global-salt` does not exist.
 * @throws {Error} If the salt file exists with wrong size or wrong permissions.
 * @task T12867
 */
export function readGlobalSaltAt(cleoHome: string): Buffer | null {
  const saltPath = path.join(cleoHome, GLOBAL_SALT_FILENAME);
  sweepStaleSecretTemps(saltPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(saltPath);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }

  if (stat.size !== GLOBAL_SALT_SIZE) {
    throw new Error(
      `global-salt at ${saltPath} has wrong size: expected ${GLOBAL_SALT_SIZE} bytes, got ${stat.size}. ` +
        `Refusing to use a corrupted salt file. Delete the file manually if you intend to regenerate it ` +
        `(this will invalidate all stored API keys).`,
    );
  }

  // Permission check: only meaningful on POSIX; Windows does not support mode bits
  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if (mode !== SALT_FILE_MODE) {
      throw new Error(
        `global-salt at ${saltPath} has wrong permissions: expected 0o600, got 0o${mode.toString(8)}. ` +
          `Fix with: chmod 600 ${saltPath}`,
      );
    }
  }

  return fs.readFileSync(saltPath);
}

/**
 * Create a secret file only if it does not exist, never replacing one that
 * another process created first. The bytes are written to a private temp
 * file and hard-linked into place, so the target appears complete or not at
 * all. Where hard links are unavailable, the target is created with the
 * exclusive `wx` flag instead.
 *
 * @param filePath - Target path.
 * @param data - The secret bytes.
 * @param mode - File mode (for example `0o600`).
 * @returns `true` when this call created the file, `false` when it already existed.
 * @task T12867
 */
export function createSecretFileExclusive(filePath: string, data: Buffer, mode: number): boolean {
  sweepStaleSecretTemps(filePath);
  // `.<basename>.<hex>.tmp`: hidden, and excluded from backup bundles by the
  // `.tmp` suffix rule. A crash between link and unlink leaves it as a second
  // hard link to the live secret, so it must never be exported.
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(tmpPath, 'wx', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // Explicit chmod in case writeFileSync's mode arg is narrowed by umask or ignored
    fs.chmodSync(tmpPath, mode);
    try {
      fs.linkSync(tmpPath, filePath);
      return true;
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') {
        throw err;
      }
    }
    try {
      fs.writeFileSync(filePath, data, { mode, flag: 'wx' });
      return true;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') return false;
      throw err;
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* already gone */
    }
  }
}

/** Age after which a leftover secret temp file is treated as a crash remnant. */
const STALE_SECRET_TEMP_MS = 60_000;

/**
 * Delete temp files that {@link createSecretFileExclusive} left behind for
 * `filePath` (`.<basename>.<12 hex>.tmp`) when a process crashed between the
 * link and the unlink. Such a file is a second hard link to the live secret.
 * Only files older than a minute are removed, so a concurrent creator's
 * in-flight temp file is never touched. Best effort.
 *
 * @param filePath - The secret file (for example `<cleoHome>/machine-key`).
 * @task T12867
 */
export function sweepStaleSecretTemps(filePath: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\.${base}\\.[0-9a-f]{12}\\.tmp$`);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const full = path.join(dir, entry);
    try {
      if (now - fs.lstatSync(full).mtimeMs > STALE_SECRET_TEMP_MS) fs.unlinkSync(full);
    } catch {
      /* vanished or not removable: best effort */
    }
  }
}

/**
 * Runtime validation helper for startup integrity checks.
 *
 * Throws if the salt file exists but is malformed (wrong size or permissions).
 * Safe to call when the file does not yet exist — returns silently in that case
 * because first-run generation is handled lazily by `getGlobalSalt()`.
 *
 * @throws {Error} If the salt file exists with wrong size or wrong permissions
 *
 * @task T348
 * @epic T310
 *
 * @example
 * ```typescript
 * // Called at process startup to catch accidental salt corruption early
 * validateGlobalSalt();
 * ```
 */
export function validateGlobalSalt(): void {
  const saltPath = getGlobalSaltPath();

  if (!fs.existsSync(saltPath)) {
    // Not yet generated — first-run case; no error
    return;
  }

  const stat = fs.statSync(saltPath);

  if (stat.size !== GLOBAL_SALT_SIZE) {
    throw new Error(
      `global-salt validation failed: size ${stat.size}, expected ${GLOBAL_SALT_SIZE}`,
    );
  }

  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if (mode !== SALT_FILE_MODE) {
      throw new Error(
        `global-salt validation failed: permissions 0o${mode.toString(8)}, expected 0o600`,
      );
    }
  }
}

/**
 * Clears the in-process memoization cache so tests can exercise the
 * first-call generation path independently.
 *
 * @internal TEST ONLY — do NOT export through internal.ts or re-export
 * from any public barrel. This symbol must never appear in production call paths.
 *
 * @task T348
 * @epic T310
 */
export function __clearGlobalSaltCache(): void {
  cached = null;
}
