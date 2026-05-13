/**
 * File utility helpers for CLEO data access.
 *
 * File utility helpers for CLEO data access including atomic writes,
 * file locking, and backup rotation.
 *
 * @task T4833
 * @epic T4654
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';

/**
 * Maximum number of operational backups to keep.
 */
const MAX_BACKUPS = 10;

/**
 * Create a numbered backup of a file (Tier 1 operational backup).
 *
 * When `mode` is provided, the backup directory is created at `mode`
 * (translated to a directory-execute bit) and each rotated backup is
 * written at `mode` so secrets never leak through historical copies.
 */
function rotateBackup(filePath: string, mode?: number): void {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const backupDir = join(dir, '.backups');

  // For secret-bearing writes (mode passed), the backup directory MUST be
  // owner-only — otherwise other UIDs can enumerate filenames + mtimes even
  // when each backup file is 0600. Translate file-mode to dir-mode by
  // setting execute bits wherever read bits exist.
  const dirMode = typeof mode === 'number' ? modeToDirMode(mode) : undefined;
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true, mode: dirMode });
  }

  for (let i = MAX_BACKUPS; i >= 1; i--) {
    const current = join(backupDir, `${name}.${i}`);
    if (i === MAX_BACKUPS) {
      try {
        unlinkSync(current);
      } catch {
        /* May not exist */
      }
    } else {
      const next = join(backupDir, `${name}.${i + 1}`);
      try {
        if (existsSync(current)) renameSync(current, next);
      } catch {
        /* Ignore rename errors */
      }
    }
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const backupPath = join(backupDir, `${name}.1`);
    if (typeof mode === 'number') {
      writeFileSync(backupPath, content, { encoding: 'utf-8', mode });
    } else {
      writeFileSync(backupPath, content, 'utf-8');
    }
  } catch {
    /* Non-fatal */
  }
}

/**
 * Translate a file mode (e.g. 0o600) into the matching directory mode by
 * mirroring read bits into execute bits. 0o600 → 0o700, 0o644 → 0o755.
 *
 * Directories need execute (`x`) where files only need read (`r`) — that's
 * how POSIX gates `readdir`/`stat` of children. Without this, a 0600 file
 * in a 0644 directory is still listable by other users.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — security review S-03
 */
function modeToDirMode(mode: number): number {
  // owner: r→x at bit 8→6, group: r→x at bit 5→3, other: r→x at bit 2→0.
  let result = mode & 0o777;
  if (result & 0o400) result |= 0o100;
  if (result & 0o040) result |= 0o010;
  if (result & 0o004) result |= 0o001;
  return result;
}

/**
 * Options for `writeJsonFileAtomic`.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — security review S-01/S-02
 */
export interface WriteJsonFileAtomicOptions {
  /** JSON indentation passed through to `JSON.stringify`. Defaults to `2`. */
  indent?: number;
  /**
   * Optional file mode for the temp + backup writes.
   *
   * When set, the temp file is created at this mode so the atomic rename
   * never exposes the live file at a looser mode (closes the TOCTOU
   * window between `rename(2)` and a follow-up `chmod`). The rotated
   * backup under `.backups/` is written at the same mode so historical
   * copies of secret data are equally locked down. The parent
   * `.backups/` directory is auto-created at the matching directory mode
   * (see {@link modeToDirMode}).
   *
   * REQUIRED for credential / secret storage. Omit for general data
   * files where 0644 is acceptable.
   */
  mode?: number;
}

/**
 * Write a JSON file atomically with backup rotation.
 *
 * Pattern: write temp -> backup original -> rename temp to target
 *
 * When `opts.mode` is provided, the temp file AND the rotated backup
 * are both created at that mode so there is no instant at which the
 * live file (or any historical copy) exists at a looser mode. This is
 * REQUIRED for secret-bearing files such as `llm-credentials.json`;
 * passing 0o600 closes CWE-276 (incorrect default permissions) and
 * CWE-367 (rename → chmod TOCTOU) together.
 *
 * Back-compat: callers that omit `opts` (or pass a number, for the old
 * `indent` positional form) get the legacy default-umask behavior so no
 * existing usage changes.
 *
 * @param filePath - Target file path.
 * @param data - Data to serialize as JSON.
 * @param optsOrIndent - Options object, or a number for legacy `indent`
 *   positional form.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — security review S-01/S-02
 */
export function writeJsonFileAtomic<T>(
  filePath: string,
  data: T,
  optsOrIndent: WriteJsonFileAtomicOptions | number = 2,
): void {
  const opts: WriteJsonFileAtomicOptions =
    typeof optsOrIndent === 'number' ? { indent: optsOrIndent } : optsOrIndent;
  const indent = opts.indent ?? 2;
  const mode = opts.mode;

  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);

  const content = JSON.stringify(data, null, indent) + '\n';

  if (typeof mode === 'number') {
    writeFileSync(tempPath, content, { encoding: 'utf-8', mode });
  } else {
    writeFileSync(tempPath, content, 'utf-8');
  }

  try {
    if (existsSync(filePath)) {
      rotateBackup(filePath, mode);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* Ignore cleanup errors */
    }
    throw error;
  }
}

/**
 * Read a JSON file, returning parsed content or null if not found.
 *
 * @param filePath - Path to the JSON file
 */
export function readJsonFile<T = unknown>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Get the path to a CLEO data file within a project root.
 *
 * @param projectRoot - Root directory of the project
 * @param filename - Filename within .cleo/ directory
 */
export function getDataPath(projectRoot: string, filename: string): string {
  return join(projectRoot, '.cleo', filename);
}

