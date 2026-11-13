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
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

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
export function installWorktreeDependencies(worktreePath: string, projectRoot: string): boolean {
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
    configureWorktreePnpmStore(worktreePath);

    // --store-dir too: a tracked .npmrc cannot carry it (T13541).
    const storeDir = join(worktreePath, '.pnpm-store');
    execFileSync(
      'pnpm',
      ['install', '--frozen-lockfile', '--prefer-offline', '--store-dir', storeDir],
      {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: PNPM_INSTALL_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[worktree] pnpm install failed for ${worktreePath}: ${message}\n`);
    return false;
  } finally {
    if (releaseLock) {
      releaseLock();
    }
  }
}

/**
 * Point the worktree's pnpm at its own store (`<worktree>/.pnpm-store`) via
 * `.npmrc`, keeping every other line of an existing `.npmrc`. Called at
 * provisioning whether or not the install runs now, so a worker that installs
 * later (deferred or `--no-install`) never touches the shared global store,
 * where concurrent installs corrupt `.pnpm/` (T9938, T13538). Best-effort.
 *
 * A TRACKED `.npmrc` is left alone: editing it would leave a dirty tracked
 * file the worker might commit. The worker's install command carries
 * `--store-dir` for that case.
 *
 * @param worktreePath - The worktree.
 * @returns The store directory configured, or `null` when `.npmrc` is tracked
 *   or could not be written.
 * @task T9938
 * @task T13538
 */
export function configureWorktreePnpmStore(worktreePath: string): string | null {
  const npmrcPath = join(worktreePath, '.npmrc');
  const storeDir = join(worktreePath, '.pnpm-store');
  const tracked = isNpmrcTracked(worktreePath);
  // Keep the store, and the untracked `.npmrc` naming it, out of `git status`
  // and `git add -A` (T14552): an untracked `.npmrc` made every finished
  // worktree fail the disposal proof. info/exclude lives in the COMMON .git,
  // so this also hides an untracked root `.npmrc` in the main checkout (a
  // per-machine file, often holding registry tokens); a tracked `.npmrc` is
  // never affected by an exclude, and is never edited here (T13541).
  excludeFromGit(worktreePath, tracked ? ['/.pnpm-store/'] : ['/.pnpm-store/', '/.npmrc']);
  if (tracked) return null;
  try {
    const kept = existsSync(npmrcPath)
      ? npmrcLinesWithoutStoreDir(readFileSync(npmrcPath, 'utf-8'))
      : [];
    const content = `${[...kept, `store-dir=${storeDir}`].join('\n')}\n`;
    writeFileSync(npmrcPath, content, 'utf-8');
    recordProvisionedNpmrc(worktreePath, content);
    return storeDir;
  } catch {
    return null;
  }
}

/** The non-blank lines of an `.npmrc` other than `store-dir`. */
function npmrcLinesWithoutStoreDir(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '' && !/^\s*store-dir\s*=/.test(line));
}

/** File in the worktree's own git admin dir holding the `.npmrc` bytes provisioning wrote (T14552). */
const PROVISIONED_NPMRC_RECORD = 'cleo-provisioned-npmrc';

/** The worktree's own git admin dir (`.git/worktrees/<name>`), or `null` when git fails. */
function worktreeGitDir(worktreePath: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Record the exact `.npmrc` bytes provisioning wrote, in the worktree's own
 * git admin dir (removed with the worktree, never in its tree), so the
 * disposal proof can later prove the file unchanged byte for byte whatever the
 * main checkout's configuration has become since. Best-effort: without a
 * record only the bare legacy file is proven.
 */
function recordProvisionedNpmrc(worktreePath: string, content: string): void {
  const gitDir = worktreeGitDir(worktreePath);
  if (gitDir === null) return;
  try {
    writeFileSync(join(gitDir, PROVISIONED_NPMRC_RECORD), content, 'utf-8');
  } catch {
    // Best-effort: an unrecorded `.npmrc` with seeded lines is simply kept.
  }
}

/**
 * Whether the worktree's `.npmrc` is byte-for-byte what provisioning wrote for
 * THIS worktree (T14552): the content recorded in its git admin dir when one
 * exists, else (a worktree provisioned before the record) the only content
 * provisioning could have written with nothing to keep,
 * `store-dir=<worktree>/.pnpm-store` and a newline. Never derived from the
 * main checkout's current configuration. A read error answers `false`.
 */
function isProvisionedNpmrc(worktreePath: string): boolean {
  try {
    const actual = readFileSync(join(worktreePath, '.npmrc'));
    const gitDir = worktreeGitDir(worktreePath);
    const recordPath = gitDir === null ? null : join(gitDir, PROVISIONED_NPMRC_RECORD);
    const expected =
      recordPath !== null && existsSync(recordPath)
        ? readFileSync(recordPath)
        : Buffer.from(`store-dir=${join(worktreePath, '.pnpm-store')}\n`, 'utf-8');
    return actual.equals(expected);
  } catch {
    return false;
  }
}

/** Names pnpm writes inside a `v<N>` store directory. */
const STORE_SECTIONS = new Set(['files', 'index', 'projects', 'tmp']);

/**
 * Whether `<worktree>/.pnpm-store` is a real directory laid out as a pnpm
 * content-addressed store and nothing else (T14552): only `v<N>/` version
 * directories; inside them only `files/`, `index/`, `projects/` and `tmp/`;
 * `files/<2 hex>/<hex>[-exec]` and `index/<2 hex>/<hex>-<pkg>.json` regular
 * files; `projects/` entries named by hex; `tmp/` holding no symlink. A
 * symlink, a file in place of the store, or any unexpected name fails, and so
 * does a read error.
 */
function isPnpmStoreDir(worktreePath: string): boolean {
  const isDir = (p: string) => lstatSync(p).isDirectory();
  const isFile = (p: string) => lstatSync(p).isFile();
  const allDirs = (p: string, name: RegExp, each: (child: string) => boolean): boolean =>
    readdirSync(p).every((n) => name.test(n) && isDir(join(p, n)) && each(join(p, n)));
  const allFiles = (p: string, name: RegExp): boolean =>
    readdirSync(p).every((n) => name.test(n) && isFile(join(p, n)));
  const noSymlinks = (p: string): boolean =>
    readdirSync(p).every((n) => {
      const st = lstatSync(join(p, n));
      return st.isDirectory() ? noSymlinks(join(p, n)) : st.isFile();
    });
  const section = (p: string, n: string): boolean => {
    if (n === 'files')
      return allDirs(p, /^[0-9a-f]{2}$/, (d) => allFiles(d, /^[0-9a-f]+(-exec|-index\.json)?$/));
    if (n === 'index')
      return allDirs(p, /^[0-9a-f]{2}$/, (d) => allFiles(d, /^[0-9a-f]+-.+\.json$/));
    if (n === 'projects') return readdirSync(p).every((e) => /^[0-9a-f]+$/.test(e));
    return noSymlinks(p); // tmp
  };
  const root = join(worktreePath, '.pnpm-store');
  try {
    // The store itself is a real directory, never a symlink or a file.
    if (!isDir(root)) return false;
    return allDirs(root, /^v\d+$/, (v) =>
      readdirSync(v).every(
        (n) => STORE_SECTIONS.has(n) && isDir(join(v, n)) && section(join(v, n), n),
      ),
    );
  } catch {
    return false;
  }
}

/**
 * A probe answering whether a worktree path is pnpm provisioning CLEO
 * regenerates on demand, so removing it loses nothing (T14552): anything
 * inside `.pnpm-store/` when that is a real pnpm store directory
 * ({@link isPnpmStoreDir}, checked once per probe), and a root `.npmrc`
 * byte-for-byte what provisioning wrote for this worktree. Everything else,
 * including a regular file named `.pnpm-store` and an edited `.npmrc`, stays
 * strict.
 *
 * @param worktreePath - The worktree root.
 * @returns A predicate over paths relative to the worktree root, `/`-separated.
 * @task T14552
 */
export function pnpmProvisioningProbe(worktreePath: string): (rel: string) => boolean {
  let store: boolean | undefined;
  let npmrc: boolean | undefined;
  return (rel) => {
    if (rel === '.pnpm-store' || rel.startsWith('.pnpm-store/')) {
      store ??= isPnpmStoreDir(worktreePath);
      return store;
    }
    if (rel !== '.npmrc') return false;
    npmrc ??= isProvisionedNpmrc(worktreePath);
    return npmrc;
  };
}

/**
 * Whether the worktree's `.npmrc` is tracked by git (`git ls-files
 * --error-unmatch`): then it cannot carry the worktree's `store-dir`.
 *
 * @param worktreePath - The worktree.
 * @returns `true` when tracked; `false` when untracked, absent, or git fails.
 * @task T13538
 * @task T13541
 */
export function isNpmrcTracked(worktreePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '.npmrc'], {
      cwd: worktreePath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Append patterns to the repository's `info/exclude` (from `git rev-parse
 * --git-path info/exclude`), never to a tracked `.gitignore`. Idempotent and
 * best-effort.
 *
 * @param cwd - A directory inside the worktree.
 * @param patterns - Root-anchored patterns to exclude.
 * @task T13538
 */
export function excludeFromGit(cwd: string, patterns: readonly string[]): void {
  try {
    const rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const excludePath = isAbsolute(rel) ? rel : join(cwd, rel);
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    const have = new Set(current.split('\n').map((l) => l.trim()));
    const missing = patterns.filter((p) => !have.has(p));
    if (missing.length === 0) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    writeFileSync(excludePath, `${current}${sep}${missing.join('\n')}\n`, 'utf-8');
  } catch {
    // Best-effort: an unexcluded store is visible, not harmful.
  }
}
