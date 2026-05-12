/**
 * Canonical project identity computation (T9149 — W5 N1 Epsilon-unique insight).
 *
 * Addresses the 80,969-row pollution from cross-provider mount-path divergence
 * (e.g. /mnt/projects/cleocode vs /workspace/cleocode both hashing to different
 * base64url(path) IDs for the same repo).
 *
 * `canonicalProjectId` anchors identity to git-root + realpath so container
 * bind-mounts, CI clones, and developer laptops all produce the same ID.
 *
 * @task T9149
 * @module nexus/identity
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Components that make up the canonical project fingerprint. */
export interface ProjectIdentityComponents {
  /** Absolute realpath of the git root (resolves symlinks). */
  readonly gitRoot: string;
  /** Project name from project-info.json (if present). */
  readonly projectName?: string;
  /** First git remote URL (origin fetch URL, if present). */
  readonly remoteUrl?: string;
}

/** Result of canonical ID computation. */
export interface CanonicalProjectIdResult {
  /** The 12-hex-char canonical project ID. */
  readonly id: string;
  /** The components used to compute the ID. */
  readonly components: ProjectIdentityComponents;
  /**
   * Legacy base64url(path) IDs that should be aliased to this canonical ID.
   * Populated when the caller supplies known legacy IDs for migration.
   */
  readonly legacyAliases?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Git root detection
// ---------------------------------------------------------------------------

/**
 * Find the git root for a given directory using `git rev-parse --show-toplevel`.
 *
 * Returns `null` if the directory is not inside a git repo (non-fatal: allows
 * use outside git repos).
 */
export async function findGitRoot(fromPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolve(fromPath),
    });
    return resolve(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Find the primary git remote URL (origin fetch URL).
 *
 * Returns `null` when there are no remotes or git is unavailable.
 */
export async function findGitRemoteUrl(fromPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: resolve(fromPath),
    });
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project-info.json name
// ---------------------------------------------------------------------------

/**
 * Read the project name from `.cleo/project-info.json` (if present).
 * Non-fatal on any I/O or parse error.
 */
async function readProjectInfoName(repoRoot: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repoRoot, '.cleo', 'project-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    return name || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Canonical ID computation
// ---------------------------------------------------------------------------

/**
 * Compute the canonical project ID for a given repository path.
 *
 * Algorithm:
 *   1. Resolve `repoPath` to its `realpath` (resolves symlinks, normalises mounts).
 *   2. Detect the git root via `git rev-parse --show-toplevel` (falls back to realpath).
 *   3. Read `.cleo/project-info.json` name (optional).
 *   4. Read `git remote get-url origin` (optional).
 *   5. SHA-256 of `<gitRoot>|<projectName>|<remoteUrl>`, first 12 hex chars.
 *
 * This ensures `/mnt/projects/cleocode` and `/workspace/cleocode` (same git root,
 * same remote) produce the same ID — resolving the 80,969-row pollution vector.
 *
 * @param repoPath - Absolute path to the project root (may be a symlink or bind-mount).
 * @returns The canonical project ID result with components and hash.
 *
 * @task T9149
 */
export async function canonicalProjectId(repoPath: string): Promise<CanonicalProjectIdResult> {
  const realRepoPath = resolve(repoPath);

  const [gitRoot, remoteUrl, projectName] = await Promise.all([
    findGitRoot(realRepoPath),
    findGitRemoteUrl(realRepoPath),
    (async () => {
      const gr = await findGitRoot(realRepoPath);
      return gr ? readProjectInfoName(gr) : readProjectInfoName(realRepoPath);
    })(),
  ]);

  const effectiveRoot = gitRoot ?? realRepoPath;

  const fingerprint = [effectiveRoot, projectName ?? '', remoteUrl ?? ''].join('|');

  const id = createHash('sha256').update(fingerprint).digest('hex').substring(0, 12);

  return {
    id,
    components: {
      gitRoot: effectiveRoot,
      ...(projectName !== undefined && { projectName }),
      ...(remoteUrl != null && { remoteUrl }),
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy alias migration
// ---------------------------------------------------------------------------

/**
 * Compute the legacy base64url(path) ID for a given path.
 *
 * This is the old algorithm used before W5: `Buffer.from(path).toString('base64url').slice(0, 32)`.
 * Used to populate `projectIdAliases` when migrating existing registrations.
 */
export function legacyProjectId(repoPath: string): string {
  return Buffer.from(repoPath).toString('base64url').slice(0, 32);
}

/**
 * Build the set of legacy IDs that should be aliased to the canonical ID.
 *
 * Includes the direct path legacy ID and any additional known paths (e.g.
 * from container mount variants).
 */
export function computeLegacyAliases(repoPath: string, additionalPaths?: string[]): string[] {
  const aliases = new Set<string>();
  aliases.add(legacyProjectId(resolve(repoPath)));
  for (const p of additionalPaths ?? []) {
    aliases.add(legacyProjectId(resolve(p)));
  }
  return [...aliases];
}
