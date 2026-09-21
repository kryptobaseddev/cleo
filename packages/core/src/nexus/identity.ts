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
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import { legacyProjectId } from '@cleocode/paths';

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
 * @param fromPath - Explicit directory for Git discovery.
 * @param execution - Optional original lifetime; cancellation/deadline are never absent-Git fallback.
 * @returns Git root or null when Git is unavailable.
 * @remarks An execution context bounds and cancels the actual child; omitted context
 * retains the legacy unbounded lifetime. Synchronous scheduling is not preempted.
 * @example
 * ```ts
 * const root = await findGitRoot(projectRoot, execution);
 * ```
 */
export async function findGitRoot(
  fromPath: string,
  execution?: OperationExecutionContext,
): Promise<string | null> {
  execution?.assertActive();
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolve(fromPath),
      signal: execution?.signal,
      timeout: execution ? Math.max(1, execution.remainingMs()) : undefined,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    execution?.assertActive();
    return resolve(stdout.trim());
  } catch {
    execution?.assertActive();
    return null;
  }
}

/**
 * Find the primary git remote URL (origin fetch URL).
 *
 * Returns `null` when there are no remotes or git is unavailable.
 * @param fromPath - Explicit directory for remote lookup.
 * @param execution - Optional original lifetime, shared with preceding discovery stages.
 * @returns Remote URL, or null for an unavailable Git remote.
 * @remarks Context cancellation and deadline failures propagate instead of producing
 * a fallback fingerprint. Actual children receive the same signal and remaining timeout.
 * @example
 * ```ts
 * const remote = await findGitRemoteUrl(projectRoot, execution);
 * ```
 */
export async function findGitRemoteUrl(
  fromPath: string,
  execution?: OperationExecutionContext,
): Promise<string | null> {
  execution?.assertActive();
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: resolve(fromPath),
      signal: execution?.signal,
      timeout: execution ? Math.max(1, execution.remainingMs()) : undefined,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    execution?.assertActive();
    const url = stdout.trim();
    return url || null;
  } catch {
    execution?.assertActive();
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
async function readProjectInfoName(
  repoRoot: string,
  execution?: OperationExecutionContext,
): Promise<string | undefined> {
  execution?.assertActive();
  try {
    const raw = await readFile(join(repoRoot, '.cleo', 'project-info.json'), {
      encoding: 'utf8',
      signal: execution?.signal,
    });
    execution?.assertActive();
    const parsed = JSON.parse(raw) as { name?: unknown };
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    return name || undefined;
  } catch {
    execution?.assertActive();
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
 * @param execution - Optional captured caller lifetime, never renewed between stages.
 * @remarks All started Git children settle before this operation finishes. Context
 * cancellation/deadline failures cannot establish fallback identity or authority.
 * @example
 * ```ts
 * const identity = await canonicalProjectId(projectRoot, execution);
 * ```
 * @returns The canonical project ID result with components and hash.
 *
 * @task T9149
 */
export async function canonicalProjectId(
  repoPath: string,
  execution?: OperationExecutionContext,
): Promise<CanonicalProjectIdResult> {
  execution?.assertActive();
  const realRepoPath = resolve(repoPath);
  // Await every owned child even when a sibling fails, so completion does not
  // abandon another Git process. Both children use the same original deadline.
  const results = await Promise.allSettled([
    findGitRoot(realRepoPath, execution),
    findGitRemoteUrl(realRepoPath, execution),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const gitRoot = results[0].status === 'fulfilled' ? results[0].value : null;
  const remoteUrl = results[1].status === 'fulfilled' ? results[1].value : null;
  const projectName = await readProjectInfoName(gitRoot ?? realRepoPath, execution);
  execution?.assertActive();

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
 * Canonical source: `@cleocode/paths` (`packages/paths/src/cleo-paths.ts`).
 * Re-exported here for backward compatibility — all internal nexus consumers
 * should import from `@cleocode/paths` directly.
 *
 * This is the old algorithm used before W5: `Buffer.from(path).toString('base64url').slice(0, 32)`.
 * Used to populate `projectIdAliases` when migrating existing registrations.
 */
export { legacyProjectId } from '@cleocode/paths';

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
