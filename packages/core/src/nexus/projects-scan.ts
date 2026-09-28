/**
 * NEXUS filesystem project scanner.
 *
 * Walks filesystem roots looking for directories that contain a `.cleo/`
 * subdirectory, cross-references them against the nexus registry, and
 * optionally auto-registers unregistered projects.
 *
 * @task T1473
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { listRegistryParentRoots } from './registry-roots.js';

/** Auto-register error record. */
export interface ScanAutoRegisterError {
  /** Project path that failed to register. */
  path: string;
  /** Error message. */
  error: string;
}

/** Options for {@link scanForProjects}. */
export interface ProjectsScanOptions {
  /**
   * Comma-separated string or array of search roots. Default: the parent
   * directories of live registered projects ({@link listRegistryParentRoots});
   * `~/code` and `~/projects` only when the registry yields none (T12476).
   */
  roots?: string | string[];
  /** Maximum directory traversal depth (default: 4, max: 20). */
  maxDepth?: number;
  /** When true, register all discovered unregistered projects. */
  autoRegister?: boolean;
  /** When true, also report already-registered projects. */
  includeExisting?: boolean;
}

/** Result envelope for {@link scanForProjects}. */
export interface ProjectsScanResult {
  /** Search roots actually walked. */
  roots: string[];
  /** Unregistered project paths found. */
  unregistered: string[];
  /** Already-registered project paths (only populated when includeExisting). */
  registered: string[];
  /** Summary counts. */
  tally: { total: number; unregistered: number; registered: number };
  /** Paths auto-registered (only when autoRegister). */
  autoRegistered: string[];
  /** Auto-register errors (only when autoRegister). */
  autoRegisterErrors: ScanAutoRegisterError[];
}

/**
 * Directories to skip during filesystem walk.
 * Keeps the walker fast and avoids descending into build artefacts.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.svelte-kit',
  '.next',
  '.cache',
  'coverage',
  '.turbo',
  '.nx',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'vendor',
  // T12471: never scan the trash or package caches for projects.
  '.Trash',
  '.Trashes',
  '$RECYCLE.BIN',
  '.npm',
  '.pnpm-store',
]);

/**
 * Directories skipped only directly under the home directory (T12471): OS and
 * app state (`~/Library`, `~/.local`, which also hold CLEO's own worktree
 * homes). Anywhere else a directory of that name is an ordinary one, so a
 * project under `code/Library/core` is still found.
 */
const HOME_SKIP_DIRS = new Set(['Library', '.local']);

/** Whether `name` inside `dir` is skipped by the project walkers. */
function isSkippedDir(dir: string, name: string): boolean {
  return (
    SKIP_DIRS.has(name) ||
    (HOME_SKIP_DIRS.has(name) && path.resolve(dir) === path.resolve(homedir()))
  );
}

/**
 * Return the device number for a path, or -1 on error.
 * Used to detect filesystem boundary crossings.
 *
 * @param p - Absolute path to stat.
 * @returns Device number or -1.
 */
export function getDevice(p: string): number {
  try {
    return statSync(p).dev;
  } catch {
    return -1;
  }
}

/**
 * Walk a directory tree looking for directories named `.cleo/`.
 * Candidates are returned as absolute parent directory paths (the project root).
 *
 * Does NOT follow symlinks. Does NOT cross mount points (different `dev`).
 *
 * @param dir      - Absolute directory path to walk.
 * @param depth    - Current recursion depth (0 = root).
 * @param maxDepth - Maximum recursion depth.
 * @param rootDev  - Device number of the search root for boundary checks.
 * @returns Array of absolute project-root paths that contain a `.cleo/` dir.
 *
 * @example
 * const projects = walkForCleo('/home/user/code', 0, 4, getDevice('/home/user/code'));
 */
export function walkForCleo(
  dir: string,
  depth: number,
  maxDepth: number,
  rootDev: number,
): string[] {
  if (depth > maxDepth) return [];

  type DirentLike = {
    name: string;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  };

  let entries: DirentLike[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as DirentLike[];
  } catch {
    return [];
  }

  const found: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.name === '.cleo') {
      found.push(dir);
      continue;
    }

    if (isSkippedDir(dir, entry.name)) continue;

    const childDev = getDevice(fullPath);
    if (childDev !== rootDev && childDev !== -1) continue;

    const nested = walkForCleo(fullPath, depth + 1, maxDepth, rootDev);
    for (const n of nested) found.push(n);
  }

  return found;
}

/** Options for {@link walkForCleoBounded}. */
export interface BoundedWalkOptions {
  /** Maximum traversal depth below each root (0 = the root only). */
  maxDepth: number;
  /** Directories read at once. */
  concurrency: number;
  /** Per-directory read budget; a slower directory is reported, not waited on. */
  timeoutMs: number;
}

/** Result of {@link walkForCleoBounded}. */
export interface BoundedWalkResult {
  /** Absolute project roots (directories containing `.cleo/`), sorted. */
  found: string[];
  /** Directories whose read exceeded the budget. */
  timedOut: string[];
  /** Directories that could not be read for a reason other than absence. */
  unreadable: string[];
}

/**
 * Settle `promise`, or `'timeout'` after `ms`. The timer never keeps the
 * process alive. The underlying operation is not cancelled — its result is
 * simply not waited for.
 *
 * @param promise - Operation to wait for.
 * @param ms - Budget in milliseconds.
 * @returns The settled value, or `'timeout'`.
 *
 * @example
 * ```ts
 * const entries = await withinBudget(readdir(dir), 2000);
 * ```
 */
