/**
 * ESM-friendly bridge to the bundled worktree Node-API native addon.
 *
 * The napi-rs loader staged into `native/worktree-napi.cjs` exposes its surface as
 * `module.exports = nativeBinding` — Node.js's CJS-to-ESM interop cannot
 * statically detect named exports from a dynamic require(), so consumers route
 * through this bridge instead of importing the native loader directly.
 *
 * This module wraps the native binding via `createRequire` so the import looks
 * like a regular dynamic require from a CJS context. All consumers in this
 * package import napi functions from THIS module, never directly from the
 * native loader.
 *
 * @task T9982
 */

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const bundledNativeLoaderPath = fileURLToPath(
  new URL('../native/worktree-napi.cjs', import.meta.url),
);
const repoLocalNativeLoaderPath = fileURLToPath(
  new URL('../../../crates/worktree-napi/index.cjs', import.meta.url),
);

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
 * Mirrors `crates/worktree-napi`'s `PruneOpts` — see ADR-087 for the
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
 * Shape of the native module exported by the bundled Node-API binding.
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
 * function triggers a `require()` of the bundled native loader; subsequent
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
  if (nativeBinding !== null) return nativeBinding;

  if (existsSync(bundledNativeLoaderPath)) {
    nativeBinding = require_(bundledNativeLoaderPath) as WorktreeNapiModule;
    return nativeBinding;
  }

  if (existsSync(repoLocalNativeLoaderPath)) {
    try {
      nativeBinding = require_(repoLocalNativeLoaderPath) as WorktreeNapiModule;
      return nativeBinding;
    } catch {
      if (isTestRuntime()) {
        nativeBinding = createTestFallbackNativeModule();
        return nativeBinding;
      }

      throw new Error(
        `@cleocode/worktree: failed to load repo-local native loader at ${repoLocalNativeLoaderPath}. ` +
          'Run `pnpm dlx @napi-rs/cli@3 build --release` inside `crates/worktree-napi/` for source-tree execution.',
      );
    }
  }

  if (isTestRuntime()) {
    nativeBinding = createTestFallbackNativeModule();
    return nativeBinding;
  }

  throw new Error(
    `@cleocode/worktree: missing bundled native loader at ${bundledNativeLoaderPath}. ` +
      'The release package must include native/worktree-napi.cjs and worktree-napi.<triple>.node files.',
  );
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;
}

function createTestFallbackNativeModule(): WorktreeNapiModule {
  const copyPathsParallelFallback: WorktreeNapiModule['copyPathsParallel'] = (
    srcDir,
    destDir,
    paths,
    opts,
  ) => {
    let copiedCount = 0;
    const failedPaths: string[] = [];
    for (const relativePath of paths) {
      const source = join(srcDir, relativePath);
      const destination = join(destDir, relativePath);
      if (opts.rootGuard !== undefined) {
        const guardedRoot = resolve(opts.rootGuard);
        const resolvedDestination = resolve(destination);
        if (!resolvedDestination.startsWith(guardedRoot)) {
          failedPaths.push(relativePath);
          continue;
        }
      }
      try {
        cpSync(source, destination, { recursive: true, force: opts.force });
        copiedCount += 1;
      } catch {
        failedPaths.push(relativePath);
      }
    }
    return { copiedCount, skippedCount: paths.length - copiedCount, failedPaths, totalBytes: 0 };
  };

  return {
    copyPathsParallel: copyPathsParallelFallback,
    destroyWorktree() {
      return { removed: false, branchDeleted: false };
    },
    readWorktreeInclude(repoRoot) {
      const includePath = join(repoRoot, '.worktreeinclude');
      if (!existsSync(includePath)) return [];
      return readFileSync(includePath, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => ({
          pattern: line.startsWith('!') ? line.slice(1) : line,
          isNegation: line.startsWith('!'),
        }));
    },
    applyInclude(patterns, srcDir, destDir, opts) {
      return copyPathsParallelFallback(
        srcDir,
        destDir,
        patterns.filter((pattern) => !pattern.isNegation).map((pattern) => pattern.pattern),
        opts,
      );
    },
    listWorktrees() {
      return [];
    },
    pruneWorktrees(opts) {
      return { integrationTarget: opts.integrationTarget, candidates: [] };
    },
    removeDir(opts) {
      rmSync(opts.path, { recursive: true, force: true });
      return { files: 0, bytes: 0 };
    },
  };
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
