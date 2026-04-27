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
import path from 'node:path';

/** Auto-register error record. */
export interface ScanAutoRegisterError {
  /** Project path that failed to register. */
  path: string;
  /** Error message. */
  error: string;
}

/** Options for {@link scanForProjects}. */
export interface ProjectsScanOptions {
  /** Comma-separated string or array of search roots (default: ~/code, ~/projects, /mnt/projects). */
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
]);

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

    if (SKIP_DIRS.has(entry.name)) continue;

    const childDev = getDevice(fullPath);
    if (childDev !== rootDev && childDev !== -1) continue;

    const nested = walkForCleo(fullPath, depth + 1, maxDepth, rootDev);
    for (const n of nested) found.push(n);
  }

  return found;
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
  const defaultRoots = [path.join(home, 'code'), path.join(home, 'projects'), '/mnt/projects'];

  // Accept either a comma-separated string or an array of roots
  let parsedRoots: string[];
  if (opts.roots == null) {
    parsedRoots = defaultRoots;
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
