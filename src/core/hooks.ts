/**
 * Git hook management utilities.
 *
 * Extracted from init.ts to enable shared use across init, upgrade, and
 * doctor/health-check workflows.
 *
 * Handles installation, update, and verification of managed git hooks
 * from the package's templates/git-hooks/ directory.
 */

import { chmod, mkdir, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageRoot } from './scaffold.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  action: 'created' | 'repaired' | 'skipped';
  path: string;
  details?: string;
}

export interface HookCheckResult {
  hook: string;
  installed: boolean;
  current: boolean;
  sourcePath: string;
  installedPath: string;
}

export interface EnsureGitHooksOptions {
  force?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

/** Git hooks managed by CLEO. */
export const MANAGED_HOOKS = ['commit-msg', 'pre-commit'] as const;

export type ManagedHook = (typeof MANAGED_HOOKS)[number];

// ── ensureGitHooks ───────────────────────────────────────────────────

/**
 * Install or update managed git hooks from templates/git-hooks/ into .git/hooks/.
 *
 * Handles:
 * - No .git directory (skips gracefully)
 * - No source templates directory (skips gracefully)
 * - Hooks already installed (skips unless force)
 * - Sets executable permissions on installed hooks
 */
export async function ensureGitHooks(
  projectRoot: string,
  opts?: EnsureGitHooksOptions,
): Promise<ScaffoldResult> {
  const gitDir = join(projectRoot, '.git');
  const gitHooksDir = join(gitDir, 'hooks');

  if (!existsSync(gitDir)) {
    return {
      action: 'skipped',
      path: gitHooksDir,
      details: 'No .git/ directory found, skipping git hook installation',
    };
  }

  const packageRoot = getPackageRoot();
  const sourceDir = join(packageRoot, 'templates', 'git-hooks');

  if (!existsSync(sourceDir)) {
    return {
      action: 'skipped',
      path: sourceDir,
      details: 'templates/git-hooks/ not found in package root, skipping git hook installation',
    };
  }

  await mkdir(gitHooksDir, { recursive: true });

  const force = opts?.force ?? false;
  let installedCount = 0;
  const errors: string[] = [];

  for (const hook of MANAGED_HOOKS) {
    const sourcePath = join(sourceDir, hook);
    const destPath = join(gitHooksDir, hook);

    if (!existsSync(sourcePath)) {
      continue;
    }

    if (existsSync(destPath) && !force) {
      continue;
    }

    try {
      await copyFile(sourcePath, destPath);
      await chmod(destPath, 0o755);
      installedCount++;
    } catch (err) {
      errors.push(`Failed to install git hook ${hook}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    return {
      action: 'repaired',
      path: gitHooksDir,
      details: `Installed ${installedCount} hook(s) with ${errors.length} error(s): ${errors.join('; ')}`,
    };
  }

  if (installedCount === 0) {
    return {
      action: 'skipped',
      path: gitHooksDir,
      details: 'All managed hooks already installed',
    };
  }

  return {
    action: 'created',
    path: gitHooksDir,
    details: `Installed ${installedCount} git hooks`,
  };
}

// ── checkGitHooks ────────────────────────────────────────────────────

/**
 * Verify managed hooks are installed and current.
 *
 * Compares installed hooks in .git/hooks/ against source templates in the
 * package's templates/git-hooks/ directory. Returns per-hook status including
 * whether the hook is installed and whether its content matches the source.
 */
export async function checkGitHooks(projectRoot: string): Promise<HookCheckResult[]> {
  const gitHooksDir = join(projectRoot, '.git', 'hooks');
  const packageRoot = getPackageRoot();
  const sourceDir = join(packageRoot, 'templates', 'git-hooks');
  const results: HookCheckResult[] = [];

  for (const hook of MANAGED_HOOKS) {
    const sourcePath = join(sourceDir, hook);
    const installedPath = join(gitHooksDir, hook);

    const result: HookCheckResult = {
      hook,
      installed: false,
      current: false,
      sourcePath,
      installedPath,
    };

    if (!existsSync(sourcePath)) {
      // No source template — nothing to compare against
      results.push(result);
      continue;
    }

    if (!existsSync(installedPath)) {
      results.push(result);
      continue;
    }

    result.installed = true;

    try {
      const [sourceContent, installedContent] = await Promise.all([
        readFile(sourcePath, 'utf-8'),
        readFile(installedPath, 'utf-8'),
      ]);
      result.current = sourceContent === installedContent;
    } catch {
      // If we can't read either file, mark as not current
      result.current = false;
    }

    results.push(result);
  }

  return results;
}
