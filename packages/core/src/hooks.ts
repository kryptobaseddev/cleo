/** Shared Git hook management wrappers for init, upgrade and health. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookCheckResult, ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';
import {
  CLEO_HOOK_NAMES,
  defaultTemplatesDir,
  installCleoHooks,
  resolveGitDir,
  resolveHooksDir,
} from './git/hooks-install.js';

export type { HookCheckResult, ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';
/** Compatibility options; force never permits replacing foreign/customized hooks. */
export interface EnsureGitHooksOptions {
  force?: boolean;
}
/** Canonical shipped hook set shared with the installer. */
export const MANAGED_HOOKS = CLEO_HOOK_NAMES;
/** One shipped Git hook name. */
export type ManagedHook = (typeof MANAGED_HOOKS)[number];

/** Install all managed hooks through the canonical ownership-aware installer. */
export async function ensureGitHooks(
  projectRoot: string,
  opts?: EnsureGitHooksOptions,
): Promise<ScaffoldResult> {
  if (!resolveGitDir(projectRoot))
    return {
      action: 'skipped',
      path: projectRoot,
      details: 'No git repository found, skipping git hook installation',
    };
  try {
    const result = await installCleoHooks(projectRoot, opts);
    const conflicts = result.skipped
      .map((name) => `${name}: ${result.skipReasons[name]}`)
      .join('; ');
    return {
      action: result.installed.length ? 'created' : 'skipped',
      path: result.hooksDir,
      details: `Installed ${result.installed.length} git hooks${conflicts ? `; ${conflicts}` : ''}`,
    };
  } catch (err) {
    return {
      action: 'skipped',
      path: projectRoot,
      details: `Git hook installation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Inspect all hooks at the location Git actually executes, including worktrees. */
export async function checkGitHooks(projectRoot: string): Promise<HookCheckResult[]> {
  const gitDir = resolveGitDir(projectRoot);
  const hooksDir = gitDir
    ? resolveHooksDir(projectRoot, gitDir)
    : join(projectRoot, '.git', 'hooks');
  const templates = defaultTemplatesDir();
  return MANAGED_HOOKS.map((hook) => {
    const sourcePath = join(templates, hook);
    const installedPath = join(hooksDir, hook);
    const installed = existsSync(installedPath);
    let current = false;
    try {
      current =
        installed && readFileSync(sourcePath, 'utf8') === readFileSync(installedPath, 'utf8');
    } catch {
      /* Report unreadable hooks as not current. */
    }
    return { hook, installed, current, sourcePath, installedPath };
  });
}
