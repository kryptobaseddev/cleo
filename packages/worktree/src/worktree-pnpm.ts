/**
 * Serialized pnpm install for worktree provisioning.
 *
 * When multiple worktrees are provisioned concurrently and pnpm-lock.yaml
 * is included via .worktreeinclude, each worktree needs its own node_modules
 * installed. Without serialization, concurrent pnpm installs race on the
 * shared global content-addressable store and corrupt .pnpm/ with doubled
 * @@-prefixed directories (T9938).
 *
 * This module provides a file-based mutex that ensures only one worktree
 * runs pnpm install at a time during provisioning.
 *
 * @task T9938
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const PNPM_INSTALL_TIMEOUT_MS = 120_000;
const LOCK_RETRY_INTERVAL_MS = 500;
const LOCK_MAX_WAIT_MS = 300_000; // 5 min max wait

/**
 * Acquire a file-based mutex lock for serialized pnpm operations.
 *
 * Creates an exclusive lock file at `<projectRoot>/.cleo/pnpm-install.lock`.
 * Uses O_CREAT|O_EXCL for atomic creation — no race window between check
 * and create. Retries with backoff until the lock is acquired or timeout.
 *
 * Returns a release function that removes the lock file.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns A function to call to release the lock.
 */
function acquirePnpmLock(projectRoot: string): () => void {
  const lockDir = join(projectRoot, '.cleo');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, 'pnpm-install.lock');

  const startTime = Date.now();

  while (true) {
    try {
      // O_CREAT|O_EXCL — fail if file already exists (atomic)
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Best-effort cleanup — lock file may already be gone.
        }
      };
    } catch {
      // Lock exists — another process has it.
      const elapsed = Date.now() - startTime;
      if (elapsed >= LOCK_MAX_WAIT_MS) {
        throw new Error(
          `pnpm-install lock timeout after ${LOCK_MAX_WAIT_MS}ms — ` +
            `stale lock at ${lockPath}? Remove it manually if no pnpm process is running.`,
        );
      }

      // Busy-wait with small interval — the lock holder should finish quickly.
      const waitUntil = Date.now() + LOCK_RETRY_INTERVAL_MS;
      while (Date.now() < waitUntil) {
        // Spin-wait — sub-ms precision is fine for short intervals.
      }
    }
  }
}

/**
 * Run pnpm install in a worktree with serialization via file-based mutex.
 *
 * Only one worktree's pnpm install runs at a time across the entire project.
 * This prevents the @@-prefixed doubled-directory corruption in .pnpm/
 * caused by concurrent pnpm operations on the shared content-addressable store.
 *
 * After install, a `.pnpm-store/` directory is created in the worktree root
 * and configured via `.npmrc` to isolate the worktree's pnpm store from the
 * project root's global store. This prevents future races when the agent
 * runs additional pnpm operations.
 *
 * @param worktreePath - Absolute path to the worktree.
 * @param projectRoot - Absolute path to the project root (for lock file).
 * @returns true if install succeeded, false otherwise.
 *
 * @task T9938
 */
export function installWorktreeDependencies(
  worktreePath: string,
  projectRoot: string,
): boolean {
  const pnpmLockPath = join(worktreePath, 'pnpm-lock.yaml');
  if (!existsSync(pnpmLockPath)) {
    // No lockfile — nothing to install.
    return false;
  }

  // Don't re-install if node_modules already exists (idempotent).
  if (existsSync(join(worktreePath, 'node_modules'))) {
    return true;
  }

  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = acquirePnpmLock(projectRoot);

    // Configure per-worktree pnpm store to isolate from global store.
    // This prevents future races when agents run pnpm operations.
    const npmrcPath = join(worktreePath, '.npmrc');
    const storeDir = join(worktreePath, '.pnpm-store');
    try {
      writeFileSync(npmrcPath, `store-dir=${storeDir}\n`, 'utf-8');
    } catch {
      // Best-effort — pnpm install still works with global store.
    }

    execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: PNPM_INSTALL_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[worktree] pnpm install failed for ${worktreePath}: ${message}\n`,
    );
    return false;
  } finally {
    if (releaseLock) {
      releaseLock();
    }
  }
}
