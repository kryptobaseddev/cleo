/**
 * Path fingerprints of a project checkout (T9149, demoted by T12470).
 *
 * A project is identified ONLY by the id it declares — the tracked
 * `.cleo/project-id`, then `project-info.json` (ADR-094; see
 * `readDeclaredProjectIdentity` in `@cleocode/paths`). The values computed here
 * hash a checkout's LOCATION (git-root realpath + name + remote), so they
 * change when the project moves. They survive only as alias keys in
 * `nexus_project_id_aliases`, which keeps ids that older CLEO versions derived
 * from a path resolvable. Never return one as a project id and never key a
 * registry row by one. This supersedes the T9149 realpath-fingerprint identity.
 *
 * @task T9149
 * @task T12470
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

/** Result of path-fingerprint computation (an alias key, not an identity). */
export interface CanonicalProjectIdResult {
  /** The 12-hex-char path fingerprint — an alias key, never a project id. */
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
 * Compute the path fingerprint `sha256(gitRoot|name|remote)[0:12]` of a checkout.
 *
 * **Alias key only (T12470).** The value depends on where the checkout lives,
 * so it is recorded in `nexus_project_id_aliases` to keep path-derived ids
 * from older CLEO versions resolvable — it is never a project's identity.
 *
 * @param repoPath - Absolute path to the checkout (may be a symlink or bind-mount).
 * @param execution - Optional captured caller lifetime, never renewed between stages.
 * @remarks All started Git children settle before this operation finishes. Context
 * cancellation/deadline failures cannot establish a fallback fingerprint.
 * @example
 * ```ts
 * const { id: aliasKey } = await projectPathFingerprint(projectRoot, execution);
 * ```
 * @returns The fingerprint with the components it was computed from.
 *
 * @task T9149
 * @task T12470
 */
export async function projectPathFingerprint(
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

/**
 * Former name of {@link projectPathFingerprint}.
 *
 * @deprecated T12470 — the value is a path fingerprint (alias key), not a
 * project id. Read identity with `readDeclaredProjectIdentity` from
 * `@cleocode/paths`.
 */
export const canonicalProjectId: typeof projectPathFingerprint = projectPathFingerprint;

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
