/**
 * @cleocode/git-shim — Harness-agnostic git fence (T1118 + T1591 + T1761).
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
 * @packageDocumentation
 */

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
export { findDeniedOp, GIT_OP_DENYLIST, RESTRICTED_ROLES } from './denylist.js';
export {
  evaluateIsolationBoundary,
  isCwdInsideWorktree,
  MUTATION_SUBCOMMANDS,
} from './isolation-boundary.js';
export {
  extractTaskIdFromWorktreePath,
  isInsideWorktreesRoot,
  isPathInsideWorktree,
  resolveActiveWorktree,
  resolveCleoWorktreesRoot,
  resolveProjectWorktreeRoot,
} from './worktree-path.js';

/**
 * Install the shim symlink so that `git` resolves to this shim when
 * the shim directory is on PATH.
 *
 * Creates `<shimDir>/git` as a symlink pointing at the shim binary.
 * The shim binary itself is the `dist/shim.js` file emitted by tsc.
 *
 * @param shimDir - Directory to place the `git` symlink in.
 * @param shimBinPath - Absolute path to the compiled shim binary (dist/shim.js).
 * @returns Whether the symlink was created or already existed.
 * @task T1118
 * @task T1121
 */
export async function installShimSymlink(shimDir: string, shimBinPath: string): Promise<boolean> {
  const { existsSync, mkdirSync, symlinkSync, unlinkSync } = await import('node:fs');
  const { join } = await import('node:path');

  mkdirSync(shimDir, { recursive: true });
  const linkPath = join(shimDir, 'git');

  // Remove stale symlink if it points somewhere wrong.
  if (existsSync(linkPath)) {
    try {
      const { readlinkSync } = await import('node:fs');
      const target = readlinkSync(linkPath);
      if (target === shimBinPath) return true; // already correct
      unlinkSync(linkPath);
    } catch {
      try {
        unlinkSync(linkPath);
      } catch {
        // ignore
      }
    }
  }

  try {
    symlinkSync(shimBinPath, linkPath);
    // Ensure the shim binary is executable.
    const { chmodSync } = await import('node:fs');
    chmodSync(shimBinPath, 0o755);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install git shim symlink at ${linkPath}: ${message}`);
  }
}
