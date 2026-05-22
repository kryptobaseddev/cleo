/**
 * Worktree include-pattern parsing and application.
 *
 * Reads the project's include patterns (gitignore-syntax) and creates symlinks
 * from the worktree back to the project tree for matched paths. The actual
 * pattern matching is delegated to `@cleocode/worktree-napi`'s
 * `readWorktreeInclude` which uses `ignore::gitignore` under the hood — a real
 * glob matcher that replaces the prior `existsSync`-on-literal-pattern bug.
 *
 * Canonical file: `<projectRoot>/.worktreeinclude` (multi-language native;
 * matches the worktrunk-core spec, Claude Code Desktop, etc.).
 *
 * Legacy file: `<projectRoot>/.cleo/worktree-include` (1-cycle deprecation —
 * still read when `.worktreeinclude` is absent, with a one-time stderr warning).
 *
 * @task T9982
 * @task T1161
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { WorktreeIncludePattern } from '@cleocode/contracts';
import { readWorktreeInclude as napiReadWorktreeInclude } from '@cleocode/worktree-napi';

const CANONICAL_INCLUDE_FILE = '.worktreeinclude';
const LEGACY_INCLUDE_FILE_DIR = '.cleo';
const LEGACY_INCLUDE_FILE_NAME = 'worktree-include';

let legacyWarningEmitted = false;

/**
 * Emit a one-time deprecation warning when the legacy path is in use.
 *
 * @internal
 */
function emitLegacyWarning(legacyPath: string): void {
  if (legacyWarningEmitted) return;
  legacyWarningEmitted = true;
  process.emitWarning(
    `[@cleocode/worktree] Found legacy "${legacyPath}". Migrate to ` +
      `".worktreeinclude" at the project root — run \`cleo doctor --migrate-worktree-include\` ` +
      `for an automated migration. The legacy path will be removed in a future release.`,
    'DeprecationWarning',
    'CLEO_WORKTREE_INCLUDE_LEGACY',
  );
}

/**
 * Load and parse the project's worktree-include file.
 *
 * Resolution order (T9982):
 * 1. `<projectRoot>/.worktreeinclude` — canonical multi-language native path
 *    consumed directly by `napi.readWorktreeInclude` (real ignore::gitignore
 *    matcher).
 * 2. `<projectRoot>/.cleo/worktree-include` — 1-cycle deprecation fallback
 *    that copies the legacy file into a temp `.worktreeinclude` shim so the
 *    napi reader still applies real glob semantics. Emits a one-time
 *    `DeprecationWarning` via `process.emitWarning`.
 *
 * Returns an empty array if neither file exists. The napi binding handles
 * blank lines, comments (`#`-prefixed), and negation (`!`-prefixed) per the
 * gitignore spec.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Parsed include patterns, or empty array when no file is present.
 *
 * @task T9982
 * @task T1161
 */
export function loadWorktreeIncludePatterns(projectRoot: string): WorktreeIncludePattern[] {
  const canonicalPath = join(projectRoot, CANONICAL_INCLUDE_FILE);
  if (existsSync(canonicalPath)) {
    return readPatternsViaNapi(projectRoot);
  }

  const legacyPath = join(projectRoot, LEGACY_INCLUDE_FILE_DIR, LEGACY_INCLUDE_FILE_NAME);
  if (existsSync(legacyPath)) {
    emitLegacyWarning(legacyPath);
    return readPatternsFromLegacyShim(legacyPath);
  }

  return [];
}

/**
 * Read patterns via the canonical `.worktreeinclude` path through napi.
 *
 * Wraps `napi.readWorktreeInclude` and maps the FFI shape (camelCase already
 * applied by napi-derive) into the existing TS {@link WorktreeIncludePattern}
 * surface so existing callers compile unchanged.
 *
 * @internal
 */
function readPatternsViaNapi(repoRoot: string): WorktreeIncludePattern[] {
  try {
    const napiPatterns = napiReadWorktreeInclude(repoRoot);
    return napiPatterns.map((p) => ({
      pattern: p.pattern,
      negated: p.isNegation,
    }));
  } catch (err) {
    process.stderr.write(
      `[worktree-include] napi.readWorktreeInclude failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

/**
 * Stage the legacy `.cleo/worktree-include` file into a temp `.worktreeinclude`
 * directory and feed it to the napi reader.
 *
 * Keeps the deprecation strictly behind a 1-cycle bridge — the legacy text
 * format is unchanged, and the gitignore matcher in `worktrunk-core` does the
 * real work.
 *
 * @internal
 */
function readPatternsFromLegacyShim(legacyPath: string): WorktreeIncludePattern[] {
  let raw: string;
  try {
    raw = readFileSync(legacyPath, 'utf-8');
  } catch {
    return [];
  }

  let shimDir: string;
  try {
    shimDir = mkdtempSync(join(tmpdir(), 'cleo-worktree-include-shim-'));
    writeFileSync(join(shimDir, CANONICAL_INCLUDE_FILE), raw);
  } catch (err) {
    process.stderr.write(
      `[worktree-include] failed to stage legacy file via shim: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }

  return readPatternsViaNapi(shimDir);
}

/**
 * Apply include patterns to a newly created worktree by creating symlinks
 * from the worktree directory back to the main project tree.
 *
 * Only non-negated patterns are symlinked. Negated patterns are recorded for
 * audit purposes but do not cause any filesystem action.
 *
 * Symlinks are created as: `<worktreePath>/<pattern>` → `<projectRoot>/<pattern>`.
 *
 * Already-existing paths in the worktree are skipped (not overwritten) — git
 * worktree add may have already created them.
 *
 * When the target path has a parent directory that does not yet exist in the
 * worktree (e.g. `.vscode/settings.json` when `.vscode/` was never created),
 * the parent is created with `mkdirSync({ recursive: true })` before the
 * `symlinkSync` call. This prevents the `ENOENT` error reported in T9807.
 *
 * The pattern-evaluation strategy stays in TS for now because each pattern
 * needs an existence check against the project tree + a per-pattern symlink —
 * a thin wrapper that defers to the napi matcher would not measurably improve
 * the hot path here (pattern lists are short and the work is dominated by
 * filesystem syscalls, not regex matching).
 *
 * @param patterns - Parsed include patterns from {@link loadWorktreeIncludePatterns}.
 * @param projectRoot - Absolute path to the project root (symlink target base).
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns Array of patterns that were successfully symlinked.
 *
 * @task T9982
 * @task T9807
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

    // T9807 — ensure the parent directory exists in the worktree before calling
    // symlinkSync. Patterns like `.vscode/settings.json` require `.vscode/` to
    // exist first; without this step, symlinkSync throws ENOENT for every spawn
    // on machines where the parent directory was never checked in.
    const parentDir = dirname(targetPath);
    try {
      mkdirSync(parentDir, { recursive: true });
    } catch {
      process.stderr.write(
        `[worktree] include-pattern parent-dir creation failed: ${entry.pattern}\n`,
      );
      continue;
    }

    try {
      symlinkSync(sourcePath, targetPath);
      applied.push(entry);
    } catch {
      // Non-fatal: log and continue. Callers can inspect applied[] to see
      // which patterns succeeded.
      process.stderr.write(`[worktree] include-pattern symlink failed: ${entry.pattern}\n`);
    }
  }

  return applied;
}
