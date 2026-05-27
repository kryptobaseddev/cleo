/**
 * Copy-on-write file utility for `@cleocode/worktree`.
 *
 * Thin TS wrapper around `@cleocode/worktree-napi`'s parallel reflink-aware
 * copy primitive ({@link copyPathsParallel}). Replaces the prior 150-LOC
 * sequential `execFile('cp')` loop — the worktree bootstrap is now a single
 * Rust call backed by a 4-thread rayon pool with reflink probing.
 *
 * Platform support inherited from `worktrunk-core::copy::copy_leaf`:
 * - macOS (darwin): APFS clonefile via `cp -c`
 * - Linux: btrfs / xfs / zfs reflink via `cp --reflink=auto`
 * - Windows: regular copyFile with FICLONE on supported FS
 *
 * @task T9982
 * @task T1161
 */

import { type CopyResultNapi, copyPathsParallel } from './napi-binding.js';

/**
 * Optional knobs for {@link copyPathsWithReflock}.
 *
 * Mirrors the napi `CopyOpts` shape with TS-friendly defaults. The `rootGuard`
 * option keeps every destination resolution inside the supplied root — the
 * canonical XDG worktree path is the recommended value for production callers.
 *
 * @task T9982
 */
export interface CopyPathsOptions {
  /** Overwrite existing entries at the destination. Default `false`. */
  force?: boolean;
  /**
   * When set, every destination must resolve inside this root. Used as a
   * safety belt against path traversal in the supplied `paths` list.
   */
  rootGuard?: string;
  /**
   * Reserved for future use — symlinks are always followed by the underlying
   * `worktrunk_core::copy::copy_leaf` today. Default `true`.
   */
  includeSymlinks?: boolean;
}

/**
 * Copy multiple paths from a source directory to a target directory using
 * copy-on-write when available, in parallel via the Rust binding.
 *
 * Each entry in `paths` is treated as relative to `sourceDir` and copied to
 * the corresponding location under `targetDir`. Missing source paths or paths
 * that already exist at the destination are silently skipped by
 * `worktrunk-core` — see the {@link CopyPathsResult.failed} list for true
 * failures.
 *
 * The synchronous-looking call boundary hides 4-thread parallelism behind the
 * napi layer; the `Promise` wrapper preserves the legacy async signature for
 * existing TS callers.
 *
 * @param paths - Array of relative paths to copy.
 * @param sourceDir - Absolute path to the source directory.
 * @param targetDir - Absolute path to the target directory.
 * @param options - Optional copy-options forwarded to the napi layer.
 * @returns Object with arrays of successfully copied and failed paths.
 *
 * @task T9982
 * @task T1161
 */
export async function copyPathsWithReflock(
  paths: string[],
  sourceDir: string,
  targetDir: string,
  options: CopyPathsOptions = {},
): Promise<{ copied: string[]; failed: string[] }> {
  if (paths.length === 0) return { copied: [], failed: [] };

  let result: CopyResultNapi;
  try {
    result = copyPathsParallel(sourceDir, targetDir, paths, {
      force: options.force ?? false,
      ...(options.rootGuard !== undefined ? { rootGuard: options.rootGuard } : {}),
      includeSymlinks: options.includeSymlinks ?? true,
    });
  } catch (err) {
    // A whole-batch failure (matcher / IO error before any leaf was tried)
    // reports every path as failed so callers can recover or audit.
    process.stderr.write(
      `[copy-on-write] napi.copyPathsParallel failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { copied: [], failed: [...paths] };
  }

  const failedSet = new Set(result.failedPaths);
  const copied = paths.filter((p) => !failedSet.has(p));
  const failed = paths.filter((p) => failedSet.has(p));

  return { copied, failed };
}
