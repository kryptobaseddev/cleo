/**
 * Agent installation functions.
 * Ports lib/skills/agents-install.sh.
 *
 * Installs a project's agents (`<project>/agents/<name>/AGENT.md`) for Claude
 * Code by symlinking them into the PROJECT's `.claude/agents/` (T13241). CLEO
 * never writes the user-global Claude config (`CLAUDE_HOME`, else
 * `~/.claude`): a project that is the home directory, or whose `.claude/`
 * lies inside the user-global Claude dir, is refused and nothing is written.
 *
 * @epic T4454
 * @task T4518
 * @task T13241
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getProjectRoot } from '../../paths.js';
import { getAgentsDir } from './config.js';

/**
 * Symlink type for directory symlinks.
 * On Windows, use 'junction' (no admin privileges required).
 * On Unix, use 'dir'.
 */
const DIR_SYMLINK_TYPE: 'junction' | 'dir' = platform() === 'win32' ? 'junction' : 'dir';

// ============================================================================
// Agent Installation
// ============================================================================

/** `path` with its existing leading part resolved through the native realpath (on-disk case). */
function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

/** Case-folded where volumes are case-insensitive by default (APFS, NTFS). */
function comparable(path: string): string {
  return platform() === 'darwin' || platform() === 'win32' ? path.toLowerCase() : path;
}

/** Whether `path` is `dir` or inside it. */
function isAtOrInside(path: string, dir: string): boolean {
  const rel = relative(comparable(canonicalPath(dir)), comparable(canonicalPath(path)));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Where a project's agents are installed: `<projectRoot>/.claude/agents`, or
 * the reason it is refused because that would be user-global Claude config
 * (T13241): the project is the home directory (its `.claude/` IS the
 * user-global dir), or the target lies inside `CLAUDE_HOME` / `~/.claude`.
 *
 * @param cwd - a directory in the project. @defaultValue process.cwd()
 * @returns `{ dir }`, or `{ refused }` with the reason.
 *
 * @example
 * ```typescript
 * projectAgentInstallDir('/repo'); // { dir: '/repo/.claude/agents' }
 * ```
 */
export function projectAgentInstallDir(
  cwd?: string,
): { readonly dir: string } | { readonly refused: string } {
  const root = getProjectRoot(cwd);
  const dir = join(root, '.claude', 'agents');
  if (comparable(canonicalPath(root)) === comparable(canonicalPath(homedir()))) {
    return { refused: `refusing to write ${dir}: the project is the home directory` };
  }
  const claudeHome = process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');
  if (isAtOrInside(dir, claudeHome)) {
    return { refused: `refusing to write ${dir}: it is inside the user-global Claude config dir` };
  }
  return { dir };
}

/**
 * Install a single agent via symlink into the project's `.claude/agents/`.
 *
 * @param agentDir - the agent's source directory.
 * @param cwd - a directory in the project. @defaultValue process.cwd()
 * @returns whether it is installed, where, and why not. A user-global target
 *   (T13241) is refused with nothing written.
 * @task T4518
 * @task T13241
 */
export function installAgent(
  agentDir: string,
  cwd?: string,
): {
  installed: boolean;
  path: string;
  error?: string;
} {
  const agentName = basename(agentDir);
  const target = projectAgentInstallDir(cwd);
  if ('refused' in target) {
    return { installed: false, path: agentName, error: target.refused };
  }
  const targetDir = target.dir;
  const targetPath = join(targetDir, agentName);

  // Ensure target directory exists
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Check source exists
  if (!existsSync(agentDir)) {
    return { installed: false, path: targetPath, error: `Source not found: ${agentDir}` };
  }

  // Handle existing entry
  if (existsSync(targetPath)) {
    try {
      const existing = readlinkSync(targetPath);
      if (existing === agentDir) {
        return { installed: true, path: targetPath }; // Already correct
      }
      // Different target, remove and re-link
      unlinkSync(targetPath);
    } catch {
      // Not a symlink, skip
      return {
        installed: false,
        path: targetPath,
        error: `Target exists and is not a symlink: ${targetPath}`,
      };
    }
  }

  try {
    symlinkSync(agentDir, targetPath, DIR_SYMLINK_TYPE);
    return { installed: true, path: targetPath };
  } catch (err) {
    return { installed: false, path: targetPath, error: `Symlink failed: ${err}` };
  }
}

/**
 * Install all agents from the project agents/ directory into the project's
 * `.claude/agents/` (T13241).
 *
 * @param cwd - a directory in the project. @defaultValue process.cwd()
 * @task T4518
 * @task T13241
 */
export function installAllAgents(
  cwd?: string,
): Array<{ name: string; installed: boolean; error?: string }> {
  const agentsDir = getAgentsDir(cwd);
  const results: Array<{ name: string; installed: boolean; error?: string }> = [];

  if (!existsSync(agentsDir)) {
    return results;
  }

  const entries = readdirSync(agentsDir);

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const agentDir = join(agentsDir, entry);

    const agentMdPath = join(agentDir, 'AGENT.md');
    if (!existsSync(agentMdPath)) continue;

    const result = installAgent(agentDir, cwd);
    results.push({
      name: entry,
      installed: result.installed,
      error: result.error,
    });
  }

  return results;
}

/**
 * Uninstall a single agent by removing its symlink from the project's
 * `.claude/agents/`. Never touches the user-global Claude dir (T13241):
 * a refused target returns `false`.
 *
 * @param agentName - the agent's directory name.
 * @param cwd - a directory in the project. @defaultValue process.cwd()
 * @task T4518
 * @task T13241
 */
export function uninstallAgent(agentName: string, cwd?: string): boolean {
  const target = projectAgentInstallDir(cwd);
  if ('refused' in target) return false;
  const targetPath = join(target.dir, agentName);

  if (!existsSync(targetPath)) {
    return false;
  }

  try {
    unlinkSync(targetPath);
    return true;
  } catch {
    return false;
  }
}
