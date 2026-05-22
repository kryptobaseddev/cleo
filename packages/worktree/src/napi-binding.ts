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
}

const nativeBinding = require_('@cleocode/worktree-napi') as WorktreeNapiModule;

export const copyPathsParallel = nativeBinding.copyPathsParallel;
export const destroyWorktree = nativeBinding.destroyWorktree;
export const readWorktreeInclude = nativeBinding.readWorktreeInclude;
export const applyInclude = nativeBinding.applyInclude;
export const listWorktrees = nativeBinding.listWorktrees;

export type {
  CopyOptsNapi,
  CopyResultNapi,
  DestroyOptsNapi,
  DestroyResultNapi,
  IncludePatternNapi,
  ListOptsNapi,
  WorktreeInfoNapi,
};
