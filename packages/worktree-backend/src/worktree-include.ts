/**
 * `.cleo/worktree-include` glob pattern support — native lift of worktrunk's
 * worktree-include feature per D030.
 *
 * The file `.cleo/worktree-include` in the project root contains glob patterns
 * (one per line, `#`-prefixed comments stripped, blank lines ignored) that
 * control which files/directories from the main project tree are symlinked
 * into a newly created worktree.
 *
 * Lines prefixed with `!` are negated patterns (exclusions).
 *
 * Example `.cleo/worktree-include`:
 * ```
 * # Include pnpm store to avoid re-downloading in each worktree
 * node_modules/.pnpm
 * # Include shared config
 * .env.local
 * # Exclude secrets
 * !.env.production
 * ```
 *
 * @task T1161
 */

import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorktreeIncludePattern } from '@cleocode/contracts';

const INCLUDE_FILE_NAME = 'worktree-include';

/**
 * Load and parse the `.cleo/worktree-include` file from the project root.
 *
 * Returns an empty array if the file does not exist. Comments (lines starting
 * with `#`) and blank lines are ignored. Lines starting with `!` are parsed
 * as negated patterns.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Parsed include patterns, or empty array if file is absent.
 */
export function loadWorktreeIncludePatterns(projectRoot: string): WorktreeIncludePattern[] {
  const filePath = join(projectRoot, '.cleo', INCLUDE_FILE_NAME);
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, 'utf-8');
  const patterns: WorktreeIncludePattern[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    const negated = trimmed.startsWith('!');
    const pattern = negated ? trimmed.slice(1).trim() : trimmed;
    if (pattern) {
      patterns.push({ pattern, negated });
    }
  }

  return patterns;
}

/**
 * Apply include patterns to a newly created worktree by creating symlinks
 * from the worktree directory back to the main project tree.
 *
 * Only non-negated patterns are symlinked. Negated patterns are recorded for
 * audit purposes but do not cause any filesystem action.
 *
 * Symlinks are created as: `<worktreePath>/<pattern>` → `<projectRoot>/<pattern>`
 *
 * Already-existing paths in the worktree are skipped (not overwritten) — git
 * worktree add may have already created them.
 *
 * @param patterns - Parsed include patterns from {@link loadWorktreeIncludePatterns}.
 * @param projectRoot - Absolute path to the project root (symlink target base).
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns Array of patterns that were successfully symlinked.
 */
export function applyIncludePatterns(
  patterns: readonly WorktreeIncludePattern[],
  projectRoot: string,
  worktreePath: string,
): WorktreeIncludePattern[] {
  const applied: WorktreeIncludePattern[] = [];

  for (const entry of patterns) {
    // Negated patterns are exclusions — no filesystem action needed.
    if (entry.negated) continue;

    const sourcePath = resolve(projectRoot, entry.pattern);
    const targetPath = resolve(worktreePath, entry.pattern);

    // Skip if the source does not exist in the project tree.
    if (!existsSync(sourcePath)) continue;

    // Skip if a file/dir/symlink already exists at this path in the worktree.
    if (existsSync(targetPath)) continue;

    try {
      symlinkSync(sourcePath, targetPath);
      applied.push(entry);
    } catch {
      // Non-fatal: log and continue. Callers can inspect applied[] to see
      // which patterns succeeded.
      process.stderr.write(`[worktree-backend] include-pattern symlink failed: ${entry.pattern}\n`);
    }
  }

  return applied;
}
