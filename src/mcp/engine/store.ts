/**
 * JSON File Store
 *
 * Handles reading and writing CLEO JSON files with:
 * - Atomic writes (temp file -> validate -> backup -> rename)
 * - Cross-process file locking (proper-lockfile)
 * - Numbered backup rotation matching Tier 1 bash behavior
 * - Lock ordering to prevent deadlocks (todo.json before archive)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync} from 'fs';
import { join, dirname, basename } from 'path';
import { randomBytes } from 'crypto';
import * as lockfile from 'proper-lockfile';

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
 * Maximum number of operational backups to keep (Tier 1)
 */
const MAX_BACKUPS = 10;

/**
 * Lock ordering to prevent deadlocks.
 * Always acquire locks in this order.
 */
const LOCK_ORDER: Record<string, number> = {
  'todo.json': 1,
  'sessions.json': 2,
  'todo-archive.json': 3,
  'todo-log.json': 4,
  'config.json': 5,
};

function getLockPriority(filePath: string): number {
  const name = basename(filePath);
  return LOCK_ORDER[name] ?? 99;
}

/**
 * Read a JSON file, returning parsed content or null if not found
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
 * Read log entries from a hybrid JSON/JSONL file (synchronous).
 * Handles legacy JSON `{ "entries": [...] }`, pure JSONL, and
 * hybrid format (JSON object followed by JSONL lines).
 * @task T4622
 */
export function readLogFileEntries(filePath: string): Record<string, unknown>[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8').trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!content) return [];

  // Fast path: try as single JSON
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return parsed.entries;
    }
    return [parsed];
  } catch {
    // Hybrid format
  }

  const entries: Record<string, unknown>[] = [];

  if (content.startsWith('{')) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let jsonEnd = -1;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i]!;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
    }
    if (jsonEnd > 0) {
      try {
        const initial = JSON.parse(content.substring(0, jsonEnd));
        if (initial && Array.isArray(initial.entries)) entries.push(...initial.entries);
      } catch { /* skip corrupted initial JSON */ }
      const remainder = content.substring(jsonEnd).trim();
      if (remainder) {
        for (const line of remainder.split('\n')) {
          const l = line.trim();
          if (!l || !l.startsWith('{')) continue;
          try { entries.push(JSON.parse(l)); } catch { /* skip */ }
        }
      }
    }
  } else {
    for (const line of content.split('\n')) {
      const l = line.trim();
      if (!l || !l.startsWith('{')) continue;
      try { entries.push(JSON.parse(l)); } catch { /* skip */ }
    }
  }

  return entries;
}

/**
 * Write a JSON file atomically with backup rotation.
 *
 * Pattern: write temp -> backup original -> rename temp to target
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON
 * @param indent - JSON indentation (default: 2 spaces)
 */
export function writeJsonFileAtomic<T>(
  filePath: string,
  data: T,
  indent: number = 2
): void {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);

  // Serialize
  const content = JSON.stringify(data, null, indent) + '\n';

  // Write to temp file
  writeFileSync(tempPath, content, 'utf-8');

  try {
    // Create backup of existing file (Tier 1 operational backup)
    if (existsSync(filePath)) {
      rotateBackup(filePath);
    }

    // Atomic rename
    renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Read and write a JSON file with exclusive locking.
 *
 * Acquires a cross-process lock, reads current state, applies the
 * transform function, validates, and writes back atomically.
 *
 * @param filePath - File to lock and modify
 * @param transform - Function that receives current data and returns new data
 * @returns The transformed data
 */
export async function withLock<T>(
  filePath: string,
  transform: (current: T | null) => T
): Promise<T> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Ensure file exists for locking (proper-lockfile needs the file to exist)
  if (!existsSync(filePath)) {
    writeFileSync(filePath, '', 'utf-8');
  }

  let release: (() => Promise<void>) | undefined;

  try {
    release = await lockfile.lock(filePath, LOCK_OPTIONS);

    const current = readJsonFile<T>(filePath);
    const updated = transform(current);
    writeJsonFileAtomic(filePath, updated);
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
  operation: () => R | Promise<R>
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
 * (e.g., moving a task from todo.json to archive).
 *
 * @param filePaths - Files to lock
 * @param operation - Function to execute while locks are held
 */
export async function withMultiLock<T>(
  filePaths: string[],
  operation: () => T | Promise<T>
): Promise<T> {
  // Sort by lock priority to prevent deadlocks
  const sorted = [...filePaths].sort(
    (a, b) => getLockPriority(a) - getLockPriority(b)
  );

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
 * Create a numbered backup of a file (Tier 1 operational backup).
 *
 * Maintains up to MAX_BACKUPS copies:
 *   .backups/todo.json.1 (newest)
 *   .backups/todo.json.2
 *   ...
 *   .backups/todo.json.10 (oldest, deleted when new backup arrives)
 */
function rotateBackup(filePath: string): void {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const backupDir = join(dir, '.backups');

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  // Rotate existing backups (shift numbers up)
  for (let i = MAX_BACKUPS; i >= 1; i--) {
    const current = join(backupDir, `${name}.${i}`);
    if (i === MAX_BACKUPS) {
      // Delete oldest
      try {
        unlinkSync(current);
      } catch {
        // May not exist
      }
    } else {
      // Shift to next number
      const next = join(backupDir, `${name}.${i + 1}`);
      try {
        if (existsSync(current)) {
          renameSync(current, next);
        }
      } catch {
        // Ignore rename errors
      }
    }
  }

  // Copy current file to .1
  try {
    const content = readFileSync(filePath, 'utf-8');
    writeFileSync(join(backupDir, `${name}.1`), content, 'utf-8');
  } catch {
    // Non-fatal - backup failure shouldn't block write
  }
}

/**
 * Check if a CLEO project directory exists at the given path
 */
export function isProjectInitialized(projectRoot: string): boolean {
  const cleoDir = join(projectRoot, '.cleo');
  return existsSync(cleoDir) && existsSync(join(cleoDir, 'todo.json'));
}

/**
 * Resolve the project root directory.
 * Checks CLEO_ROOT env, then falls back to cwd.
 */
export function resolveProjectRoot(): string {
  return process.env.CLEO_ROOT || process.cwd();
}

/**
 * Get the path to a CLEO data file
 */
export function getDataPath(projectRoot: string, filename: string): string {
  return join(projectRoot, '.cleo', filename);
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
