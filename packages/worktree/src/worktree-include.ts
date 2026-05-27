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
import { readWorktreeInclude as napiReadWorktreeInclude } from './napi-binding.js';

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
 * Apply include patterns to a newly created worktree by copying files
 * from the project root using @cleocode/worktree-napi's parallel reflink-aware
 * copy primitive.
 *
 * Each non-negated pattern is copied from `<projectRoot>/<pattern>` to
 * `<worktreePath>/<pattern>`. Negated patterns are excluded.
 *
 * Unlike the prior symlink-based implementation (removed in T10077), this
 * produces full file copies so worktree isolation is preserved — modifying
 * a file in one worktree does not affect any other worktree.
 *
 * The NAPI binding uses 4-thread rayon parallelism with reflink probing
 * (APFS clonefile on macOS, btrfs/xfs/zfs reflink on Linux, regular copy
 * fallback on other FS).
 *
 * Already-existing paths in the worktree are left untouched by the NAPI
 * layer (the `force` option defaults to `false`).
 *
 * @param patterns - Parsed include patterns from {@link loadWorktreeIncludePatterns}.
 * @param projectRoot - Absolute path to the project root (source base).
 * @param worktreePath - Absolute path to the worktree directory (target base).
 * @returns Array of patterns that were successfully copied.
 *
 * @task T10077
 */
export function applyIncludePatterns(
  patterns: readonly WorktreeIncludePattern[],
  projectRoot: string,
  worktreePath: string,
): WorktreeIncludePattern[] {
  // Filter to non-negated patterns only.
  const nonNegated = patterns.filter((p) => !p.negated);
  if (nonNegated.length === 0) return [];

  // Map TS types to the NAPI IncludePatternNapi shape.
  const napiPatterns: import('./napi-binding.js').IncludePatternNapi[] = nonNegated.map((p) => ({
    pattern: p.pattern,
    isNegation: false,
  }));

  const opts: import('./napi-binding.js').CopyOptsNapi = {
    force: false,
    rootGuard: worktreePath,
    includeSymlinks: true,
  };

  try {
    const { applyInclude } = require('./napi-binding.js') as typeof import('./napi-binding.js');
    const result = applyInclude(napiPatterns, projectRoot, worktreePath, opts);

    // Build the applied list — patterns that succeeded (not in failedPaths).
    const failedSet = new Set(result.failedPaths);
    const applied = nonNegated.filter((p) => !failedSet.has(p.pattern));

    if (failedSet.size > 0) {
      process.stderr.write(
        `[worktree] include-pattern copy failed for: ${[...failedSet].join(', ')}\\n`,
      );
    }

    return applied.map((p) => ({
      pattern: p.pattern,
      negated: false,
    }));
  } catch (err) {
    // NAPI not available (test environment, missing binary, etc.) —
    // fall back to symlink for backward compatibility.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[worktree] napi.applyInclude unavailable, falling back to symlinks: ${message}\\n`,
    );
    return applyIncludePatternsLegacy(patterns, projectRoot, worktreePath);
  }
}

/**
 * Legacy symlink-based include pattern application.
 *
 * Used as a fallback when the NAPI binding is not available (test
 * environments, platforms without a prebuilt binary, etc.).
 *
 * This is the OLD implementation that was replaced in T10077. It is kept
 * as a fallback for environments where the NAPI binary cannot be loaded.
 *
 * @internal
 */
function applyIncludePatternsLegacy(
  patterns: readonly WorktreeIncludePattern[],
  projectRoot: string,
  worktreePath: string,
): WorktreeIncludePattern[] {
  const applied: WorktreeIncludePattern[] = [];

  for (const entry of patterns) {
    if (entry.negated) continue;

    const sourcePath = resolve(projectRoot, entry.pattern);
    const targetPath = resolve(worktreePath, entry.pattern);

    if (!existsSync(sourcePath)) continue;
    if (existsSync(targetPath)) continue;

    const parentDir = dirname(targetPath);
    try {
      mkdirSync(parentDir, { recursive: true });
    } catch {
      process.stderr.write(
        `[worktree] include-pattern parent-dir creation failed: ${entry.pattern}\\n`,
      );
      continue;
    }

    try {
      symlinkSync(sourcePath, targetPath);
      applied.push(entry);
    } catch {
      process.stderr.write(`[worktree] include-pattern symlink failed: ${entry.pattern}\\n`);
    }
  }

  return applied;
}
