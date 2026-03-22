/**
 * Sharing module for multi-contributor .cleo/ state management.
 *
 * Controls which .cleo/ files are committed to the project git repo
 * via a config-driven allowlist. Provides status reporting and
 * .gitignore auto-management.
 *
 * @task T4883
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SharingConfig } from '@cleocode/contracts';
import { loadConfig } from '../../config.js';
import { getCleoDirAbsolute, getProjectRoot } from '../../paths.js';
import { cleoGitCommand, isCleoGitInitialized } from '../../store/git-checkpoint.js';

/**
 * Result of a sharing status check.
 *
 * @remarks
 * Provides a complete view of which `.cleo/` files are tracked vs ignored under
 * the current sharing config, plus git sync state for Nexus multi-project visibility.
 * The `hasGit`, `remotes`, `pendingChanges`, and `lastSync` fields are populated
 * only when a `.cleo/.git` repo exists; otherwise they carry safe defaults.
 *
 * @example
 * ```typescript
 * const status = await getSharingStatus();
 * if (status.hasGit && status.pendingChanges) {
 *   console.log('Uncommitted changes in .cleo/ — run: cleo checkpoint');
 * }
 * ```
 */
export interface SharingStatus {
  mode: string;
  allowlist: string[];
  denylist: string[];
  tracked: string[];
  ignored: string[];
  /** Whether the `.cleo/.git` isolated repo exists and is initialized. */
  hasGit: boolean;
  /** Git remote names configured in `.cleo/.git` (e.g. `['origin']`). */
  remotes: string[];
  /** Whether the `.cleo/.git` working tree has uncommitted changes. */
  pendingChanges: boolean;
  /**
   * ISO 8601 timestamp of the last push or pull to/from a remote, or `null`
   * if no remote sync has ever occurred.
   */
  lastSync: string | null;
}

/** Markers for the managed section in .gitignore. */
const GITIGNORE_START = '# CLEO:SHARING:START - Auto-managed by cleo sharing sync';
const GITIGNORE_END = '# CLEO:SHARING:END';

/**
 * Match a file path against a glob-like pattern.
 * Supports: '*' (single segment wildcard), '**' (recursive wildcard),
 * and trailing '/' for directory matching.
 * @task T4883
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  // Normalize: remove leading/trailing slashes
  const normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
  const normalizedPattern = pattern.replace(/^\/+|\/+$/g, '');

  // Trailing ** matches everything under a directory
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(prefix + '/');
  }

  // Wildcard patterns with *
  if (normalizedPattern.includes('*')) {
    const regex = new RegExp(
      '^' +
        normalizedPattern
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '<<<GLOBSTAR>>>')
          .replace(/\*/g, '[^/]*')
          .replace(/<<<GLOBSTAR>>>/g, '.*') +
        '$',
    );
    return regex.test(normalizedPath);
  }

  // Exact match
  return normalizedPath === normalizedPattern;
}

/**
 * Check if a file path matches any pattern in a list.
 * @task T4883
 */
function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern));
}

/**
 * Collect all files in .cleo/ directory (relative to .cleo/).
 * Skips the .git subdirectory.
 * @task T4883
 */
function collectCleoFiles(cleoDir: string): string[] {
  if (!existsSync(cleoDir)) return [];
  const files: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === '.git') continue; // Skip isolated .cleo/.git repo
      const fullPath = join(dir, entry);
      const relPath = relative(cleoDir, fullPath);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          files.push(relPath.replaceAll('\\', '/'));
        }
      } catch {
        // Skip files we can't stat (e.g. broken symlinks)
      }
    }
  }

  walk(cleoDir);
  return files.sort();
}

/**
 * Retrieve the names of git remotes configured in the `.cleo/.git` repo.
 *
 * @remarks
 * Returns an empty array if the repo is not initialized or has no remotes.
 * Errors are suppressed — callers should treat an empty array as "no remotes known".
 *
 * @example
 * ```typescript
 * const remotes = await getCleoGitRemotes('/path/to/project/.cleo');
 * // ['origin']
 * ```
 */
async function getCleoGitRemotes(cleoDir: string): Promise<string[]> {
  const result = await cleoGitCommand(['remote'], cleoDir);
  if (!result.success || !result.stdout) return [];
  return result.stdout
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * Determine whether the `.cleo/.git` working tree has any uncommitted changes.
 *
 * @remarks
 * Uses `git status --porcelain`. A non-empty output means pending changes exist.
 * Returns `false` if the repo is not initialized or the command fails.
 *
 * @example
 * ```typescript
 * const dirty = await hasCleoGitPendingChanges('/path/to/project/.cleo');
 * // true if any files are modified/untracked
 * ```
 */
async function hasCleoGitPendingChanges(cleoDir: string): Promise<boolean> {
  const result = await cleoGitCommand(['status', '--porcelain'], cleoDir);
  if (!result.success) return false;
  return result.stdout.length > 0;
}

/**
 * Read the ISO 8601 timestamp of the last push or pull recorded in the reflog.
 *
 * @remarks
 * Scans the git reflog for `fetch` or `push` entries and returns the committer
 * date of the most recent one. Returns `null` if no push/pull has occurred or
 * if the repo has no commits yet.
 *
 * @example
 * ```typescript
 * const lastSync = await getLastSyncTimestamp('/path/to/project/.cleo');
 * // '2026-03-21T18:00:00.000Z' or null
 * ```
 */
async function getLastSyncTimestamp(cleoDir: string): Promise<string | null> {
  // The reflog format: `%gd %gs %ci` — reflog selector, subject, committer ISO date
  const result = await cleoGitCommand(['reflog', '--format=%gs %ci', 'HEAD'], cleoDir);
  if (!result.success || !result.stdout) return null;

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    // Match lines describing a fetch or push action (e.g. "fetch origin: fast-forward")
    if (/^(fetch|push|pull)\b/i.test(trimmed)) {
      // The date is everything after the action description — last ISO-like token
      const isoMatch = trimmed.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})$/);
      if (isoMatch?.[1]) {
        return new Date(isoMatch[1]).toISOString();
      }
    }
  }

  return null;
}

