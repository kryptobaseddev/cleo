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

  const saltPath = getGlobalSaltPath();
  const cleoHome = getCleoHome();

  if (!fs.existsSync(saltPath)) {
    // First-run generation: ensure the directory exists
    if (!fs.existsSync(cleoHome)) {
      fs.mkdirSync(cleoHome, { recursive: true });
    }

    const salt = crypto.randomBytes(GLOBAL_SALT_SIZE);

    // Atomic write: write to tmp file, chmod, then rename into place
    const tmpPath = `${saltPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, salt, { mode: SALT_FILE_MODE });
    // Explicit chmod in case writeFileSync's mode arg is ignored on some FS
    fs.chmodSync(tmpPath, SALT_FILE_MODE);
    fs.renameSync(tmpPath, saltPath);

    cached = salt;
    return cached;
  }

  // Existing file — validate before trusting
  const stat = fs.statSync(saltPath);

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

  const salt = fs.readFileSync(saltPath);
  cached = salt;
  return cached;
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
