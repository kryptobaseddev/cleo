/**
 * @cleocode/git-shim — Harness-agnostic git fence (T1118 + T1591 + T1761 + T1852).
 *
 * Re-exports the denylist + boundary predicates so other packages can inspect
 * the shim's enforcement without executing the binary. The shim binary itself
 * lives at `dist/shim.js` and is registered as the `git` bin entry in
 * package.json.
 *
 * @task T1118
 * @task T1121
 * @task T1591
 * @task T1761
 * @task T1852
 * @packageDocumentation
 */

import { fileURLToPath } from 'node:url';

export type { AuditOutcome, AuditRecord } from './audit-log.js';
export { resolveAuditLogPath, writeAuditRecord } from './audit-log.js';
export type { BoundaryViolation } from './boundary.js';
export {
  commitHasInlineMessage,
  extractCommitMessages,
  validateAddPaths,
  validateCherryPickSource,
  validateCommitSubject,
  validateMergeAllowed,
} from './boundary.js';
export {
  findDeniedOp,
  GIT_OP_DENYLIST,
  PROTECTED_PUSH_BRANCHES,
  porcelainDestinations,
  protectedPorcelainDestinations,
  protectedPushRefspec,
  RESTRICTED_ROLES,
  splitGitArgv,
} from './denylist.js';
export {
  enforceAbsolutePathBoundary,
  evaluateIsolationBoundary,
  isCwdInsideWorktree,
  MUTATION_SUBCOMMANDS,
} from './isolation-boundary.js';
export { type GitShimLauncherOptions, installGitShimLaunchers } from './launcher.js';
export {
  extractTaskIdFromWorktreePath,
  isInsideWorktreesRoot,
  isPathInsideWorktree,
  resolveActiveWorktree,
  resolveCleoWorktreesRoot,
  resolveProjectWorktreeRoot,
} from './worktree-path.js';

/**
 * Install the shim launcher so that `git` resolves to this shim when
 * the shim directory is on PATH.
 *
 * POSIX: `<shimDir>/git` is a symlink to the shim binary. Windows: `git.cmd`
 * plus an extensionless sh launcher, since PATHEXT ignores extensionless
 * files and file symlinks need privileges (T12605). See
 * {@link installGitShimLaunchers}.
 *
 * @param shimDir - Directory to place the `git` launcher in.
 * @param shimBinPath - Absolute path to the compiled shim binary (dist/shim.js).
 * @returns `true` once the launcher is in place.
 * @throws When the launcher cannot be installed.
 * @task T1118
 * @task T1121
 */
export async function installShimSymlink(shimDir: string, shimBinPath: string): Promise<boolean> {
  const { installGitShimLaunchers } = await import('./launcher.js');
  try {
    installGitShimLaunchers(shimDir, shimBinPath);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install git shim launcher in ${shimDir}: ${message}`);
  }
}

/**
 * Absolute path of this package's shim entry point (`dist/shim.js`), resolved
 * from wherever the package is installed, so a globally installed CLI finds
 * its own shim rather than looking in the project's node_modules (T13522).
 *
 * @returns The path, whether or not the file exists (callers check).
 * @task T13522
 */
export function resolveShimBinPath(): string {
  return fileURLToPath(new URL('./shim.js', import.meta.url));
}