/**
 * Get the sharing status: which .cleo/ files are tracked vs ignored,
 * plus git sync state for Nexus multi-project visibility.
 *
 * @remarks
 * Populates `hasGit`, `remotes`, `pendingChanges`, and `lastSync` by inspecting
 * the `.cleo/.git` isolated repo when it exists. All git operations are
 * non-fatal — if the repo is absent or a command fails, the fields carry safe
 * defaults (`false`, `[]`, `null`).
 *
 * @example
 * ```typescript
 * const status = await getSharingStatus('/path/to/project');
 * console.log(status.mode);           // 'project'
 * console.log(status.hasGit);         // true
 * console.log(status.remotes);        // ['origin']
 * console.log(status.pendingChanges); // false
 * console.log(status.lastSync);       // '2026-03-21T18:00:00.000Z'
 * ```
 *
 * @task T4883
 * @task T110
 */
export async function getSharingStatus(cwd?: string): Promise<SharingStatus> {
  const config = await loadConfig(cwd);
  const sharing = config.sharing;
  const cleoDir = getCleoDirAbsolute(cwd);

  const allFiles = collectCleoFiles(cleoDir);
  const tracked: string[] = [];
  const ignored: string[] = [];

  for (const file of allFiles) {
    if (matchesAny(file, sharing.denylist)) {
      ignored.push(file);
    } else if (matchesAny(file, sharing.commitAllowlist)) {
      tracked.push(file);
    } else {
      ignored.push(file);
    }
  }

  // Populate git sync fields
  const hasGit = isCleoGitInitialized(cleoDir);
  let remotes: string[] = [];
  let pendingChanges = false;
  let lastSync: string | null = null;

  if (hasGit) {
    [remotes, pendingChanges, lastSync] = await Promise.all([
      getCleoGitRemotes(cleoDir),
      hasCleoGitPendingChanges(cleoDir),
      getLastSyncTimestamp(cleoDir),
    ]);
  }

  return {
    mode: sharing.mode,
    allowlist: sharing.commitAllowlist,
    denylist: sharing.denylist,
    tracked,
    ignored,
    hasGit,
    remotes,
    pendingChanges,
    lastSync,
  };
}

/**
 * Generate .gitignore entries for the managed section.
 * In 'project' mode: ignore everything except allowlisted files.
 * In 'none' mode: ignore all .cleo/ contents.
 * @task T4883
 */
function generateGitignoreEntries(sharing: SharingConfig): string[] {
  if (sharing.mode === 'none') {
    return ['.cleo/'];
  }

  // In 'project' mode: ignore .cleo/ broadly, then un-ignore allowlisted paths
  const entries: string[] = [];

  // First ignore everything in .cleo/
  entries.push('.cleo/');

  // Then un-ignore allowlisted paths (git negation patterns)
  for (const pattern of sharing.commitAllowlist) {
    // Ensure parent directories are also un-ignored
    const parts = pattern.split('/');
    let accumulated = '.cleo';
    for (let i = 0; i < parts.length - 1; i++) {
      accumulated += '/' + parts[i];
      entries.push(`!${accumulated}/`);
    }
    entries.push(`!.cleo/${pattern}`);
  }

  return entries;
}

/**
 * Sync the project .gitignore to match the sharing config.
 * Adds/updates a managed section between CLEO markers.
 * @task T4883
 */
export async function syncGitignore(
  cwd?: string,
): Promise<{ updated: boolean; entriesCount: number }> {
  const config = await loadConfig(cwd);
  const projectRoot = getProjectRoot(cwd);
  const gitignorePath = join(projectRoot, '.gitignore');

  const entries = generateGitignoreEntries(config.sharing);
  const managedSection = ['', GITIGNORE_START, ...entries, GITIGNORE_END, ''].join('\n');

  let content = '';
  if (existsSync(gitignorePath)) {
    content = await readFile(gitignorePath, 'utf-8');
  }

  // Check if managed section already exists
  const startIdx = content.indexOf(GITIGNORE_START);
  const endIdx = content.indexOf(GITIGNORE_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing managed section
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + GITIGNORE_END.length);
    const newContent = before.trimEnd() + managedSection + after.trimStart();
    if (newContent.trim() === content.trim()) {
      return { updated: false, entriesCount: entries.length };
    }
    await writeFile(gitignorePath, newContent);
  } else {
    // Append managed section
    const newContent = content.trimEnd() + '\n' + managedSection;
    await writeFile(gitignorePath, newContent);
  }

  return { updated: true, entriesCount: entries.length };
}