export async function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asynchronous {@link walkForCleo} for machine-wide scans (T12471): reads at
 * most `concurrency` directories at once and gives each read `timeoutMs`, so
 * one hung mount cannot stall a scan of hundreds of projects. Same rules as
 * the synchronous walker: no symlinks, no mount crossings, {@link SKIP_DIRS}
 * skipped. A timed-out or unreadable directory is reported, never treated as
 * empty proof of absence.
 *
 * @param roots - Absolute directories to walk.
 * @param opts - Depth, concurrency and per-directory budget.
 * @returns Project roots found, plus the directories that were not read.
 *
 * @example
 * ```ts
 * const { found } = await walkForCleoBounded(['/home/me/code'], { maxDepth: 2, concurrency: 16, timeoutMs: 2000 });
 * ```
 */
export async function walkForCleoBounded(
  roots: readonly string[],
  opts: BoundedWalkOptions,
): Promise<BoundedWalkResult> {
  const found = new Set<string>();
  const timedOut: string[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ dir: string; depth: number; rootDev: number }> = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    queue.push({ dir: resolved, depth: 0, rootDev: getDevice(resolved) });
  }

  const visit = async (item: { dir: string; depth: number; rootDev: number }): Promise<void> => {
    const entries = await withinBudget(
      readdir(item.dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error),
      opts.timeoutMs,
    );
    if (entries === 'timeout') {
      timedOut.push(item.dir);
      return;
    }
    if (entries instanceof Error) {
      if (entries.code !== 'ENOENT' && entries.code !== 'ENOTDIR') unreadable.push(item.dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.cleo') {
        found.add(item.dir);
        continue;
      }
      if (isSkippedDir(item.dir, entry.name) || item.depth >= opts.maxDepth) continue;
      const child = path.join(item.dir, entry.name);
      if (seen.has(child)) continue;
      const childStat = await withinBudget(
        stat(child).catch(() => null),
        opts.timeoutMs,
      );
      if (childStat === 'timeout') {
        timedOut.push(child);
        continue;
      }
      if (childStat === null || (item.rootDev !== -1 && childStat.dev !== item.rootDev)) continue;
      seen.add(child);
      queue.push({ dir: child, depth: item.depth + 1, rootDev: item.rootDev });
    }
  };

  // Lanes pull from the shared queue until it is empty and no lane can refill it.
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < Math.max(1, opts.concurrency) && queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        active++;
        void visit(next).finally(() => {
          active--;
          pump();
        });
      }
    };
    pump();
  });

  return { found: [...found].sort(), timedOut: timedOut.sort(), unreadable: unreadable.sort() };
}

/**
 * Walk filesystem roots to discover CLEO project directories.
 *
 * Searches for directories containing a `.cleo/` subdirectory, cross-references
 * them against the nexus registry, and optionally auto-registers the unregistered
 * ones.
 *
 * @param opts - Scan options.
 * @returns Scan result with discovered, registered, and auto-registered paths.
 *
 * @example
 * const result = await scanForProjects({ maxDepth: 3, autoRegister: false });
 * console.log(result.unregistered);
 */
export async function scanForProjects(opts: ProjectsScanOptions = {}): Promise<ProjectsScanResult> {
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 4, 20));

  const { homedir } = await import('node:os');
  const home = homedir();
  // Accept either a comma-separated string or an array of roots
  let parsedRoots: string[];
  if (opts.roots == null) {
    // T12476: derive from where this device's registered projects actually
    // live. A hardcoded root is one past device's layout and, after a move,
    // names a directory that does not exist.
    const registryRoots = await listRegistryParentRoots();
    parsedRoots =
      registryRoots.length > 0
        ? registryRoots
        : [path.join(home, 'code'), path.join(home, 'projects')];
  } else if (typeof opts.roots === 'string') {
    parsedRoots = opts.roots
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .map((r) => (r.startsWith('~') ? path.join(home, r.slice(1)) : path.resolve(r)));
  } else {
    parsedRoots = opts.roots;
  }

  const rawRoots = parsedRoots;
  const roots = rawRoots.filter((r) => {
    try {
      return existsSync(r) && statSync(r).isDirectory();
    } catch {
      return false;
    }
  });

  const allCandidates: string[] = [];
  for (const root of roots) {
    const rootDev = getDevice(root);
    const found = walkForCleo(root, 0, maxDepth, rootDev);
    for (const f of found) allCandidates.push(f);
  }

  const candidates = [...new Set(allCandidates)];

  let registeredPaths = new Set<string>();
  try {
    const { nexusList: listProjects } = await import('@cleocode/core/internal' as string);
    const projectsList = await listProjects();
    for (const p of projectsList) {
      registeredPaths.add(path.resolve((p as { path: string }).path));
    }
  } catch {
    registeredPaths = new Set();
  }

  const unregistered: string[] = [];
  const registered: string[] = [];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (registeredPaths.has(resolved)) {
      registered.push(resolved);
    } else {
      unregistered.push(resolved);
    }
  }

  const tally = {
    total: candidates.length,
    unregistered: unregistered.length,
    registered: registered.length,
  };

  const autoRegistered: string[] = [];
  const autoRegisterErrors: ScanAutoRegisterError[] = [];

  if (opts.autoRegister && unregistered.length > 0) {
    const { nexusRegister: doRegister } = await import('@cleocode/core/internal' as string);
    for (const projectPath of unregistered) {
      try {
        await (doRegister as (p: string) => Promise<string>)(projectPath);
        autoRegistered.push(projectPath);
      } catch (err) {
        autoRegisterErrors.push({
          path: projectPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    roots,
    unregistered,
    registered: opts.includeExisting ? registered : [],
    tally,
    autoRegistered,
    autoRegisterErrors,
  };
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsScan(opts: {
  roots?: string;
  maxDepth?: number;
  autoRegister?: boolean;
  includeExisting?: boolean;
}): Promise<EngineResult<ProjectsScanResult>> {
  try {
    const result = await scanForProjects(opts);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
