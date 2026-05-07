/**
 * Copy-on-write file utility for `@cleocode/worktree`.
 *
 * Provides efficient path copying using filesystem-level copy-on-write
 * (reflink / clonefile) when available, falling back to regular recursive copy.
 *
 * Platform support:
 * - macOS (darwin): APFS clonefile via `cp -cR`
 * - Linux: btrfs / xfs / zfs reflink via `cp -R --reflink=auto`
 * - Windows: `fs.copyFile` with `COPYFILE_FICLONE` (Node 24+) for files,
 *   regular recursive copy for directories
 *
 * @task T1161
 */

import { execFile } from 'node:child_process';
import { constants, existsSync, promises as fs, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Copy multiple paths from a source directory to a target directory using
 * copy-on-write when available.
 *
 * Each path in `paths` is treated as relative to `sourceDir` and copied to
 * the corresponding location under `targetDir`.
 *
 * Missing source paths are skipped with a warning written to `stderr`.
 * Existing target paths are skipped without overwriting.
 *
 * If a copy-on-write attempt fails, a regular recursive copy is attempted
 * as fallback. If that also fails, the path is recorded in `failed`.
 *
 * @param paths - Array of relative paths to copy.
 * @param sourceDir - Absolute path to the source directory.
 * @param targetDir - Absolute path to the target directory.
 * @returns Object with arrays of successfully copied and failed paths.
 */
export async function copyPathsWithReflock(
  paths: string[],
  sourceDir: string,
  targetDir: string,
): Promise<{ copied: string[]; failed: string[] }> {
  const copied: string[] = [];
  const failed: string[] = [];

  for (const relativePath of paths) {
    const sourcePath = join(sourceDir, relativePath);
    const targetPath = join(targetDir, relativePath);

    if (!existsSync(sourcePath)) {
      process.stderr.write(`[copy-on-write] skipping missing source: ${sourcePath}\n`);
      continue;
    }

    if (existsSync(targetPath)) {
      continue;
    }

    try {
      mkdirSync(dirname(targetPath), { recursive: true });
    } catch {
      process.stderr.write(
        `[copy-on-write] failed to create parent directory for: ${targetPath}\n`,
      );
      failed.push(relativePath);
      continue;
    }

    try {
      await copyWithReflock(sourcePath, targetPath);
      copied.push(relativePath);
    } catch {
      try {
        await copyRegular(sourcePath, targetPath);
        copied.push(relativePath);
      } catch {
        failed.push(relativePath);
      }
    }
  }

  return { copied, failed };
}

/**
 * Attempt a copy-on-write copy from source to target.
 *
 * @param sourcePath - Absolute path to the source file or directory.
 * @param targetPath - Absolute path to the target location.
 * @throws Error if the copy operation fails or the platform is unsupported.
 */
async function copyWithReflock(sourcePath: string, targetPath: string): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    await execFileAsync('cp', ['-cR', sourcePath, targetPath]);
    return;
  }

  if (platform === 'linux') {
    await execFileAsync('cp', ['-R', '--reflink=auto', sourcePath, targetPath]);
    return;
  }

  if (platform === 'win32') {
    const stat = await fs.stat(sourcePath);
    if (stat.isDirectory()) {
      throw new Error('Windows directories do not support copy-on-write');
    }
    await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_FICLONE);
    return;
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Perform a regular recursive copy as fallback.
 *
 * @param sourcePath - Absolute path to the source file or directory.
 * @param targetPath - Absolute path to the target location.
 * @throws Error if the copy operation fails.
 */
async function copyRegular(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fs.stat(sourcePath);
  if (stat.isDirectory()) {
    await fs.cp(sourcePath, targetPath, { recursive: true });
  } else {
    await fs.copyFile(sourcePath, targetPath);
  }
}
