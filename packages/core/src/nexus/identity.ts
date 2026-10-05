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
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import { legacyProjectId, readDeclaredProjectIdentity } from '@cleocode/paths';
import { CleoError } from '../errors.js';

const execFileAsync = promisify(execFile);

/**
 * Read the project's declared, portable identity without creating or migrating it.
 *
 * @param projectRoot - Checkout whose tracked identity (or legacy cache) is read.
 * @returns The declared id, independent of the checkout's current path.
 * @throws {CleoError} When identity is missing; a path fingerprint is never a fallback.
 */
export function requireNexusProjectId(projectRoot: string): string {
  const identity = readDeclaredProjectIdentity(projectRoot);
  if (identity) return identity.projectId;
  // @sync-invariant none:local-only a query requires local declared identity; this does not create or re-key a synced row
  throw new CleoError(
    ExitCode.CONFIG_ERROR,
    `Project at ${projectRoot} declares no identity; refusing to derive one from its path.`,
    { fix: 'Run cleo doctor project-identity, or cleo init for a new project.' },
  );
}

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

/**
 * Normalise a git remote URL so `git@host:o/r.git` and `https://host/o/r`
 * compare equal. Returns `null` for empty input.
 *
 * @param url - Raw `git remote get-url` output or a stored `remoteUrl`.
 * @returns A `host/owner/repo` style key, or `null`.
 *
 * @example
 * ```ts
 * normalizeRemoteUrl('git@github.com:o/r.git'); // 'github.com/o/r'
 * ```
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let key = url.trim();
  if (!key) return null;
  key = key.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  key = key.replace(/^[^@/]+@/, '');
  key = key.replace(/^([^/:]+):(?!\d+\/)/, '$1/');
  key = key.replace(/\/+$/, '').replace(/\.git$/i, '');
  return key.toLowerCase() || null;
}

/**
 * Git facts about a checkout, recorded on its location for DISPLAY (T12470).
 * Never proof: a clone shares both, a bare `git init` can add any remote, and
 * a root commit can be faked. Moves are proven by the checkout nonce
 * (`nexus/checkout-nonce.ts`) alone. `null` means unknown.
 */
export interface CheckoutEvidence {
  /** First (parentless) commit of the repository — the lexically smallest when several. */
  readonly gitRootCommit: string | null;
  /** Normalised `origin` URL ({@link normalizeRemoteUrl}). */
  readonly gitRemote: string | null;
}

/**
 * Collect {@link CheckoutEvidence} for a checkout. Never throws for an absent
 * repository, commit or remote — those fields are `null`.
 *
 * @param fromPath - Checkout root.
 * @param execution - Optional captured caller lifetime.
 * @returns The evidence.
 *
 * @example
 * ```ts
 * const { gitRootCommit, gitRemote } = await collectCheckoutEvidence(root);
 * ```
 */
export async function collectCheckoutEvidence(
  fromPath: string,
  execution?: OperationExecutionContext,
): Promise<CheckoutEvidence> {
  execution?.assertActive();
  const rootCommit = async (): Promise<string | null> => {
    try {
      // --no-replace-objects: `refs/replace` must not be able to fake it.
      const args = ['--no-replace-objects', 'rev-list', '--max-parents=0', 'HEAD'];
      const { stdout } = await execFileAsync('git', args, {
        cwd: resolve(fromPath),
        signal: execution?.signal,
        timeout: execution ? Math.max(1, execution.remainingMs()) : undefined,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024,
      });
      execution?.assertActive();
      const roots = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[0-9a-f]{40,64}$/.test(line))
        .sort();
      return roots[0] ?? null;
    } catch {
      execution?.assertActive();
      return null;
    }
  };
  const results = await Promise.allSettled([rootCommit(), findGitRemoteUrl(fromPath, execution)]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const commit = results[0].status === 'fulfilled' ? results[0].value : null;
  const remote = results[1].status === 'fulfilled' ? results[1].value : null;
  return { gitRootCommit: commit, gitRemote: normalizeRemoteUrl(remote) };
}

// ---------------------------------------------------------------------------
// Project-info.json name
// ---------------------------------------------------------------------------

/**
 * Read the project name from `.cleo/project-info.json` (if present).
 * Non-fatal on any I/O or parse error.
 *
 * Deliberately NOT the display name (`.cleo/project.json`, T12716): this value
 * feeds the path fingerprint, a legacy alias KEY that must keep matching the
 * keys older builds recorded. A rename never changes it.
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
