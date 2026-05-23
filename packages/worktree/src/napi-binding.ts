/**
 * ESM-friendly bridge to `@cleocode/worktree-napi` (a CommonJS native addon).
 *
 * The napi-rs loader at `crates/worktree-napi/index.cjs` exposes its surface as
 * `module.exports = nativeBinding` — Node.js's CJS-to-ESM interop cannot
 * statically detect named exports from a dynamic require(), so direct
 * `import { copyPathsParallel } from '@cleocode/worktree-napi'` throws
 * "does not provide an export named ..." at link time.
 *
 * This module wraps the native binding via `createRequire` so the import looks
 * like a regular dynamic require from a CJS context. All consumers in this
 * package import napi functions from THIS module, never directly from
 * `@cleocode/worktree-napi`.
 *
 * @task T9982
 */

import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

interface CopyOptsNapi {
  /** Overwrite existing entries at the destination. */
  force: boolean;
  /** When set, every destination must resolve inside this root. */
  rootGuard?: string;
  /** Reserved for future use — symlinks are always followed by copy_leaf. */
  includeSymlinks: boolean;
}

interface CopyResultNapi {
  copiedCount: number;
  skippedCount: number;
  failedPaths: string[];
  totalBytes: number;
}

interface DestroyOptsNapi {
  repoRoot: string;
  worktreePath: string;
  force: boolean;
}

interface DestroyResultNapi {
  removed: boolean;
  branchDeleted: boolean;
}

interface IncludePatternNapi {
  pattern: string;
  isNegation: boolean;
}

interface ListOptsNapi {
  repoRoot: string;
}

interface WorktreeInfoNapi {
  path: string;
  branch?: string;
  head: string;
  isLocked: boolean;
  isPrunable: boolean;
}

/**
 * Options for the napi `pruneWorktrees` binding (T10203).
 *
 * Mirrors `crates/worktree-napi`'s `PruneOpts` — see ADR-078 for the
 * worktrunk-core SDK boundary contract.
 */
interface PruneOptsNapi {
  /** Absolute path to the git repository whose worktrees we plan to prune. */
  repoRoot: string;
  /**
   * The integration target branch (e.g. `"main"`) the candidates are tested
   * against for "is this merged in?".
   */
  integrationTarget: string;
}

/**
 * Single prune candidate returned by the napi `pruneWorktrees` plan (T10203).
 */
interface PruneCandidateNapi {
  /** Branch name (`undefined` for detached HEAD worktrees). */
  branch?: string;
  /** Display label (branch name or `(detached <short>)`). */
  label: string;
  /** Worktree path (`undefined` for branch-only candidates). */
  path?: string;
  /** Candidate kind: `"current" | "worktree" | "branch_only"`. */
  kind: string;
  /** Human-readable integration reason. */
  reason: string;
}

/**
 * Read-only prune plan returned by the napi `pruneWorktrees` binding (T10203).
 */
interface PrunePlanNapi {
  /** The default branch this plan was computed against. */
  integrationTarget: string;
  /** Candidates eligible for removal, in deterministic discovery order. */
  candidates: PruneCandidateNapi[];
}

/**
 * Options for the napi `removeDir` binding (T10203).
 *
 * Recursively removes a directory tree using
 * `worktrunk_core::remove_dir::remove_dir_with_progress`. Best-effort —
 * read/unlink/rmdir errors are silently skipped on the SDK side.
 */
interface RemoveDirOptsNapi {
  /** Absolute path to the directory tree to remove. */
  path: string;
}

/**
 * Result of a napi `removeDir` call (T10203).
 */
interface RemoveDirResultNapi {
  /** Number of leaf files unlinked. */
  files: number;
  /** Total bytes unlinked. Capped at `u32::MAX` for napi compatibility. */
  bytes: number;
}

/**
 * Shape of the native module exported by `@cleocode/worktree-napi`.
 *
 * Mirrors the napi-rs `index.d.ts` but mapped into TS-friendly types that
 * this package owns (the `.d.ts` from the crate uses `Array<T>` and is
 * regenerated at every build, so we don't import from it directly).
 *
 * @internal
 */
interface WorktreeNapiModule {
  copyPathsParallel(
    srcDir: string,
    destDir: string,
    paths: string[],
    opts: CopyOptsNapi,
  ): CopyResultNapi;
  destroyWorktree(opts: DestroyOptsNapi): DestroyResultNapi;
  readWorktreeInclude(repoRoot: string): IncludePatternNapi[];
  applyInclude(
    patterns: IncludePatternNapi[],
    srcDir: string,
    destDir: string,
    opts: CopyOptsNapi,
  ): CopyResultNapi;
  listWorktrees(opts: ListOptsNapi): WorktreeInfoNapi[];
  pruneWorktrees(opts: PruneOptsNapi): PrunePlanNapi;
  removeDir(opts: RemoveDirOptsNapi): RemoveDirResultNapi;
}

/**
 * Lazy-loaded handle to the native binding. The first call to any exported
 * function triggers a `require()` of `@cleocode/worktree-napi`; subsequent
 * calls reuse the cached module. This keeps the load failure off the
 * import-time critical path so:
 *
 * - Compile-time consumers (tsc, biome) never touch the native module.
 * - CLI startup never crashes when the .node is missing on a partial
 *   install (the failure is deferred until an actual worktree op runs).
 *
 * @internal
 */
let nativeBinding: WorktreeNapiModule | null = null;
function getNative(): WorktreeNapiModule {
  if (nativeBinding === null) {
    nativeBinding = require_('@cleocode/worktree-napi') as WorktreeNapiModule;
  }
  return nativeBinding;
}

export const copyPathsParallel: WorktreeNapiModule['copyPathsParallel'] = (
  srcDir,
  destDir,
  paths,
  opts,
) => getNative().copyPathsParallel(srcDir, destDir, paths, opts);

export const destroyWorktree: WorktreeNapiModule['destroyWorktree'] = (opts) =>
  getNative().destroyWorktree(opts);

export const readWorktreeInclude: WorktreeNapiModule['readWorktreeInclude'] = (repoRoot) =>
  getNative().readWorktreeInclude(repoRoot);

export const applyInclude: WorktreeNapiModule['applyInclude'] = (patterns, srcDir, destDir, opts) =>
  getNative().applyInclude(patterns, srcDir, destDir, opts);

export const listWorktrees: WorktreeNapiModule['listWorktrees'] = (opts) =>
  getNative().listWorktrees(opts);

export const pruneWorktrees: WorktreeNapiModule['pruneWorktrees'] = (opts) =>
  getNative().pruneWorktrees(opts);

export const removeDir: WorktreeNapiModule['removeDir'] = (opts) => getNative().removeDir(opts);

export type {
  CopyOptsNapi,
  CopyResultNapi,
  DestroyOptsNapi,
  DestroyResultNapi,
  IncludePatternNapi,
  ListOptsNapi,
  PruneCandidateNapi,
  PruneOptsNapi,
  PrunePlanNapi,
  RemoveDirOptsNapi,
  RemoveDirResultNapi,
  WorktreeInfoNapi,
};
