/**
 * Worktree identity migration for `@cleocode/worktree`.
 *
 * Backfills `project-info.json` into existing worktrees that were created
 * before the identity system (T11033) was deployed. New worktrees get
 * project-info.json at provision time; this module handles the legacy ones.
 *
 * @task T11036
 * @epic T10299
 * @saga T10295
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listWorktreesByProjectRoot } from './worktree-list.js';

/**
 * Result of a single worktree identity migration.
 */
export interface MigrateWorktreeResult {
  /** Absolute path to the worktree that was checked. */
  worktreePath: string;
  /** Whether the migration actually backfilled (created) project-info.json. */
  backfilled: boolean;
  /** The projectId from the parent project's project-info.json, if present. */
  projectId?: string;
  /** The projectHash from the parent project's project-info.json, if present. */
  projectHash?: string;
  /** The resolved parent project root, if successfully discovered. */
  parentProjectRoot?: string;
  /** Human-readable error reason when migration could not proceed. */
  error?: string;
}

/**
 * Discover the parent project root from a git worktree's `.git` gitlink file.
 *
 * Git worktrees use a `.git` FILE (not directory) containing a gitdir reference:
 *   `gitdir: /path/to/main/.git/worktrees/<name>`
 *
 * From this we derive: `<gitdir>/../..` → main repo root.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns The resolved main repo root, or null if it cannot be determined.
 * @internal
 */
export function discoverParentProjectRoot(worktreePath: string): string | null {
  const gitFile = join(worktreePath, '.git');

  // Not a worktree (or `.git` is a directory — linked checkout, not a worktree).
  if (!existsSync(gitFile)) return null;

  let content: string;
  try {
    content = readFileSync(gitFile, 'utf-8');
  } catch {
    return null;
  }

  // Parse the gitdir line from the gitlink.
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;

  // gitDir is something like: /path/to/main/.git/worktrees/<name>
  // Resolve relative to the worktree path for portability.
  const gitDir = resolve(worktreePath, match[1].trim());

  // Main repo root = resolve(gitDir, '../../..') — go up from
  // worktrees/<name> → .git → repo root (3 levels).
  return resolve(gitDir, '../../..');
}

/**
 * Backfill `project-info.json` into a worktree that lacks it.
 *
 * Discovers the parent project root via the worktree's `.git` gitlink, reads
 * the parent's `.cleo/project-info.json`, and copies it into the worktree's
 * `.cleo/` directory. Idempotent: if project-info.json already exists, the
 * worktree is skipped with `backfilled: false`.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns Migration result with backfill status and identity fields.
 *
 * @task T11036
 */
export function migrateWorktreeIdentity(worktreePath: string): MigrateWorktreeResult {
  const worktreeCleoDir = join(worktreePath, '.cleo');
  const worktreeInfoPath = join(worktreeCleoDir, 'project-info.json');

  // ── Idempotency: skip if already present ──────────────────────────
  if (existsSync(worktreeInfoPath)) {
    try {
      const existing = JSON.parse(readFileSync(worktreeInfoPath, 'utf-8')) as Record<string, unknown>;
      return {
        worktreePath,
        backfilled: false,
        projectId: typeof existing.projectId === 'string' ? existing.projectId : undefined,
        projectHash: typeof existing.projectHash === 'string' ? existing.projectHash : undefined,
      };
    } catch {
      // Corrupt project-info.json — treat as missing and backfill.
    }
  }

  // ── Discover parent project root ──────────────────────────────────
  const parentProjectRoot = discoverParentProjectRoot(worktreePath);
  if (!parentProjectRoot) {
    return {
      worktreePath,
      backfilled: false,
      error: 'Cannot determine parent project root — worktree has no .git gitlink',
    };
  }

  // ── Read parent project-info.json ─────────────────────────────────
  const parentInfoPath = join(parentProjectRoot, '.cleo', 'project-info.json');
  if (!existsSync(parentInfoPath)) {
    return {
      worktreePath,
      backfilled: false,
      error: `Parent project at ${parentProjectRoot} has no .cleo/project-info.json`,
    };
  }

  let parentInfo: Record<string, unknown>;
  try {
    parentInfo = JSON.parse(readFileSync(parentInfoPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {
      worktreePath,
      backfilled: false,
      error: `Cannot parse parent project-info.json at ${parentInfoPath}`,
    };
  }

  // ── Backfill ──────────────────────────────────────────────────────
  try {
    mkdirSync(worktreeCleoDir, { recursive: true });
    copyFileSync(parentInfoPath, worktreeInfoPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      worktreePath,
      backfilled: false,
      error: `Failed to copy project-info.json: ${message}`,
    };
  }

  return {
    worktreePath,
    backfilled: true,
    projectId: typeof parentInfo.projectId === 'string' ? parentInfo.projectId : undefined,
    projectHash: typeof parentInfo.projectHash === 'string' ? parentInfo.projectHash : undefined,
    parentProjectRoot,
  };
}

/**
 * Migrate ALL existing worktrees for a given project root.
 *
 * Enumerates worktrees via the XDG directory scan, then backfills
 * project-info.json into each worktree that lacks it.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Array of migration results, one per worktree.
 *
 * @task T11036
 */
export function migrateAllWorktreeIdentities(projectRoot: string): MigrateWorktreeResult[] {
  const worktrees = listWorktreesByProjectRoot(projectRoot);
  return worktrees.map((wt) => migrateWorktreeIdentity(wt.path));
}
