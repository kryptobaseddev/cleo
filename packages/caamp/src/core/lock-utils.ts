/**
 * Shared lock file utilities
 *
 * Single source of truth for reading/writing the canonical CAAMP lock file path.
 * Both MCP and skills lock modules import from here.
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { CaampLockFile } from '../types.js';
import { AGENTS_HOME, LOCK_FILE_PATH } from './paths/agents.js';

const LOCK_GUARD_PATH = `${LOCK_FILE_PATH}.lock`;
const STALE_LOCK_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleLock(): Promise<boolean> {
  try {
    const info = await stat(LOCK_GUARD_PATH);
    if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
      await rm(LOCK_GUARD_PATH, { force: true });
      return true;
    }
  } catch {
    // Lock file doesn't exist or can't be stat'd — not stale
  }
  return false;
}

async function acquireLockGuard(retries = 40, delayMs = 25): Promise<void> {
  await mkdir(AGENTS_HOME, { recursive: true });

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const handle = await open(LOCK_GUARD_PATH, 'wx');
      await handle.close();
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
      ) {
        throw error;
      }
      // On first retry failure, check for stale lock from a crashed process
      if (attempt === 0) {
        const removed = await removeStaleLock();
        if (removed) continue;
      }
      await sleep(delayMs);
    }
  }

  throw new Error('Timed out waiting for lock file guard');
}

async function releaseLockGuard(): Promise<void> {
  await rm(LOCK_GUARD_PATH, { force: true });
}

async function writeLockFileUnsafe(lock: CaampLockFile): Promise<void> {
  const tmpPath = `${LOCK_FILE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, LOCK_FILE_PATH);
}

/**
 * Read and parse the CAAMP lock file from disk.
 *
 * @remarks
 * Returns a default empty lock structure when the file does not exist or
 * cannot be parsed, ensuring callers always receive a valid object.
 *
 * @returns Parsed lock file contents
 *
 * @example
 * ```typescript
 * const lock = await readLockFile();
 * console.log(Object.keys(lock.mcpServers));
 * ```
 *
 * @public
 */
export async function readLockFile(): Promise<CaampLockFile> {
  try {
    if (!existsSync(LOCK_FILE_PATH)) {
      return { version: 1, skills: {}, mcpServers: {} };
    }
    const content = await readFile(LOCK_FILE_PATH, 'utf-8');
    return JSON.parse(content) as CaampLockFile;
  } catch {
    return { version: 1, skills: {}, mcpServers: {} };
  }
}

/**
 * Write the lock file atomically under a process lock guard.
 *
 * @remarks
 * Uses a file-system lock guard to prevent concurrent writes from multiple
 * CAAMP processes. The write itself is atomic (write-to-tmp then rename).
 *
 * @param lock - Lock file data to persist
 *
 * @example
 * ```typescript
 * const lock = await readLockFile();
 * lock.mcpServers["my-server"] = entry;
 * await writeLockFile(lock);
 * ```
 *
 * @public
 */
export async function writeLockFile(lock: CaampLockFile): Promise<void> {
  await acquireLockGuard();
  try {
    await writeLockFileUnsafe(lock);
  } finally {
    await releaseLockGuard();
  }
}

/**
 * Safely read-modify-write the lock file under a process lock guard.
 *
 * @remarks
 * Acquires an exclusive file-system lock, reads the current lock file, applies
 * the updater callback, writes the result atomically, and releases the lock.
 * The updater may mutate the lock object in place.
 *
 * @param updater - Callback that modifies the lock object (may be async)
 * @returns The updated lock file contents after the write
 *
 * @example
 * ```typescript
 * const updated = await updateLockFile((lock) => {
 *   lock.mcpServers["new-server"] = entry;
 * });
 * ```
 *
 * @public
 */
export async function updateLockFile(
  updater: (lock: CaampLockFile) => void | Promise<void>,
): Promise<CaampLockFile> {
  await acquireLockGuard();
  try {
    const lock = await readLockFile();
    await updater(lock);
    await writeLockFileUnsafe(lock);
    return lock;
  } finally {
    await releaseLockGuard();
  }
}