/**
 * Resolve the project root directory.
 * Checks CLEO_ROOT env, then falls back to cwd.
 */
export function resolveProjectRoot(): string {
  return process.env['CLEO_ROOT'] || process.cwd();
}

/**
 * Default lock options matching bash flock behavior
 */
const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 5,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 5000,
  },
  stale: 30000, // 30s stale lock timeout
};

/**
 * Lock ordering to prevent deadlocks.
 * Always acquire locks in this order.
 */
const LOCK_ORDER: Record<string, number> = {
  'tasks.db': 1,
  'config.json': 2,
};

function getLockPriority(filePath: string): number {
  const name = basename(filePath);
  return LOCK_ORDER[name] ?? 99;
}

/**
 * Options for `withLock`.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — security review S-01/S-02/S-03
 */
export interface WithLockOptions {
  /**
   * Optional file mode propagated through to the atomic write AND used for
   * the proper-lockfile sentinel empty-file create. The parent directory is
   * created at the matching directory mode (see {@link modeToDirMode}) so a
   * 0600 file is not enumerable through a 0755 parent dir.
   *
   * REQUIRED for credential / secret storage paths.
   */
  mode?: number;
}

/**
 * Read and write a JSON file with exclusive locking.
 *
 * Acquires a cross-process lock, reads current state, applies the
 * transform function, validates, and writes back atomically.
 *
 * When `opts.mode` is provided, every filesystem mutation in this path
 * (parent dir create, sentinel empty file, atomic write, rotated backup)
 * is constrained to the requested mode so secret-bearing data never
 * touches the disk at a looser permission.
 *
 * @param filePath - File to lock and modify.
 * @param transform - Function that receives current data and returns new data.
 * @param opts - Optional mode override for secret-bearing writes.
 * @returns The transformed data.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — security review S-01/S-02/S-03
 */
export async function withLock<T>(
  filePath: string,
  transform: (current: T | null) => T,
  opts: WithLockOptions = {},
): Promise<T> {
  const dir = dirname(filePath);
  const dirMode = typeof opts.mode === 'number' ? modeToDirMode(opts.mode) : undefined;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: dirMode });
  }

  // Ensure file exists for locking (proper-lockfile needs the file to exist).
  // For secret writes, create the sentinel at the requested mode so even the
  // empty placeholder cannot be opened by other UIDs.
  if (!existsSync(filePath)) {
    if (typeof opts.mode === 'number') {
      writeFileSync(filePath, '', { encoding: 'utf-8', mode: opts.mode });
    } else {
      writeFileSync(filePath, '', 'utf-8');
    }
  }

  let release: (() => Promise<void>) | undefined;

  try {
    release = await lockfile.lock(filePath, LOCK_OPTIONS);

    const current = readJsonFile<T>(filePath);
    const updated = transform(current);
    writeJsonFileAtomic(filePath, updated, { mode: opts.mode });
    return updated;
  } finally {
    if (release) {
      await release();
    }
  }
}

/**
 * Acquire a file lock and execute an operation.
 * Unlike withLock, this doesn't read/write the file - caller manages I/O.
 * The return type R is independent of the file content type.
 */
export async function withFileLock<R>(
  filePath: string,
  operation: () => R | Promise<R>,
): Promise<R> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (!existsSync(filePath)) {
    writeFileSync(filePath, '', 'utf-8');
  }

  let release: (() => Promise<void>) | undefined;

  try {
    release = await lockfile.lock(filePath, LOCK_OPTIONS);
    return await operation();
  } finally {
    if (release) {
      await release();
    }
  }
}

/**
 * Acquire locks on multiple files in correct order.
 * Used for operations that need to modify multiple files atomically
 * (e.g., coordinated updates across task data and config).
 *
 * @param filePaths - Files to lock
 * @param operation - Function to execute while locks are held
 */
export async function withMultiLock<T>(
  filePaths: string[],
  operation: () => T | Promise<T>,
): Promise<T> {
  // Sort by lock priority to prevent deadlocks
  const sorted = [...filePaths].sort((a, b) => getLockPriority(a) - getLockPriority(b));

  const releases: Array<() => Promise<void>> = [];

  try {
    // Acquire locks in order
    for (const fp of sorted) {
      if (!existsSync(dirname(fp))) {
        mkdirSync(dirname(fp), { recursive: true });
      }
      if (!existsSync(fp)) {
        writeFileSync(fp, '', 'utf-8');
      }
      const release = await lockfile.lock(fp, LOCK_OPTIONS);
      releases.push(release);
    }

    return await operation();
  } finally {
    // Release in reverse order
    for (const release of releases.reverse()) {
      try {
        await release();
      } catch {
        // Ignore release errors
      }
    }
  }
}

/**
 * Check if a CLEO project directory exists at the given path
 */
export function isProjectInitialized(projectRoot: string): boolean {
  const cleoDir = join(projectRoot, '.cleo');
  return existsSync(cleoDir) && existsSync(join(cleoDir, 'tasks.db'));
}

/**
 * List backup files for a given data file
 */
export function listBackups(filePath: string): string[] {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const backupDir = join(dir, '.backups');

  if (!existsSync(backupDir)) {
    return [];
  }

  try {
    return readdirSync(backupDir)
      .filter((f) => f.startsWith(`${name}.`) && /\.\d+$/.test(f))
      .sort((a, b) => {
        const numA = parseInt(a.split('.').pop()!, 10);
        const numB = parseInt(b.split('.').pop()!, 10);
        return numA - numB;
      })
      .map((f) => join(backupDir, f));
  } catch {
    return [];
  }
}
